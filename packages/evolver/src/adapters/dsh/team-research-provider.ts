import { randomUUID } from 'node:crypto';
import { ExperimentError } from '../../contracts/experiments.ts';
import { canonicalJsonV1 } from '../../domain/research-canonical.ts';
import { TeamModelBudget } from '../../application/team-model-budget.ts';

/** Verified DSH provider seam. This adapter buffers a bounded response so settlement precedes delivery. */
export interface ResearchProviderRequest { provider: string; model: string; sessionId?: string; messages: unknown[]; tools?: unknown[]; system?: string; maxTokens?: number; signal?: AbortSignal; [key: string]: unknown }
export interface ResearchProviderChunk { type: string; usage?: { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }; [key: string]: unknown }
export interface ResearchProviderAdapter {
  providerInfo(provider: string): { id: string; name: string };
  providerRetryPolicy(provider: string): { mode: 'normal'; maxRetries: number; retryableCodes: readonly string[]; initialDelayMs: number; maxDelayMs: number; jitterRatio: number } | undefined;
  imageRequestPricing(provider: string, model: string): unknown;
  listModels(provider: string): Promise<readonly Record<string, unknown>[]>;
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{ model: Record<string, unknown>; stream(options: ResearchProviderRequest): AsyncIterable<ResearchProviderChunk> }>;
  stream(options: ResearchProviderRequest): AsyncIterable<ResearchProviderChunk>;
}
export function installBudgetedResearchProvider(options: {
  caller: unknown; sessionId: string; provider: string; upstreamProvider: string; model: string; upstream: ResearchProviderAdapter;
  budget: TeamModelBudget; authorize(): void; lifecycleSignal: AbortSignal; maxInputTokens: number; maxOutputTokens: number;
  register(providers: string[], adapter: ResearchProviderAdapter): () => void;
}): { provider: string; model: string; dispose(): void } {
  options.authorize();
  if (options.provider === options.upstreamProvider || !Number.isSafeInteger(options.maxInputTokens) || options.maxInputTokens < 1 || !Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1) throw new ExperimentError('CONFIG_INCOMPLETE', 'Budgeted provider needs a distinct route and positive token ceilings');
  let disposed = false, active = false;
  const assertActive = () => { if (disposed || options.lifecycleSignal.aborted) throw new ExperimentError('POLICY_DENIED', 'Budgeted role provider was disposed'); options.authorize(); };
  const stream = async function* (request: ResearchProviderRequest, dispatch: (request: ResearchProviderRequest) => AsyncIterable<ResearchProviderChunk>): AsyncIterable<ResearchProviderChunk> {
    assertActive();
    if (request.sessionId !== options.sessionId || request.provider !== options.provider || request.model !== options.model) throw new ExperimentError('OWNER_MISMATCH', 'Provider request is not from the exact registered role session/route');
    if (active) throw new ExperimentError('HOST_BUSY', 'Role already has an active serial model call');
    const maxTokens = request.maxTokens ?? options.maxOutputTokens;
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > options.maxOutputTokens) throw new ExperimentError('BUDGET_EXHAUSTED', 'Request raises the role output ceiling');
    const { signal: _signal, ...body } = request;
    // Text-only request bytes plus framing overhead form a conservative admission bound.
    const admitted = JSON.parse(JSON.stringify(body));
    if (Buffer.byteLength(canonicalJsonV1(admitted), 'utf8') + 1024 > options.maxInputTokens) throw new ExperimentError('BUDGET_EXHAUSTED', 'Request exceeds the role conservative input envelope');
    if (JSON.stringify(request.messages).includes('"type":"image"')) throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Role image calls require an installed authoritative image token meter');
    const signal = AbortSignal.any([request.signal ?? new AbortController().signal, options.lifecycleSignal]);
    active = true;
    try {
      const result = await options.budget.call(options.caller, { callId: randomUUID(), request: admitted, maxInputTokens: options.maxInputTokens, maxOutputTokens: maxTokens, serial: true }, signal, async () => {
        const chunks: ResearchProviderChunk[] = []; let usage: { inputTokens: number; outputTokens: number } | null = null, bytes = 0;
        for await (const chunk of dispatch({ ...request, provider: options.upstreamProvider, maxTokens, signal })) {
          bytes += Buffer.byteLength(JSON.stringify(chunk)); if (bytes > Math.max(65536, maxTokens * 128)) throw new ExperimentError('BUDGET_EXHAUSTED', 'Provider response exceeds bounded role buffer');
          if (chunk.type === 'usage' && chunk.usage) {
            const u = chunk.usage, inputTokens = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0), outputTokens = u.outputTokens;
            if ([u.inputTokens, u.outputTokens, u.cacheReadTokens ?? 0, u.cacheWriteTokens ?? 0].some((value) => !Number.isSafeInteger(value) || value < 0)) throw new ExperimentError('INVALID_RESULT', 'Provider usage components must be nonnegative integers');
            if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0 || u.totalTokens !== undefined && u.totalTokens !== inputTokens + outputTokens) throw new ExperimentError('INVALID_RESULT', 'Provider usage counters are invalid or inconsistent');
            if (usage) throw new ExperimentError('INVALID_RESULT', 'Provider emitted duplicate usage facts'); usage = { inputTokens, outputTokens };
          }
          chunks.push(chunk);
        }
        return { result: chunks, usage };
      });
      assertActive(); for (const chunk of result) yield chunk;
    } finally { active = false; }
  };
  const adapter: ResearchProviderAdapter = {
    providerInfo: (provider) => ({ id: provider, name: `Research role ${options.sessionId}` }),
    providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }),
    imageRequestPricing: () => undefined,
    listModels: async () => [{ id: options.model, name: options.model }],
    resolveModel: async (_provider, model, signal) => { assertActive(); if (model !== options.model) throw new ExperimentError('POLICY_DENIED', 'Unconfigured role model'); return { ...await options.upstream.resolveModel(options.upstreamProvider, model, signal), provider: options.provider }; },
    prepareCall: async (_provider, model, signal) => {
      assertActive(); if (model !== options.model) throw new ExperimentError('POLICY_DENIED', 'Unconfigured role model');
      const captured = await options.upstream.prepareCall(options.upstreamProvider, model, signal);
      return { model: { ...captured.model, provider: options.provider }, stream: (request) => stream(request, (mapped) => captured.stream(mapped)) };
    },
    stream: (request) => stream(request, (mapped) => options.upstream.stream(mapped)),
  };
  const release = options.register([options.provider], adapter);
  return { provider: options.provider, model: options.model, dispose: () => { if (!disposed) { disposed = true; release(); } } };
}
