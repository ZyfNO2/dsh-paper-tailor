/**
 * The polling controller for the workbench (W6).
 *
 * Spec: docs/mvp/WORKBENCH-RESEARCH-SPEC.md section 7.2, cases WR-16/17/18.
 *
 * Why this is a separate module rather than a `useEffect` in `Workbench.tsx`
 * ----------------------------------------------------------------------------
 * Every rule below is a rule about TIMING and IDENTITY, and timing rules are
 * exactly what a component test with fake timers checks badly and a plain
 * controller checks well. Keeping the discipline here means:
 *
 *  - it is testable without esbuild, jsdom, React or a browser, so the sandbox
 *    that currently blocks every `*-dom` acceptance cannot silently turn these
 *    rules into unverified prose;
 *  - the React component becomes a thin adapter over it, instead of being the
 *    only place the rules live.
 *
 * The rules, each from a concrete failure this prevents
 * -----------------------------------------------------
 *  1. **No overlap.** A new check never starts while one is in flight. Two
 *     concurrent checks can interleave and a slow one can land after a fast
 *     one, overwriting newer data with older.
 *  2. **Cancel on task switch / unmount.** A response for the previous task
 *     must never be applied to the new one.
 *  3. **Sequence guard.** Within one epoch/scope, a response is applied only if
 *     its `viewSequence` is not lower than what is already displayed. Same
 *     sequence with a different token is a CONSISTENCY ERROR, not a refresh.
 *  4. **Token equality, never timestamps.** `generatedAt` is diagnostic only;
 *     including it would make every 3-second poll report a change.
 *  5. **Bounded backoff, then stop.** 3/6/12/24/30s, five failures, then STOP
 *     with a visible state and a manual retry. 403 stops immediately.
 *  6. **Pause when hidden.** `document.hidden` pauses; becoming visible checks
 *     at once.
 *  7. **Never clear user state.** A failed refresh keeps the last good snapshot
 *     and says so; it does not blank the page.
 *
 * The clock is injected. That is what makes the backoff schedule and the
 * five-failure stop assertable in a test without waiting 75 real seconds.
 */

import type { ChangeToken, ChangedRegion } from '../wire.ts';

export const POLL_INTERVAL_MS = 3_000;
/** 3 / 6 / 12 / 24 / 30 seconds, then stop. */
export const BACKOFF_MS = [3_000, 6_000, 12_000, 24_000, 30_000] as const;
export const MAX_CONSECUTIVE_FAILURES = 5;

export type PollPhase =
  | 'idle'
  | 'checking'
  | 'live'
  /** Refresh failed; the last good snapshot is still displayed. */
  | 'stale'
  /** Stopped after the failure budget, or on 403. Manual retry required. */
  | 'stopped';

export interface PollState {
  phase: PollPhase;
  /** The version currently displayed. null before the first successful read. */
  viewVersion: string | null;
  viewEpoch: string | null;
  viewSequence: number;
  consecutiveFailures: number;
  /** Set when stopped, so the UI can explain WHY it is not retrying. */
  stoppedReasonZh: string | null;
  /** Regions the host says moved since the displayed version. */
  pendingRegions: ChangedRegion[];
  lastErrorZh: string | null;
}

export const INITIAL_POLL_STATE: PollState = {
  phase: 'idle',
  viewVersion: null,
  viewEpoch: null,
  viewSequence: -1,
  consecutiveFailures: 0,
  stoppedReasonZh: null,
  pendingRegions: [],
  lastErrorZh: null,
};

/** What the caller supplies so this module never touches the network itself. */
export interface PollDeps {
  /**
   * Ask the host for the change token. Receives the version AND the epoch
   * currently shown; the epoch is what lets the host force a full refresh after
   * a restart, when every sequence number the page holds is meaningless.
   */
  check(sinceViewVersion: string | null, sinceViewEpoch: string | null, signal: AbortSignal): Promise<ChangeToken>;
  /** Apply a refreshed region. Only called when the host reported a change. */
  apply(regions: ChangedRegion[], token: ChangeToken): void;
  /** Is the page visible? Injected so a test controls it. */
  isVisible(): boolean;
  /** Schedule a callback after N ms; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
  /** Cancels the in-flight check. */
  newAbortController(): AbortController;
}

/**
 * Why a response must not be applied.
 *
 * Returned rather than thrown: a late response is an expected event on a page
 * that switches tasks, not an exception.
 */
export type RejectionReason = 'superseded_task' | 'stale_sequence' | 'epoch_changed' | 'inconsistent';

export interface PollOutcome {
  applied: boolean;
  reason: RejectionReason | null;
}

export class WorkbenchPollController {
  private state: PollState = { ...INITIAL_POLL_STATE };
  private timer: (() => void) | null = null;
  private inFlight: AbortController | null = null;
  /** Incremented on every task switch; a response from an older one is dropped. */
  private scopeEpoch = 0;
  private disposed = false;
  private readonly listeners = new Set<(s: PollState) => void>();
  // An explicit field, not a parameter property: this package runs under
  // `--experimental-strip-types`, which erases types without transforming
  // syntax, and parameter properties are exactly the construct it refuses.
  private readonly deps: PollDeps;

  constructor(deps: PollDeps) {
    this.deps = deps;
  }

  getState(): PollState {
    return this.state;
  }

  subscribe(fn: (s: PollState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  private setState(patch: Partial<PollState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  /**
   * Start polling, optionally after an immediate first check.
   *
   * `immediate` is used on mount and on manual retry, per SPEC section 7.2.
   */
  start(options: { immediate?: boolean } = {}): void {
    this.disposed = false;
    this.scopeEpoch += 1;
    if (options.immediate === true) {
      void this.run();
    } else {
      this.schedule(POLL_INTERVAL_MS);
    }
  }

  /**
   * Switch to a different task.
   *
   * The in-flight request is ABORTED and its scope epoch bumped, so its response
   * is dropped even if the abort races the arrival. This is the WR-17 rule.
   */
  switchTask(): void {
    this.cancelInFlight();
    this.scopeEpoch += 1;
    this.setState({ ...INITIAL_POLL_STATE, viewEpoch: this.state.viewEpoch });
    this.schedule(POLL_INTERVAL_MS);
  }

  /** Called when the page becomes visible again. */
  setVisible(): void {
    if (this.disposed) return;
    // Resume AT ONCE rather than after another interval: the interesting change
    // usually happened while the tab was hidden.
    this.cancelTimer();
    void this.run();
  }

  /** Manual retry: re-check immediately and re-arm the budget. */
  retry(): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.setState({ phase: 'idle', consecutiveFailures: 0, stoppedReasonZh: null, lastErrorZh: null });
    void this.run();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.cancelInFlight();
    this.listeners.clear();
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.timer();
      this.timer = null;
    }
  }

  private cancelInFlight(): void {
    if (this.inFlight !== null) {
      this.inFlight.abort();
      this.inFlight = null;
    }
  }

  private schedule(ms: number): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }

  /**
   * One check.
   *
   * The single most important line is the overlap guard: if a request is already
   * in flight, this returns WITHOUT scheduling another one. A poll that starts
   * a second request while the first is pending is how a stale response
   * overwrites fresh data.
   */
  async run(): Promise<PollOutcome> {
    if (this.disposed) return { applied: false, reason: 'superseded_task' };
    if (this.state.phase === 'stopped') return { applied: false, reason: null };
    if (!this.deps.isVisible()) {
      // Paused, not failing: no backoff is charged for a hidden tab.
      this.schedule(POLL_INTERVAL_MS);
      return { applied: false, reason: null };
    }
    if (this.inFlight !== null) {
      // OVERLAP GUARD: do not start, do not reschedule.
      return { applied: false, reason: null };
    }

    const scope = this.scopeEpoch;
    const controller = this.deps.newAbortController();
    this.inFlight = controller;
    this.setState({ phase: 'checking' });

    try {
      const token = await this.deps.check(this.state.viewVersion, this.state.viewEpoch, controller.signal);
      if (this.disposed || scope !== this.scopeEpoch) {
        return { applied: false, reason: 'superseded_task' };
      }
      this.inFlight = null;

      const verdict = this.judge(token);
      if (verdict !== null) {
        // A late/inconsistent response is NOT a failure and must not charge the
        // backoff budget; the next tick will simply re-check.
        this.setState({ phase: 'live' });
        this.schedule(POLL_INTERVAL_MS);
        return { applied: false, reason: verdict };
      }

      const changed = token.viewVersion !== this.state.viewVersion;
      this.setState({
        phase: 'live',
        viewVersion: token.viewVersion,
        viewEpoch: token.viewEpoch,
        viewSequence: token.viewSequence,
        consecutiveFailures: 0,
        stoppedReasonZh: null,
        lastErrorZh: null,
        pendingRegions: changed ? token.changedRegions : [],
      });
      // Only a real change re-reads a region; an unchanged token costs one small
      // JSON read and no re-render.
      if (changed && token.changedRegions.length > 0) {
        this.deps.apply(token.changedRegions, token);
      }
      this.schedule(POLL_INTERVAL_MS);
      return { applied: changed, reason: null };
    } catch (err) {
      this.inFlight = null;
      if (this.disposed || scope !== this.scopeEpoch) return { applied: false, reason: 'superseded_task' };
      return this.handleFailure(err, scope);
    }
  }

  /** Returns a rejection reason when the token must NOT be applied. */
  private judge(token: ChangeToken): RejectionReason | null {
    // An epoch change means the host restarted. The page's sequence numbers are
    // meaningless now, so the new token is accepted and the sequence resets.
    if (this.state.viewEpoch !== null && token.viewEpoch !== this.state.viewEpoch) {
      this.setState({ viewSequence: -1 });
      return null;
    }
    if (token.viewSequence < this.state.viewSequence) return 'stale_sequence';
    if (token.viewSequence === this.state.viewSequence && token.viewVersion !== this.state.viewVersion) {
      // Same sequence, different content: the host is inconsistent. Applying it
      // would make the page flicker between two truths.
      return 'inconsistent';
    }
    return null;
  }

  private handleFailure(err: unknown, scope: number): PollOutcome {
    const status = (err as { status?: number }).status;
    const message = (err as { message?: string }).message ?? String(err);

    // 403 is an AUTHORIZATION problem. Retrying it on a timer would hammer the
    // host and would never succeed without a new grant, so stop immediately.
    if (status === 403) {
      this.setState({
        phase: 'stopped',
        stoppedReasonZh: `读取授权被拒（403）：${message}。需要重新申请授权后才能刷新。`,
        lastErrorZh: message,
      });
      return { applied: false, reason: null };
    }

    const failures = this.state.consecutiveFailures + 1;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      this.setState({
        phase: 'stopped',
        consecutiveFailures: failures,
        stoppedReasonZh: `连续 ${failures} 次刷新失败，已停止自动刷新。当前显示的是上次成功读取的版本。`,
        lastErrorZh: message,
      });
      return { applied: false, reason: null };
    }

    // The last good snapshot is KEPT: viewVersion/viewSequence are untouched,
    // so the next successful check compares against what is actually displayed.
    this.setState({
      phase: this.state.viewVersion === null ? 'idle' : 'stale',
      consecutiveFailures: failures,
      lastErrorZh: message,
    });
    this.schedule(BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]);
    void scope;
    return { applied: false, reason: null };
  }

  /** The message the UI shows above a stale page, or null when healthy. */
  static staleBannerZh(state: PollState): string | null {
    if (state.phase === 'stopped') return state.stoppedReasonZh;
    if (state.phase === 'stale') {
      return `刷新失败（第 ${state.consecutiveFailures} 次），当前显示的是上次成功读取的版本。`;
    }
    return null;
  }
}

/**
 * A deterministic clock for tests.
 *
 * Advancing by hand is what makes "the fifth failure stops the poll" an
 * assertion rather than a 75-second wait.
 */
export class ManualClock {
  private now = 0;
  private readonly pending: Array<{ at: number; fn: () => void }> = [];

  setTimer = (fn: () => void, ms: number): (() => void) => {
    const entry = { at: this.now + ms, fn };
    this.pending.push(entry);
    return () => {
      const i = this.pending.indexOf(entry);
      if (i >= 0) this.pending.splice(i, 1);
    };
  };

  /** Fire every timer due within `ms`, in time order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.pending.filter((t) => t.at <= target).sort((a, b) => a.at - b.at);
      const next = due[0];
      if (next === undefined) break;
      this.pending.splice(this.pending.indexOf(next), 1);
      this.now = next.at;
      next.fn();
    }
    this.now = target;
  }

  get time(): number {
    return this.now;
  }
}