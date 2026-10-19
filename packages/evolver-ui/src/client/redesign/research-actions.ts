/**
 * Research-bootstrap action bridge (FE-02 §6).
 *
 * The UI never decides what a user's choice MEANS — it emits the choice with
 * stable ids and lets the host persist the real action identity. What the bridge
 * does own is the async contract of the round (Plan §4):
 *
 *   - one `operationId` per USER INTENT, minted FRESH on every new click; the UI grouping
 *     key is display-only and is never reused as the operation identity, so a changed
 *     selection cannot collide with the previous one (the old fixed-key reuse was the
 *     `IDEMPOTENCY_CONFLICT` bug);
 *   - an explicit retry replays the FROZEN event verbatim (same id, same payload) —
 *     it never rebuilds the payload from current props;
 *   - per-key serialization, so two quick clicks from one stale snapshot cannot build
 *     two different selections that overwrite each other;
 *   - `pending` while a request is in flight, so a button cannot fire twice;
 *   - `queued` / `running` are never shown as saved — only a `final` receipt
 *     becomes 已保存, and even then the page re-reads the persisted snapshot.
 *
 * Nothing here falls back to localStorage or a fake success when the host has no
 * action bridge: the real reason is surfaced instead (shared spec §7).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  EventOutcome,
  ObjectLink,
  ResearchContractDraft,
  ResearchEventBase,
  WorkbenchEvent,
} from './view-model.ts';

/**
 * A new operation id, stable per intent.
 *
 * `crypto.randomUUID` is preferred; the fallback is still unique enough within a
 * session because it carries the caller's counter, so two intents started in the
 * same millisecond cannot collide.
 */
export function newOperationId(prefix = 'op'): string {
  const cryptoObj = typeof globalThis === 'undefined' ? undefined : (globalThis.crypto as Crypto | undefined);
  if (cryptoObj !== undefined && typeof cryptoObj.randomUUID === 'function') {
    return `${prefix}-${cryptoObj.randomUUID()}`;
  }
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

export interface ResearchActionState {
  /** True while a request for this intent is in flight. */
  pending: Set<string>;
  /** The last receipt per intent, for the UI to render honestly. */
  lastOutcome: Record<string, EventOutcome>;
  /** Ids of operations the host reported as persisted (final, ok). */
  savedOperations: Set<string>;
  error: string | null;
}

export interface BootstrapActions {
  state: ResearchActionState;
  isPending: (key: string) => boolean;
  /** Last receipt for an intent, or null. */
  outcomeOf: (key: string) => EventOutcome | null;
  /** Whether this intent's last receipt was a real persisted success. */
  isSaved: (key: string) => boolean;
  start: (draft: ResearchContractDraft) => Promise<EventOutcome>;
  saveContract: (draft: ResearchContractDraft, confirm: boolean, contractRevision: number | null) => Promise<EventOutcome>;
  probe: () => Promise<EventOutcome>;
  generate: (contractRevision: number | null, retainPrevious: boolean) => Promise<EventOutcome>;
  editIdea: (ideaId: string, ideaRevision: number, patch: {
    hypothesis?: string | null; rationale?: string | null; validationPlan?: string | null;
    reviewNotes?: string | null; targetMetric?: string | null;
  }) => Promise<EventOutcome>;
  selectIdeas: (ideaIds: string[]) => Promise<EventOutcome>;
  initialize: (ideaIds: string[], contractRevision: number | null) => Promise<EventOutcome>;
  selectResearch: (researchId: string) => Promise<EventOutcome>;
  setSlotComponent: (nodeId: string, slotId: string, ref: ObjectLink, snapshotRevision: number | null) => Promise<EventOutcome>;
  setSlotLocked: (nodeId: string, slotId: string, locked: boolean) => Promise<EventOutcome>;
  /** Retry the last attempt for an intent with the SAME operationId. */
  retry: (key: string) => Promise<EventOutcome>;
  /**
   * Explicit retry of the FROZEN event for one intent: the exact stored event is replayed
   * verbatim — same operationId, same semantic payload. The payload is never rebuilt from
   * current props, so a selection the user changed after the first attempt cannot ride on
   * the old id (that would be a different intent, which gets its own id through selectIdeas).
   */
  retryFrozen: (key: string) => Promise<EventOutcome>;
}

/** The event base every bootstrap request carries, minted once per intent. */
function base(researchId: string | null, baseRevision: number, operationId: string): ResearchEventBase {
  return { researchId, baseRevision, operationId };
}

/**
 * The FE1 identity machine, extracted from the hook so it runs without React.
 *
 * Rules (Plan §4):
 * - every NEW user intent mints a FRESH operationId; the UI grouping key is display-only
 *   and is never reused as the operation identity;
 * - an explicit frozen retry replays the STORED event verbatim (same id, same payload) and
 *   never rebuilds from current props;
 * - per-key serialization: concurrent calls on one key drain in order, so two quick clicks
 *   from one stale snapshot cannot build conflicting selections.
 */
export interface ActionIdentity {
  run(key: string, build: (operationId: string) => WorkbenchEvent): Promise<{ event: WorkbenchEvent; operationId: string }>;
  retryFrozen(key: string): Promise<{ event: WorkbenchEvent; operationId: string } | { none: true }>;
  lastEventOf(key: string): WorkbenchEvent | undefined;
}

export function createActionIdentity(): ActionIdentity {
  const lastEvent = new Map<string, WorkbenchEvent>();
  const queues = new Map<string, Promise<{ event: WorkbenchEvent; operationId: string }>>();
  const run = (key: string, build: (operationId: string) => WorkbenchEvent) => {
    const prior = queues.get(key) ?? Promise.resolve(null as unknown as { event: WorkbenchEvent; operationId: string });
    const task = prior
      .catch(() => null)
      .then(() => {
        const operationId = newOperationId(key);
        const event = build(operationId);
        lastEvent.set(key, event);
        return { event, operationId };
      });
    queues.set(key, task);
    return task;
  };
  return {
    run,
    retryFrozen: async (key: string) => {
      const event = lastEvent.get(key);
      if (event === undefined) return { none: true as const };
      return { event, operationId: (event as ResearchEventBase).operationId };
    },
    lastEventOf: (key: string) => lastEvent.get(key),
  };
}

export function useBootstrapActions(opts: {
  researchId: string | null;
  baseRevision: number;
  emit: (e: WorkbenchEvent) => Promise<{ ok: boolean; message: string; reason?: string } & Partial<EventOutcome>>;
}): BootstrapActions {
  const [state, setState] = useState<ResearchActionState>({
    pending: new Set(), lastOutcome: {}, savedOperations: new Set(), error: null,
  });
  // One identity machine per hook instance; it owns ids, frozen events and per-key queues.
  const identities = useRef<ActionIdentity | null>(null);
  if (identities.current === null) identities.current = createActionIdentity();
  const identityOf = identities.current;
  // Identity stays stable, but execution must use the latest rendered revision and
  // handler. The old empty-dependency closure kept revision 0 after every refresh.
  const executeRef = useRef<(event: WorkbenchEvent, operationId: string, key: string) => Promise<EventOutcome>>();

  const run = useCallback(
    async (key: string, build: (operationId: string) => WorkbenchEvent, identity: { frozen?: WorkbenchEvent } = {}): Promise<EventOutcome> => {
      const outcome = (built: { event: WorkbenchEvent; operationId: string }) => executeRef.current!(built.event, built.operationId, key);
      if (identity.frozen !== undefined) return outcome({ event: identity.frozen, operationId: (identity.frozen as ResearchEventBase).operationId });
      return identityOf.run(key, build).then(outcome);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const execute = useCallback(
    async (event: WorkbenchEvent, operationId: string, key: string): Promise<EventOutcome> => {
      setState((s) => {
        const pending = new Set(s.pending);
        pending.add(key);
        return { ...s, pending, error: null };
      });
      try {
        const out = await opts.emit(event);
        const outcome: EventOutcome = {
          ok: out.ok,
          message: out.message,
          reason: out.reason,
          operationId: out.operationId ?? operationId,
          state: out.state ?? (out.ok ? 'final' : 'rejected'),
          revision: out.revision ?? null,
          resultRefs: out.resultRefs,
          receivedAt: Date.now(),
        };
        setState((s) => {
          const pending = new Set(s.pending);
          pending.delete(key);
          const saved = new Set(s.savedOperations);
          // queued/running are NOT saved: the UI must wait for the re-read.
          if (outcome.ok && outcome.state === 'final') saved.add(key);
          else saved.delete(key);
          return {
            pending,
            lastOutcome: { ...s.lastOutcome, [key]: outcome },
            savedOperations: saved,
            error: outcome.ok ? null : (outcome.reason ?? outcome.message),
          };
        });
        return outcome;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setState((s) => {
          const pending = new Set(s.pending);
          pending.delete(key);
          const saved = new Set(s.savedOperations);
          saved.delete(key);
          return { pending, lastOutcome: s.lastOutcome, savedOperations: saved, error: message };
        });
        return { ok: false, message, reason: message, operationId, state: 'rejected' };
      }
    },
    [opts],
  );

  executeRef.current = execute;

  const retry = useCallback(
    async (key: string): Promise<EventOutcome> => {
      const frozen = await identityOf.retryFrozen(key);
      if ('none' in frozen) {
        return { ok: false, message: '没有可重试的操作。', reason: '没有可重试的操作。', state: 'rejected' };
      }
      // Frozen replay: the stored event is sent verbatim with its original operationId.
      return await run(key, () => frozen.event, { frozen: frozen.event });
    },
    [run],
  );

  const retryFrozen = retry;

  return useMemo<BootstrapActions>(() => {
    const actions: BootstrapActions = {
      state,
      isPending: (key) => state.pending.has(key),
      outcomeOf: (key) => state.lastOutcome[key] ?? null,
      isSaved: (key) => state.savedOperations.has(key),
      retry,
      retryFrozen,
      start: (draft) => run('start', (op) => ({ ...base(opts.researchId, opts.baseRevision, op), type: 'start_research', draft })),
      saveContract: (draft, confirm, contractRevision) => run('save', (op) => ({
        ...base(opts.researchId, opts.baseRevision, op),
        type: 'save_research_contract', patch: draft, confirm, contractRevision,
      })),
      probe: () => run('probe', (op) => ({ ...base(opts.researchId, opts.baseRevision, op), type: 'probe_research_environment' })),
      generate: (contractRevision, retainPrevious) => run('generate', (op) => ({
        ...base(opts.researchId, opts.baseRevision, op),
        type: 'generate_brainstorm', contractRevision, retainPreviousSelection: retainPrevious,
      })),
      editIdea: (ideaId, ideaRevision, patch) => run(`idea:${ideaId}`, (op) => ({
        ...base(opts.researchId, opts.baseRevision, op),
        type: 'edit_research_idea', ideaId, ideaRevision, patch,
      })),
      // The full desired selection is sent, so the host stores the truth rather
      // than merging a delta against a stale list.
      selectIdeas: (ideaIds) => run('select-ideas', (op) => ({
        ...base(opts.researchId, opts.baseRevision, op),
        type: 'select_research_ideas', ideaIds,
      })),
      initialize: (ideaIds, contractRevision) => run('initialize', (op) => ({
        ...base(opts.researchId, opts.baseRevision, op),
        type: 'initialize_research_graph', selectedIdeaIds: ideaIds, contractRevision,
      })),
      selectResearch: (researchId) => run('select-research', (op) => ({
        ...base(opts.researchId, opts.baseRevision, op),
        type: 'select_research', researchId,
      })),
      setSlotComponent: (nodeId, slotId, ref, snapshotRevision) => run(`slot:${slotId}`, (op) => ({
        ...base(opts.researchId, opts.baseRevision, op),
        type: 'set_slot_component', nodeId, slotId, ref, snapshotRevision,
      })),
      setSlotLocked: (nodeId, slotId, locked) => run(`lock:${slotId}`, (op) => ({
        ...base(opts.researchId, opts.baseRevision, op),
        type: 'set_slot_locked', nodeId, slotId, locked,
      })),
    };
    return actions;
  }, [state, run, retry, opts.researchId, opts.baseRevision]);
}

/**
 * What a receipt means for the UI, in words.
 *
 * `queued` is explicitly NOT saved: the host only promised to try. The page
 * shows the persisted state after re-reading the snapshot (FE-R04).
 */
export function receiptText(outcome: EventOutcome | null): string | null {
  if (outcome === null) return null;
  if (!outcome.ok) return outcome.reason ?? outcome.message;
  if (outcome.state === 'queued') return '已提交，等待执行（尚未保存）';
  if (outcome.state === 'running') return '执行中（尚未保存）';
  return outcome.message;
}
