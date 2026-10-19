/**
 * Browser fetch layer for the evolver workbench route (/evolver/api).
 *
 * Same-origin fetch through DSH's own webserver carrier; no extra port, no
 * second auth scheme, no model credentials in the browser.
 *
 * R10 fixes live here as much as in the components:
 *  - every request is ABORTABLE, and a superseded request is cancelled, so a
 *    late response cannot overwrite a newer one;
 *  - the bearer capability is sent in an `Authorization` header, never as a
 *    query parameter (query params leak into logs/history/referrers and the
 *    browser replays them to same-site callers);
 *  - artifact reads are (taskId, ref) — there is deliberately no `path` helper,
 *    so the UI cannot regress to the v1 arbitrary-path interface.
 */

import type {
  ArtifactView,
  ChangeToken,
  ModelDataFlow,
  ModuleCard,
  PaperCard,
  PaperCardV3,
  QualifiedTask,
  TaskSummary,
  WorkbenchSnapshot,
  WorkbenchSnapshotV3,
  WorkbenchStatus,
  WorkbenchStatusV3,
} from '../wire.ts';

export class WorkbenchApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'WorkbenchApiError';
  }

  /** A refusal the UI must show as a state, not retry silently. */
  get isScope(): boolean {
    return this.status === 403 && (this.code === 'SCOPE_DENIED' || this.code === 'SCOPE_INVALID');
  }
}

let capability: string | null = null;

/**
 * The read capability, obtained from `/evolver/api/scope-grant`.
 *
 * Held in MEMORY ONLY — never localStorage, never a URL. A token in localStorage
 * is readable by any script on the origin and survives the tab; the grant is
 * short-lived and bound to the caller that requested it, so losing it on reload
 * costs one round trip and not security.
 */
export function setCapability(token: string | null): void {
  capability = token;
}

export function currentCapability(): string | null {
  return capability;
}

export interface GrantResponse {
  capability: string | null;
  sessionId: string;
  tasks: string[];
  /**
   * Which scope was granted. `owned` = this session created those tasks;
   * `workspace` = the session owns none, so it received this workspace's tasks —
   * correct for a single-researcher local host, and SHOWN rather than implied;
   * `none` = nothing is published at all.
   */
  tier: 'owned' | 'workspace' | 'none';
  expiresAt: string;
  note?: string;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (capability !== null) headers.authorization = `Bearer ${capability}`;
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let code = 'HTTP';
    try {
      const body = await res.json() as { message?: string; error?: string };
      if (body.message) message = body.message;
      if (body.error) code = body.error;
    } catch { /* keep the status line */ }
    throw new WorkbenchApiError(res.status, code, message);
  }
  return await res.json() as T;
}

export const evolverApi = {
  status: (signal?: AbortSignal): Promise<WorkbenchStatus> =>
    getJson('/evolver/api/status', signal),

  /**
   * Ask for a read capability on THIS session.
   *
   * The session id comes from the `conversation.view` slot props (the host binds
   * `props: { sessionId }` for the `session` scope), not from anything the user
   * typed. The host mints the grant over the tasks that session actually owns, so
   * naming another session yields an empty grant rather than that session's data.
   */
  requestGrant: (sessionId: string, signal?: AbortSignal): Promise<GrantResponse> =>
    getJson(`/evolver/api/scope-grant?sessionId=${encodeURIComponent(sessionId)}`, signal),

  tasks: (limit = 20, cursor: string | null = null, signal?: AbortSignal):
    Promise<{ tasks: TaskSummary[]; nextCursor: string | null; scopeFiltered?: boolean }> =>
    getJson(`/evolver/api/tasks?limit=${limit}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, signal),

  workbench: (taskId: string, signal?: AbortSignal): Promise<WorkbenchSnapshot> =>
    getJson(`/evolver/api/tasks/${encodeURIComponent(taskId)}/workbench`, signal),

  modules: (taskId: string | null, query = '', signal?: AbortSignal): Promise<{ modules: ModuleCard[] }> =>
    getJson(
      `/evolver/api/modules${taskId === null ? '' : `?taskId=${encodeURIComponent(taskId)}`}${query === '' ? '' : `&query=${encodeURIComponent(query)}`}`,
      signal,
    ),

  papers: (query = '', signal?: AbortSignal): Promise<{ papers: PaperCard[] }> =>
    getJson(`/evolver/api/papers${query === '' ? '' : `?query=${encodeURIComponent(query)}`}`, signal),

  /**
   * Typed artifact read. `sha256` is the CONTENT hash the store's index
   * published; the store re-verifies it before serving.
   */
  artifact: (
    taskId: string,
    ref: { id: string; sha256?: string | null },
    view: 'summary' | 'detail' = 'summary',
    signal?: AbortSignal,
  ): Promise<ArtifactView> =>
    getJson(
      `/evolver/api/artifact?taskId=${encodeURIComponent(taskId)}&ref=${encodeURIComponent(ref.id)}${ref.sha256 === undefined || ref.sha256 === null ? '' : `&sha256=${encodeURIComponent(ref.sha256)}`}&view=${view}`,
      signal,
    ),

  // ==========================================================================
  // v3 (workbench-research), explicit opt-in.
  // ==========================================================================
  //
  // These are NEW functions rather than a parameter on the v2 ones. A v2 call
  // must keep sending exactly the request it sent before: the host serves v2
  // unless `?schemaVersion=3` appears, and a shared helper would make it far
  // too easy for a future edit to attach the flag to a v2 path.

  /** v3 task list, each entry naming the store it actually came from. */
  tasksV3: (limit = 20, cursor: string | null = null, signal?: AbortSignal):
    Promise<{ tasks: QualifiedTask[]; nextCursor: string | null; scopeFiltered?: boolean }> =>
    getJson(
      `/evolver/api/tasks?schemaVersion=3&limit=${limit}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      signal,
    ),

  /**
   * v3 snapshot.
   *
   * A 409 `AMBIGUOUS_TASK` is surfaced with its candidate list rather than as a
   * generic failure: the page has to choose a qualified identity, and losing the
   * candidates would leave it guessing.
   */
  workbenchV3: (taskId: string, signal?: AbortSignal): Promise<WorkbenchSnapshotV3> =>
    getJson(`/evolver/api/tasks/${encodeURIComponent(taskId)}/workbench?schemaVersion=3`, signal),

  /** v3 papers carrying typed method tags instead of counts alone. */
  papersV3: (query = '', signal?: AbortSignal): Promise<{ papers: PaperCardV3[] }> =>
    getJson(`/evolver/api/papers?schemaVersion=3${query === '' ? '' : `&query=${encodeURIComponent(query)}`}`, signal),

  /**
   * The change token. `sinceViewVersion` lets the server answer "nothing you
   * show has moved" with the same token and an empty region list, so an idle
   * page costs one small read and no re-render.
   *
   * `sinceViewEpoch` is sent because a HOST RESTART invalidates every sequence
   * number the page holds. Without it the server cannot tell "this task changed"
   * from "the host restarted and my counters mean nothing now", and would
   * report a partial region list over pre-restart data.
   */
  changes: (taskId: string, sinceViewVersion: string | null, sinceViewEpoch: string | null = null, signal?: AbortSignal): Promise<ChangeToken> =>
    getJson(
      `/evolver/api/tasks/${encodeURIComponent(taskId)}/changes?schemaVersion=3${sinceViewVersion === null ? '' : `&sinceViewVersion=${encodeURIComponent(sinceViewVersion)}`}${sinceViewEpoch === null ? '' : `&sinceViewEpoch=${encodeURIComponent(sinceViewEpoch)}`}`,
      signal,
    ),

  /**
   * The model data flow for ONE candidate.
   *
   * `candidateKey` is required rather than defaulted: the flow is a view OF a
   * candidate, and picking the first would silently show another branch's
   * structure.
   */
  dataflowV3: (taskId: string, candidateKey: string, variantKey: string | null = null, signal?: AbortSignal): Promise<ModelDataFlow> =>
    getJson(
      `/evolver/api/tasks/${encodeURIComponent(taskId)}/dataflow?schemaVersion=3&candidateKey=${encodeURIComponent(candidateKey)}${variantKey === null ? '' : `&variantKey=${encodeURIComponent(variantKey)}`}`,
      signal,
    ),

  /** `/status` with the v3 advertisement fields. */
  statusV3: (signal?: AbortSignal): Promise<WorkbenchStatusV3> =>
    getJson('/evolver/api/status', signal),
};