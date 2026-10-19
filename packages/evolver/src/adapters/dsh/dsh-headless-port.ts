/**
 * Live DSH model port: one DSH turn per call through the headless profile, with the
 * `--patch` overlay pinning the route and disabling tools. It shells out to the DSH
 * launcher only; it never talks to an upstream API directly and never changes the
 * connector, the profile, or the user's settings.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { ResearchError, type ArtifactRef } from '../../contracts/research.ts';
import { sha256Hex } from '../../domain/research-canonical.ts';
import type { ModelInvokeRequest, ModelInvokeResult, ResearchModelPort } from '../../domain/paper-discovery.ts';

export interface DshHeadlessPortOptions {
  /** Absolute path to the DSH launcher bin.js inside the installed app. */
  binPath: string;
  nodePath?: string;
  profile?: string;
  patchFile: string;
  dshHome?: string;
  /** Rough chars-per-token estimate used only to refuse an over-budget input before sending. */
  charsPerToken?: number;
}

const CREDENTIAL_CODES = ['MISSING_CREDENTIAL', 'NO_ADAPTER', 'UNAUTHORIZED', 'NOT_FOUND'];

/**
 * Out-of-quota signals. These are infrastructure conditions, not model behaviour:
 * a route with no credit left can answer nothing, so its result carries no
 * information about extraction or synthesis quality and must be reported as
 * `blocked` rather than counted as a failure.
 */
const QUOTA_CODES = ['QUOTA', 'Insufficient Balance', 'RATE_LIMIT', 'rate_limit', '429'];

/** Routed through DSH, so a missing key surfaces as an unavailable route rather than a fake answer. */
export class DshHeadlessModelPort implements ResearchModelPort {
  readonly kind = 'live' as const;
  readonly route: string;
  private readonly opts: Required<Pick<DshHeadlessPortOptions, 'nodePath' | 'profile' | 'charsPerToken'>> & DshHeadlessPortOptions;
  /** Raw outputs of the calls actually made, for the attempt ledger. */
  readonly calls: Array<{ requestHash: string; chars: number; ms: number }> = [];

  constructor(opts: DshHeadlessPortOptions) {
    this.opts = {
      ...opts,
      nodePath: opts.nodePath ?? process.execPath,
      profile: opts.profile ?? 'headless',
      charsPerToken: opts.charsPerToken ?? 4,
    };
    this.route = 'deepseek-official/deepseek-flash (via dsh --profile headless)';
  }

  static fromEnv(): DshHeadlessModelPort | undefined {
    const bin = process.env.DSH_BIN;
    const patch = process.env.DSH_PATCH;
    if (!bin || !patch) return undefined;
    return new DshHeadlessModelPort({
      binPath: path.resolve(bin),
      patchFile: path.resolve(patch),
      profile: process.env.DSH_PROFILE,
      dshHome: process.env.DSH_HOME_OVERRIDE,
    });
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
    // The launcher re-parses forwarded arguments, so a task whose first line is the Skill's
    // `---` front matter reaches commander as an option ("unknown option '---'"). A non-dash
    // sentinel prefix keeps the argv positional; `--` alone was not enough.
    const task = `PAPER_ONLY_TASK_V1\n${prompt}`;

    // Strip the host process's profile selection before spawning.
    //
    // A DSH desktop session exports DSH_PROFILE / DSH_PROFILE_DIR / DSH_HOME describing ITS
    // OWN profile. Forwarding them with `...process.env` made the child ignore the
    // `--profile headless` argument, try to load the desktop profile, and fail with
    //     error: profile "desktop" is managed exclusively by the Electron application
    // A live run therefore passed or failed depending on whether it was launched from a plain
    // terminal or from inside a desktop session, which is not an acceptable property for a
    // measurement. The child gets exactly the profile this port asked for, and DSH_HOME is
    // then set from dshHome when the caller supplied one.
    const inherited = { ...process.env } as Record<string, string | undefined>;
    delete inherited.DSH_PROFILE;
    delete inherited.DSH_PROFILE_DIR;
    delete inherited.DSH_HOME;
    if (this.opts.dshHome) inherited.DSH_HOME = this.opts.dshHome;

    const run = spawnSync(this.opts.nodePath, [this.opts.binPath, '--profile', this.opts.profile, '--patch', this.opts.patchFile, '--', task], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: Math.max(1000, request.timeoutMs),
      env: {
        ...inherited,
        ELECTRON_RUN_AS_NODE: '1',
      },
      windowsHide: true,
    });
    const ms = Date.now() - started;

    const stderr = String(run.stderr ?? '');
    if (run.error) {
      if ((run.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || run.signal === 'SIGTERM') {
        throw new ResearchError('MODEL_TIMEOUT', `DSH call exceeded ${request.timeoutMs}ms`, { retryable: true });
      }
      throw new ResearchError('MODEL_UNAVAILABLE', `cannot launch the DSH CLI: ${run.error.message}`, { retryable: false });
    }
    if (run.status !== 0) {
      const code = CREDENTIAL_CODES.find((c) => stderr.includes(c));
      if (code) {
        throw new ResearchError('MODEL_UNAVAILABLE', `DSH route is not usable (${code}): ${firstLine(stderr)}`, { retryable: false });
      }
      // A rate-limited or out-of-credit route measured nothing about the model. It is an
      // infrastructure condition, so it must not be recorded as a model failure:
      // the eval runner maps BUDGET_EXHAUSTED to `blocked` (scripts/eval-phase1-diagnostic.ts:151),
      // and only a genuine response problem belongs in the `fail` denominator.
      // Not retryable: a free route that is out of quota will still be out of quota on retry.
      if (QUOTA_CODES.some((c) => stderr.includes(c))) {
        throw new ResearchError('BUDGET_EXHAUSTED', `DSH route has no usable quota (${firstLine(stderr)})`, { retryable: false });
      }
      throw new ResearchError('MODEL_RESPONSE_ERROR', `DSH exited ${String(run.status)}: ${firstLine(stderr) || firstLine(String(run.stdout))}`, {
        retryable: false,
      });
    }

    const text = String(run.stdout ?? '').trim();
    if (text.length === 0) {
      throw new ResearchError('MODEL_RESPONSE_ERROR', 'DSH returned an empty assistant message', { retryable: false });
    }
    this.calls.push({ requestHash: request.requestHash, chars: text.length, ms });
    const rawRef: ArtifactRef = { id: `dsh-live-${sha256Hex(text).slice(0, 12)}`, sha256: sha256Hex(text) };
    // DSH does not report per-call token usage on this channel; null is recorded rather than 0.
    return { text, route: this.route, inputTokens: null, outputTokens: null, rawResponseRef: rawRef };
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim().length > 0)?.slice(0, 220) ?? '';
}
