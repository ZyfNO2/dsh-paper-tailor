/**
 * OpenAI-compatible local model port.
 *
 * Why this exists
 * ---------------
 * A DSH route provided by a desktop-only connector is reachable from the
 * Electron-owned `desktop` profile but not from the headless profile the eval
 * scripts drive. A local OpenAI-compatible endpoint exposes the model on
 * `127.0.0.1` instead, so the paper-only chain can run over HTTP without forking
 * a second DSH process and without touching any profile, connector or user
 * setting.
 *
 * The endpoint, model name and key env var are caller configuration. This module
 * names no provider: which route an operator designates is a local decision, and
 * a published release must not imply that one particular connector is required.
 *
 * Guarantees
 * ----------
 * - It talks only to the loopback endpoint given by the caller. It never
 *   contacts an upstream API, never reads a credential store, and never edits a
 *   profile or the user's settings.
 * - An unreachable endpoint, a refused key, a rate limit or an out-of-quota
 *   response stay *unavailable*: they become MODEL_UNAVAILABLE or
 *   BUDGET_EXHAUSTED, never a fabricated or empty-but-successful answer.
 * - It refuses an over-budget input before sending, exactly like the headless
 *   port, so the per-sample call/char ceilings are not bypassed by transport.
 * - The raw response is hashed and returned as a ref, so the attempt ledger can
 *   bind every result to the bytes that produced it.
 *
 * Note on provenance
 * ------------------
 * This port is still a *local* model transport: like every port in this repo it
 * proves what bytes came back, not that a particular model produced them. The
 * verifier's provenance BLOCKER is unchanged by adding this port.
 */

import { ResearchError, type ArtifactRef } from '../../contracts/research.ts';
import { sha256Hex } from '../../domain/research-canonical.ts';
import type { ModelInvokeRequest, ModelInvokeResult, ResearchModelPort } from '../../domain/paper-discovery.ts';

export interface OpenAiCompatPortOptions {
  /** e.g. http://127.0.0.1:18899/v1 */
  baseUrl: string;
  model: string;
  /** Bearer token for the endpoint. Supplied by the caller; never persisted here. */
  apiKey?: string;
  /**
   * Reasoning-effort rung forwarded as `reasoning_effort`.
   *
   * SCOPE: this is an `openai_compat` (direct-endpoint) option. It has NO effect on the host
   * `llm` path, which sends the host's own route parameters and is the transport a real model
   * turn is supposed to use (see RESEARCH-EXECUTION-ARCHITECTURE and the transport discipline
   * note in docs/mvp/RPD.md dated 2026-10-04).
   *
   * Measured against the loopback endpoint on 2026-10-05: that endpoint models effort by rewriting
   * `max_tokens`, and its default rung caps output at 8192, so a P5-sized extraction is cut with
   * `finish_reason=length` and (with reasoning enabled) can end at 0 content characters. That
   * observation is specific to that endpoint and must NOT be generalised to the host route: the
   * model the host pins (`deepseek-v4.1-flash`) is absent from that endpoint's model list
   * altogether, and P5/P6 have previously succeeded through the host with >14k output tokens, so
   * the 8192 ceiling was never observed on the DSH path.
   *
   * Unset sends no field at all, which preserves the exact request body every other caller had.
   */
  reasoningEffort?: string;
  /** Rough chars-per-token estimate, used only to refuse an over-budget input. */
  charsPerToken?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * When set, every call is appended to an evidence ledger with its request
   * parameters, raw response body, reported usage, finish reason and hashes.
   * A route that answered is not thereby usable, so each record marks
   * `usableAsExtraction: false` and leaves that judgement to P5.
   */
  evidenceRoot?: string;
  /** Evaluation version label recorded with each attempt. */
  evaluationVersion?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
  error?: { message?: string; code?: string; type?: string };
}

const QUOTA_MARKERS = ['insufficient', 'quota', 'rate limit', 'rate_limit', '429', 'no credit', 'exceeded'];

/**
 * Does this body report a quota/credit refusal, as opposed to merely *mentioning*
 * one of the marker words?
 *
 * Scanning the whole body made a valid answer indistinguishable from a refusal.
 * P6's own `candidateDecision` vocabulary contains `insufficient_evidence`, so a
 * correct turn that explains a decision can legitimately contain that substring;
 * it can equally contain "quota" or "exceeded" when discussing resource limits.
 * Any such answer was discarded as BUDGET_EXHAUSTED, so a good response was
 * recorded as an infrastructure failure and the run stopped.
 *
 * This one is transport-independent. The scan lived in this port, so it applied on
 * the host `llm` path as well, and a correct P6 turn could have been lost there
 * too. It is a real latent defect, and distinct from the endpoint-specific 8192
 * ceiling documented on `reasoningEffort` above.
 *
 * A refusal lives in HTTP 429 or the `error` field of an OpenAI-compatible error
 * envelope, so only those are inspected. A 2xx body that carries no `error` is an
 * answer regardless of which words appear in it. A body that is not JSON at all
 * cannot be an answer, so the marker scan still applies there: a proxy returning
 * an HTML rate-limit page must not read as a model failure.
 */
function reportsQuotaRefusal(rawBody: string, status: number): boolean {
  if (status === 429) return true;
  let envelope: { error?: unknown } | undefined;
  try {
    envelope = JSON.parse(rawBody) as { error?: unknown };
  } catch {
    // A non-JSON body cannot be an answer, so the marker scan still applies: a
    // proxy returning an HTML rate-limit page must not read as a model failure.
    return QUOTA_MARKERS.some((m) => rawBody.toLowerCase().includes(m));
  }
  const error = envelope?.error;
  if (error === undefined || error === null) return false;
  const text = typeof error === 'string' ? error : JSON.stringify(error);
  return QUOTA_MARKERS.some((m) => text.toLowerCase().includes(m));
}

/** Parsed only after a JSON body exists; safe to call with the fallback object. */
function parsedChoices(v: ChatCompletionResponse): { finishReason: string | null } {
  return { finishReason: v?.choices?.[0]?.finish_reason ?? null };
}
function parsedUsage(v: ChatCompletionResponse): Record<string, unknown> | null {
  if (!v?.usage) return null;
  return v.usage as unknown as Record<string, unknown>;
}

/**
 * Evidence capture is a repo-level concern, so it is resolved on first use rather
 * than at module load. A top-level dynamic import is not used because it would
 * make loading this adapter depend on a repo script being present; a capture
 * failure is swallowed, since evidence must never be able to change a verdict.
 *
 * The signature is described structurally rather than with `typeof import(...)`:
 * a relative specifier in a type position resolves against this file's location,
 * which is not the repo root once the package is installed into a profile.
 *
 * Shape: (evidenceRoot, request, result) -> void, matching
 * `captureLiveRouteEvidence` in scripts/live-route-evidence.ts.
 */
type CaptureFn = (
  root: string,
  request: {
    id: string;
    model: string;
    evaluationVersion: string;
    caseId?: string;
    provider?: string;
    baseUrl?: string;
    messages: Array<{ role: string; content: string }>;
    maxOutputTokens?: number;
    requestParameters: Record<string, unknown>;
  },
  result: {
    httpStatus: number;
    finishReason: string | null;
    content: string;
    contentChars: number;
    usage: Record<string, unknown> | null;
    elapsedMs: number;
    error?: string;
  },
) => void;
let captureFn: CaptureFn | null | undefined;
function loadCapture(): CaptureFn | null {
  if (captureFn !== undefined) return captureFn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    captureFn = (globalThis as { __evolverCapture?: CaptureFn }).__evolverCapture ?? null;
  } catch {
    captureFn = null;
  }
  return captureFn;
}

/** Registers the capture function. Called by the runner; keeps the adapter importable standalone. */
export function registerEvidenceCapture(fn: CaptureFn | null): void {
  captureFn = fn;
}

/** One HTTP request per call, mirroring the one-turn-per-call budget of the other live ports. */
export class OpenAiCompatModelPort implements ResearchModelPort {
  readonly kind = 'live' as const;
  readonly route: string;
  private readonly opts: Required<Pick<OpenAiCompatPortOptions, 'charsPerToken' | 'fetchImpl'>> & OpenAiCompatPortOptions;
  /** Raw outputs of the calls actually made, for the attempt ledger. */
  readonly calls: Array<{ requestHash: string; chars: number; ms: number }> = [];

  constructor(opts: OpenAiCompatPortOptions) {
    this.opts = { ...opts, charsPerToken: opts.charsPerToken ?? 4, fetchImpl: opts.fetchImpl ?? fetch };
    this.route = `${opts.model} (via ${opts.baseUrl})`;
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
    const timer = setTimeout(() => controller.abort(), Math.max(1000, request.timeoutMs));
    let response: Response;
    try {
      response = await this.opts.fetchImpl(`${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.opts.model,
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt },
          ],
          max_tokens: request.maxOutputTokens > 0 ? request.maxOutputTokens : undefined,
          // Omitted entirely when unset: an endpoint that does not know this field
          // must keep receiving exactly the body it received before.
          ...(this.opts.reasoningEffort ? { reasoning_effort: this.opts.reasoningEffort } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as { name?: string }).name === 'AbortError';
      if (aborted) throw new ResearchError('MODEL_TIMEOUT', `model call exceeded ${request.timeoutMs}ms`, { retryable: true });
      throw new ResearchError('MODEL_UNAVAILABLE', `cannot reach ${this.opts.baseUrl}: ${(err as Error).message}`, {
        retryable: false,
      });
    } finally {
      clearTimeout(timer);
    }

    const rawBody = await response.text();
    const ms = Date.now() - started;
    const record = (content: string, error: string | null) => {
      const capture = loadCapture();
      if (!this.opts.evidenceRoot || !capture) return;
      try {
        capture(
          this.opts.evidenceRoot,
          {
            id: request.requestHash,
            model: this.opts.model,
            evaluationVersion: this.opts.evaluationVersion ?? 'unversioned',
            provider: 'openai_compat',
            baseUrl: this.opts.baseUrl,
            messages: [
              { role: 'system', content: request.systemPrompt },
              { role: 'user', content: request.userPrompt },
            ],
            maxOutputTokens: request.maxOutputTokens,
            requestParameters: { max_tokens: request.maxOutputTokens, timeoutMs: request.timeoutMs },
          },
          {
            httpStatus: response.status,
            finishReason: parsedChoices(parsed).finishReason,
            content,
            contentChars: content.length,
            usage: parsedUsage(parsed),
            elapsedMs: ms,
            ...(error !== null ? { error } : {}),
          },
        );
      } catch {
        // Evidence capture must never be able to change a run's verdict.
      }
    };

    if (reportsQuotaRefusal(rawBody, response.status)) {
      record('', 'quota');
      throw new ResearchError('BUDGET_EXHAUSTED', `endpoint reports no usable quota: ${rawBody.slice(0, 200)}`, {
        retryable: false,
      });
    }
    if (!response.ok) {
      record('', 'http_error');
      throw new ResearchError('MODEL_UNAVAILABLE', `endpoint returned HTTP ${response.status}: ${rawBody.slice(0, 200)}`, {
        retryable: false,
      });
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(rawBody) as ChatCompletionResponse;
    } catch {
      record('', 'non_json');
      throw new ResearchError('MODEL_RESPONSE_ERROR', `endpoint returned non-JSON: ${rawBody.slice(0, 200)}`, { retryable: false });
    }
    const text = parsed.choices?.[0]?.message?.content ?? '';
    if (text.trim().length === 0) {
      record('', 'empty_assistant_message');
      throw new ResearchError('MODEL_RESPONSE_ERROR', 'endpoint returned an empty assistant message', { retryable: false });
    }

    record(text, null);
    this.calls.push({ requestHash: request.requestHash, chars: text.length, ms });
    const rawResponseRef: ArtifactRef = { id: `openai-compat-${sha256Hex(text).slice(0, 12)}`, sha256: sha256Hex(text) };
    return {
      text,
      route: this.route,
      inputTokens: parsed.usage?.prompt_tokens ?? null,
      outputTokens: parsed.usage?.completion_tokens ?? null,
      rawResponseRef,
    };
  }
}
