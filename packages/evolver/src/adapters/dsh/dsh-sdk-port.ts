/**
 * DSH SDK model port: call the model through the host's own `llm` service.
 *
 * Why this exists
 * ---------------
 * DshHeadlessModelPort shells out to a second DSH launcher on `--profile headless`.
 * That profile has no connector for the routes this project actually uses, so a
 * live run failed with:
 *
 *     NO_ADAPTER: no adapter registered for provider "<the configured route>"
 *
 * The connector does exist, but only under the `desktop` profile, and that
 * profile refuses CLI access:
 *
 *     error: profile "desktop" is managed exclusively by the Electron application
 *
 * Neither installing a connector into another DSH profile nor copying files
 * between profiles is this project's business. We build a DSH plugin, so the call
 * a plugin is supposed to make is the in-process one: inject the host's `llm`
 * service from the Cordis context. The host already has the user's route
 * configured and credentialed; forking a second process to re-derive it only
 * loses the connector and the credentials.
 *
 * Guarantees
 * ----------
 * It never calls an upstream API directly, never reads a credential, and never
 * edits a profile or the user's settings. An unavailable route stays an
 * unavailable route: NO_ADAPTER / MISSING_CREDENTIAL / UNAUTHORIZED / NOT_FOUND
 * become MODEL_UNAVAILABLE, and no path returns a fabricated answer.
 *
 * Tool isolation
 * --------------
 * The headless port disabled filesystem/shell/code tools via its `--patch`
 * overlay. There is no equivalent here and none is needed: this port does not run
 * an agent loop. It issues one LLM request with the frozen prompt and reads the
 * streamed text. No tool registry is consulted, so tools enabled in the host
 * session are unreachable from this code path by construction.
 *
 * Chunk handling follows dsh-llm's documented stream contract
 * ---------------------------------------------------------
 * A terminal failure arrives as a `finish` record whose `reason.failure` carries
 * the code; it is NOT delivered as a thrown error or a chunk-level `error`
 * field. An earlier draft of this file assumed the latter and would have turned a
 * quota or credential failure into an empty response. `assistantStreamText`
 * below handles the finish record explicitly.
 */

import { ResearchError } from '../../contracts/research.ts';
import { sha256Hex } from '../../domain/research-canonical.ts';
import type { ModelInvokeRequest, ModelInvokeResult, ResearchModelPort } from '../../domain/paper-discovery.ts';

/**
 * The subset of dsh-llm's runtime this port depends on.
 *
 * Mirrors the host `llm` service contract exactly as reported by the host
 * Inspect provider (`Service.listService` -> `llm`). Three field names were
 * wrong before, and each one cost a real call:
 *
 * - `system` is a TOP-LEVEL field, not a `role: 'system'` message. A
 *   `SystemMessage` additionally requires `source: { kind: 'system-prompt' }`,
 *   so a hand-built system message is an invalid request message.
 * - `messages[].content` is a ContentBlock ARRAY, never a plain string. This is
 *   the one that kept failing. A content-block OBJECT `{ type: 'text', text }`
 *   raised `content is not iterable` (the host iterates it), and "fixing" that
 *   to a bare string raised `content.some is not a function`, because
 *   `contentHasImage` in dsh-llm/content.js runs `content.some(block => ...)`
 *   unconditionally. `RequestUserInput.content` is `UserMessage['content']`,
 *   i.e. `readonly ContentBlock[]`. The correct value is
 *   `[{ type: 'text', text }]` - exactly what the host's own
 *   `createSystemMessage` builds.
 * - the output-token ceiling is `maxTokens`, not `maxOutputTokens`. The unknown
 *   key was silently ignored, so no per-call output cap was ever applied.
 *
 * `reasoning-delta` is accepted and discarded on purpose: extraction reads the
 * answer text, and reasoning trace is not part of the extracted value.
 */
export interface HostLlmService {
  stream(options: {
    provider: string;
    model: string;
    reasoningEffort?: string;
    /** System prompt as a top-level string field. */
    system?: string;
    messages: Array<{ role: string; content: ContentBlock[] }>;
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncIterable<StreamRecord> | Promise<AsyncIterable<StreamRecord>>;
}

/** One `ContentBlock`. This port only ever produces the text variant. */
export interface ContentBlock {
  type: 'text';
  text: string;
}

/**
 * One `StreamChunk` from dsh-llm. The real union is flat: `text-delta` arrives
 * as `{ type: 'text-delta', index, text }`, NOT as a `chunk.text-delta`
 * sub-object. `reasoning-delta` has the same shape.
 */
export interface StreamRecord {
  type?: string;
  index?: number;
  /** text-delta / reasoning-delta / block-end payload. */
  text?: string;
  block?: { type?: string; text?: string };
  /** usage, when the provider reported it. */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number };
  /** Terminal record. */
  reason?: {
    kind?: string;
    failure?: { code?: string; message?: string } | null;
  };
}

export interface DshSdkPortOptions {
  provider: string;
  model: string;
  reasoningEffort?: string;
  llm: HostLlmService;
  charsPerToken?: number;
  label?: string;
}

const UNAVAILABLE_CODES = ['NO_ADAPTER', 'MISSING_CREDENTIAL', 'UNAUTHORIZED', 'NOT_FOUND', 'INVALID_CREDENTIAL'];

/** Map a dsh-llm failure code onto the research error vocabulary. */
function mapFailure(code: string | undefined, message: string | undefined): ResearchError {
  if (code && UNAVAILABLE_CODES.includes(code)) {
    return new ResearchError('MODEL_UNAVAILABLE', `route unavailable: ${code}${message ? `: ${message}` : ''}`);
  }
  if (code === 'ABORTED') {
    return new ResearchError('MODEL_TIMEOUT', 'model call aborted', { retryable: true });
  }
  if (code === 'QUOTA_EXCEEDED' || code === 'RATE_LIMIT') {
    return new ResearchError('BUDGET_EXHAUSTED', `provider quota exhausted${message ? `: ${message}` : ''}`);
  }
  if (code === 'CONTEXT_WINDOW_EXCEEDED') {
    return new ResearchError('BUDGET_EXHAUSTED', 'context window exceeded', {
      fieldPaths: ['budget.maxInputTokensPerCall'],
    });
  }
  // The final fallback keeps the original message rather than reporting a bare
  // `UNKNOWN`. An earlier draft collapsed every unmapped error to that code, so a
  // request-shape bug raised by the host (`content is not iterable`) was
  // indistinguishable from a provider-side failure - it read as a model problem
  // and cost a full diagnostic run to localize. The `code` is still surfaced so
  // a genuine provider code is not lost.
  return new ResearchError(
    'MODEL_RESPONSE_ERROR',
    `model call failed: ${code ?? 'no failure code reported'}${message ? `: ${message}` : ''}`,
  );
}

/**
 * Read the visible text out of one dsh-llm stream.
 *
 * Chunk shapes follow the host `StreamChunk` union, which is flat:
 * `text-delta` is `{ type: 'text-delta', index, text }`. The previous draft
 * matched `record.type === 'text-chunks'` and `record.chunk?.type ===
 * 'text-delta'`, neither of which the host ever emits, so a completely
 * successful call would have been reported as an empty answer.
 *
 * `reasoning-delta` is deliberately ignored: it carries the same `text` field,
 * and treating it as answer text would splice model reasoning into the
 * extracted value.
 *
 * Throws on a terminal failure record; a stream that ends without a failure and
 * without text is reported by the caller as MODEL_RESPONSE_ERROR rather than an
 * empty answer.
 */
export async function assistantStreamText(stream: AsyncIterable<StreamRecord>, observe?: (record: StreamRecord) => void): Promise<string> {
  const blocks = new Map<number, { deltas: string[]; buffered?: string }>();
  // Buffered fallback text, collected but held back. The host emits a final
  // `block-end` for every completed text block, including blocks already
  // delivered as `text-delta`, so appending block text unconditionally
  // duplicates the entire answer whenever a provider streams deltas. The
  // fallback is used only when the stream carried no delta at all.
  // ONE pass: an AsyncIterable is normally single-use, so a second
  // `for await` over the same generator would silently yield nothing.
  for await (const record of stream) {
    observe?.(record);
    const failure = record.reason?.failure;
    if (failure) {
      throw mapFailure(failure.code, failure.message);
    }
    if (record.reason && record.reason.kind === 'aborted') {
      throw new ResearchError('MODEL_TIMEOUT', 'model call aborted', { retryable: true });
    }
    if (record.type === 'text-delta' && typeof record.text === 'string') {
      const index = record.index ?? 0;
      const block = blocks.get(index) ?? { deltas: [] };
      block.deltas.push(record.text);
      blocks.set(index, block);
    } else if (record.type === 'block-end' && record.block?.type === 'text' && typeof record.block.text === 'string') {
      const index = record.index ?? 0;
      const block = blocks.get(index) ?? { deltas: [] };
      block.buffered = record.block.text;
      blocks.set(index, block);
    }
  }
  return [...blocks.entries()].sort(([a], [b]) => a - b)
    .map(([, block]) => block.deltas.length ? block.deltas.join('') : block.buffered ?? '').join('');
}

/**
 * Routes one research request through the host's LLM service.
 *
 * The route string comes from the options. DshHeadlessModelPort reported a fixed
 * 'deepseek-official/deepseek-flash' regardless of the route its patch actually
 * selected, so every live artifact named a route that might not have served the
 * call. Here the reported route is the one that ran.
 */
export class DshSdkModelPort implements ResearchModelPort {
  readonly kind = 'live' as const;
  readonly route: string;
  private readonly opts: DshSdkPortOptions & { charsPerToken: number };
  /** One entry per real call, for the attempt ledger. */
  readonly calls: Array<{ requestHash: string; chars: number; ms: number; route: string; ok: boolean;
    finishReason?: string; usage?: StreamRecord['usage']; responseChars?: number; responseHash?: string;
  }> = [];

  constructor(opts: DshSdkPortOptions) {
    this.opts = { ...opts, charsPerToken: opts.charsPerToken ?? 4 };
    this.route = `${opts.provider}/${opts.model}${opts.label ? ` (${opts.label})` : ''}`;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / this.opts.charsPerToken);
  }

  async invoke(request: ModelInvokeRequest): Promise<ModelInvokeResult> {
    const prompt = `${request.systemPrompt}\n\n${request.userPrompt}`;
    const estimated = this.estimateTokens(prompt);
    if (request.maxInputTokens > 0 && estimated > request.maxInputTokens) {
      throw new ResearchError('BUDGET_EXHAUSTED', `input estimate ${estimated} tokens exceeds the per-call ceiling`, {
        fieldPaths: ['budget.maxInputTokensPerCall'],
      });
    }

    const started = Date.now();
    const controller = new AbortController();
    // Reserve cancellation/descriptor overhead inside the frozen wall-clock cap.
    const cancellationReserve = Math.min(1000, Math.ceil(request.timeoutMs * 0.01));
    const timer = setTimeout(() => controller.abort(), Math.max(1, request.timeoutMs - cancellationReserve));

    let text: string;
    let usage: StreamRecord['usage'];
    let finishReason: string | undefined;
    try {
      const stream = await this.opts.llm.stream({
        provider: this.opts.provider,
        model: this.opts.model,
        ...(this.opts.reasoningEffort ? { reasoningEffort: this.opts.reasoningEffort } : {}),
        // Top-level `system` string, per GenerateOptions. Not a message.
        system: request.systemPrompt,
        messages: [{ role: 'user', content: [{ type: 'text', text: request.userPrompt }] }],
        maxTokens: request.maxOutputTokens > 0 ? request.maxOutputTokens : undefined,
        signal: controller.signal,
      });
      text = await assistantStreamText(stream, record => {
        if (record.type === 'usage') usage = record.usage;
        if (record.type === 'finish') finishReason = record.reason?.kind;
      });
    } catch (err) {
      // A call that was issued and then failed is still a call that was spent.
      // Recording it here is what makes the call ledger able to bound the number
      // of model calls; recording only successful returns would let repeated
      // failures escape the per-sample ceiling entirely.
      this.calls.push({ requestHash: request.requestHash, chars: prompt.length, ms: Date.now() - started, route: this.route, ok: false, usage, finishReason });
      if (err instanceof ResearchError) throw err;
      const raw = String((err as Error)?.message ?? err);
      if ((err as Error)?.name === 'AbortError' || raw.includes('ABORTED')) {
        throw new ResearchError('MODEL_TIMEOUT', `model call exceeded ${request.timeoutMs}ms`, { retryable: true });
      }
      throw mapFailure(
        UNAVAILABLE_CODES.find((c) => raw.includes(c)),
        raw,
      );
    } finally {
      clearTimeout(timer);
    }

    const ms = Date.now() - started;
    if (text.trim().length === 0) {
      this.calls.push({ requestHash: request.requestHash, chars: prompt.length, ms, route: this.route, ok: false, usage, finishReason, responseChars: 0 });
      throw new ResearchError('MODEL_RESPONSE_ERROR', 'model returned no text content');
    }

    this.calls.push({ requestHash: request.requestHash, chars: prompt.length, ms, route: this.route, ok: true,
      usage, finishReason, responseChars: text.length, responseHash: sha256Hex(text) });

    return {
      text,
      route: this.route,
      // Unknown provider usage stays unknown; character estimates are not usage.
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      rawResponseRef: { id: `dsh-sdk:${request.requestHash.slice(0, 16)}`, sha256: sha256Hex(text) },
    };
  }
}
