/**
 * Workbench read scope: who may read which task, and how the answer is proven.
 *
 * WHY THIS EXISTS — and what it can and cannot do.
 *
 * The redesign plan (R04) asked the worker to "resolve the DSH Session on the
 * server and check scope". The two halves of that were checked separately
 * against the INSTALLED host, and they have DIFFERENT answers.
 *
 * 1. The SERVER cannot derive the caller. `webServer.register` hands the handler
 *    a bare `node:http` `IncomingMessage` (`dsh-host-webserver/lib/index.js`
 *    L228-234, L245): no session, agent, principal or context. DSH's own
 *    controllers do not derive one either — they take `sessionId` as a request
 *    ARGUMENT — and the Typert/Remote contract's unit of identity is always an
 *    argument, so no service answers "which session is this request". The host
 *    cookie carries only `{version, authority, issuedAt, expiresAt}`
 *    (`dsh-client-connection` L395-400): no session id, shared by every session
 *    in the window.
 *
 * 2. The PAGE does know its session. `dsh-client-ui-session` installs the
 *    `session` slot scope with `props: { sessionId }` (lib/client.js L61-70), so
 *    a `conversation.view` occupant receives `sessionId` in its props. Reading
 *    only the `renderSlot` call site suggests otherwise and was wrong; the
 *    scope installation above is the authority.
 *
 * So the page requests a grant naming its OWN session and the route verifies it.
 * That is safe only because the grant is BOUND to the calling fingerprint — see
 * GrantRecord.boundTo — so a token that leaks into another origin, log or script
 * is refused rather than replayed. This is the boundary DSH itself documents:
 * "ids are predictable, so authorization — not secrecy — is the boundary".
 *
 * The token travels in an `Authorization: Bearer` header (never a query
 * parameter: the browser replays query params into logs/history/referrers, and
 * Layer 1 would happily hand them to any same-site caller).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** What a grant authorizes. Never carries a filesystem path or an owner override. */
export interface GrantRecord {
  schemaVersion: 1;
  /** sha256 of the token; the token itself is never persisted. */
  tokenHash: string;
  /** The owning DSH session, as the Agent knew it at mint time. */
  sessionId: string;
  /** Tasks this grant may read. Empty means "nothing yet". */
  taskIds: string[];
  /**
   * What `taskIds` MEANS.
   *
   * `owned` — exactly those ids, frozen at mint time. Correct for a session's own
   * tasks: the set is a fact about the session and does not grow behind its back.
   *
   * `workspace` — every task in this workspace, resolved LIVE rather than from the
   * frozen list. This is the tier a brand-new chat session gets, and its meaning is
   * "this workspace", which is a moving target: a task created by a chat turn after
   * the page loaded must become reachable, or the page can never show the work it
   * just started.
   *
   * The frozen list was the defect. The page requested a grant on mount, the grant
   * recorded the 18 product tasks that existed at that instant, and every task
   * created afterwards was filtered out of `/tasks?schemaVersion=3` and refused on
   * `/tasks/:id/workbench` — for the whole 6-hour TTL. The symptom was a menu that
   * never grew and a research panel that could not be opened, while the same route
   * WITHOUT a capability returned the new task. A real browser found it.
   */
  scope: 'owned' | 'workspace';
  /**
   * The caller fingerprint the grant is BOUND to.
   *
   * This is what makes a self-service grant safe. The page learns its session id
   * from the `conversation.view` slot (dsh-client-ui-session installs the
   * `session` scope with `props: { sessionId }`), so it can ask for a grant — but
   * a bare token handed to any process on the same origin would be replayable.
   * Binding the grant to the caller that requested it means a token presented
   * from a different caller is refused even though the token string is valid.
   */
  boundTo: string | null;
  /** ISO timestamp; a lapsed grant is refused, not silently widened. */
  expiresAt: string;
  createdAt: string;
  /** Why the grant exists, for the audit row. */
  reason: 'dsh_chat_tool' | 'page_request';
}

export interface GrantStoreOptions {
  /** Where grant records are appended (repo-relative, host-owned). */
  root: string;
  /** Default lifetime. Short on purpose: this is a read capability, not a login. */
  ttlMs?: number;
  /**
   * Cap on grants minted by the self-service page endpoint. A page that can
   * mint without limit is a page that can enumerate the store.
   */
  maxGrantsPerSession?: number;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_GRANTS = 8;

/**
 * Fingerprint of the CALLING PROCESS, used to bind a grant.
 *
 * This is deliberately NOT a security boundary on its own — it cannot be, since
 * a hostile local process can spoof a User-Agent. Its job is narrower and it is
 * the job it can actually do: stop a token that leaked into a different origin,
 * log, or script from being replayed silently. The real boundaries remain Layer 1
 * (the host's own browser auth) and the task scope itself.
 */
export function callerFingerprint(headers: Record<string, string | string[] | undefined> | undefined): string {
  const pick = (name: string): string => {
    if (headers === undefined) return '';
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== name) continue;
      return (Array.isArray(value) ? value[0] : value) ?? '';
    }
    return '';
  };
  const ua = pick('user-agent').slice(0, 64);
  const origin = pick('origin').slice(0, 64);
  const acceptLang = pick('accept-language').slice(0, 32);
  return createHash('sha256').update(`${ua}|${origin}|${acceptLang}`).digest('hex').slice(0, 32);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time compare so a timing oracle cannot enumerate live tokens. */
function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export class WorkbenchScopeStore {
  private readonly root: string;
  private readonly ttlMs: number;
  private readonly maxGrantsPerSession: number;

  constructor(options: GrantStoreOptions) {
    this.root = path.resolve(options.root);
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxGrantsPerSession = options.maxGrantsPerSession ?? DEFAULT_MAX_GRANTS;
  }

  private fileFor(hash: string): string {
    // The hash is hex, so this cannot traverse; the check is defence in depth.
    return path.join(this.root, `${hash}.json`);
  }

  /**
   * Issue a capability for a session/task set.
   *
   * `boundTo` is the caller fingerprint. When it is non-null the token is only
   * usable from that caller — see GrantRecord.boundTo.
   */
  mint(
    sessionId: string,
    taskIds: string[],
    reason: GrantRecord['reason'],
    boundTo: string | null = null,
    scope: GrantRecord['scope'] = 'workspace',
  ): { token: string; record: GrantRecord } | { error: string } {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      return { error: 'sessionId must be a non-empty string' };
    }
    const live = this.countLiveForSession(sessionId);
    if (live >= this.maxGrantsPerSession) {
      // THE CAP MUST NOT LOCK A LEGITIMATE PAGE OUT FOR THE WHOLE TTL.
      //
      // The cap counts every unexpired grant for a session, and the page asks for
      // one on each mount. With a 6-hour TTL, reloading the workbench eight times
      // used to exhaust the cap, and the page could then never obtain a capability
      // again until the grants expired. The symptom is a page that renders its
      // menu and then loads no task data at all — which reads as a broken
      // projection, not a spent grant budget. A real browser found it after one
      // session had accumulated 12 grants in a day of runs.
      //
      // What the cap is FOR is stopping a page from ENUMERATING the store by
      // minting unbounded distinct grants. Replacing this session's OLDEST grant
      // keeps that property — the session never holds more than the cap — while
      // letting a page that is simply being reloaded get a working token.
      //
      // The token cannot be recovered from the store (only its hash is kept, on
      // purpose), so the old record is REVOKED rather than reused. That also means
      // a leaked old token stops working, which is strictly better than reusing it.
      const evicted = this.revokeOldestForSession(sessionId);
      if (!evicted) {
        return { error: `session already holds ${live} live grants (max ${this.maxGrantsPerSession}) and none could be replaced` };
      }
    }
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    const record: GrantRecord = {
      schemaVersion: 1,
      tokenHash: tokenHash(token),
      sessionId: sessionId.trim(),
      taskIds: [...new Set(taskIds)],
      // `workspace` is the DEFAULT for a self-service page grant, because that is
      // what such a grant means: "the tasks in this workspace", a set that grows.
      // An owned grant names a fixed list and keeps the frozen semantics.
      scope,
      boundTo,
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      createdAt: now.toISOString(),
      reason,
    };
    try {
      fs.mkdirSync(this.root, { recursive: true });
      fs.writeFileSync(this.fileFor(record.tokenHash), JSON.stringify(record, null, 2));
      return { token, record };
    } catch {
      return { error: 'grant store is not writable' };
    }
  }

  /**
   * Revoke this session's oldest live grant, so a replacement can be minted.
   *
   * Oldest-first is deliberate: the most recently issued grant is the one a page
   * is most likely still holding, so evicting it would break the caller that just
   * asked. Returns false when there was nothing to evict.
   */
  private revokeOldestForSession(sessionId: string): boolean {
    let files: string[];
    try {
      files = fs.readdirSync(this.root).filter((f) => f.endsWith('.json'));
    } catch {
      return false;
    }
    let oldest: { file: string; createdAt: number } | null = null;
    for (const f of files) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.root, f), 'utf8')) as GrantRecord;
        if (rec.sessionId !== sessionId.trim()) continue;
        const expires = Date.parse(rec.expiresAt);
        if (!Number.isFinite(expires) || expires <= Date.now()) continue;
        const created = Date.parse(rec.createdAt);
        const at = Number.isFinite(created) ? created : 0;
        if (oldest === null || at < oldest.createdAt) oldest = { file: f, createdAt: at };
      } catch { /* an unreadable grant is not a candidate */ }
    }
    if (oldest === null) return false;
    try {
      fs.unlinkSync(path.join(this.root, oldest.file));
      return true;
    } catch {
      return false;
    }
  }

  /** Live (unexpired) grants for a session, used for the per-session cap. */
  private countLiveForSession(sessionId: string): number {
    let files: string[];
    try {
      files = fs.readdirSync(this.root).filter((f) => f.endsWith('.json'));
    } catch {
      return 0;
    }
    let live = 0;
    for (const f of files) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.root, f), 'utf8')) as GrantRecord;
        if (rec.sessionId !== sessionId) continue;
        const expires = Date.parse(rec.expiresAt);
        if (Number.isFinite(expires) && expires > Date.now()) live += 1;
      } catch { /* an unreadable grant simply does not count */ }
    }
    return live;
  }

  /**
   * Resolve a presented token to its grant, or the reason it failed.
   *
   * `caller` is checked against the grant's binding: a valid token presented from
   * a different caller is refused as WRONG_CALLER, which is distinct from a bad
   * token and from an expired one so the page can tell "refresh your grant" from
   * "you are not allowed".
   */
  verify(token: string | null, caller: string | null = null):
    | { record: GrantRecord }
    | { error: 'NO_TOKEN' | 'BAD_TOKEN' | 'EXPIRED' | 'WRONG_CALLER' | 'UNREADABLE' } {
    if (typeof token !== 'string' || token.length === 0) return { error: 'NO_TOKEN' };
    const hash = tokenHash(token);
    let raw: string;
    try {
      raw = fs.readFileSync(this.fileFor(hash), 'utf8');
    } catch {
      return { error: 'BAD_TOKEN' };
    }
    let record: GrantRecord;
    try {
      record = JSON.parse(raw) as GrantRecord;
    } catch {
      return { error: 'UNREADABLE' };
    }
    // Re-hash rather than trust the stored field: a record whose own hash does
    // not match its content is not evidence of anything.
    if (!hashEquals(tokenHash(token), record.tokenHash)) return { error: 'BAD_TOKEN' };
    const expires = Date.parse(record.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) return { error: 'EXPIRED' };
    if (record.boundTo !== null && caller !== null && record.boundTo !== caller) {
      return { error: 'WRONG_CALLER' };
    }
    return { record };
  }

  /**
   * Cross-session check: does this grant authorize reading this task?
   *
   * For an `owned` grant the answer is a membership test against the frozen list —
   * a grant that does not name the task is refused, with no implicit "same
   * directory" or "same owner prefix" fallback.
   *
   * For a `workspace` grant the answer is membership in the workspace's CURRENT
   * task set, which the caller supplies. It has to be supplied because the scope
   * store deliberately knows nothing about the stores: keeping it ignorant of
   * directory layouts is what stops it from growing a second, divergent notion of
   * what a task is. The consequence is that a task created after the grant was
   * minted IS readable, which is the point — the page has to be able to show the
   * work it just started.
   */
  static allows(record: GrantRecord, taskId: string, workspaceTaskIds?: string[]): boolean {
    if (record.scope === 'workspace') {
      // No live set supplied means the caller cannot resolve the workspace; fall
      // back to the frozen list rather than allowing everything. Fail closed.
      if (workspaceTaskIds === undefined) return record.taskIds.includes(taskId);
      return workspaceTaskIds.includes(taskId);
    }
    return record.taskIds.includes(taskId);
  }

  revoke(token: string): boolean {
    try {
      fs.unlinkSync(this.fileFor(tokenHash(token)));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Extract a bearer token from request headers. Tolerates the case-insensitive
 * header names node exposes, and refuses anything that is not a single bearer
 * value — a comma-joined list would otherwise smuggle a second token past a
 * naive prefix check.
 */
export function bearerToken(headers: Record<string, string | string[] | undefined> | undefined): string | null {
  if (!headers) return null;
  let raw: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'authorization') continue;
    raw = Array.isArray(value) ? value[0] : value;
    break;
  }
  if (typeof raw !== 'string') return null;
  const match = /^Bearer\s+([A-Za-z0-9._-]{16,})$/.exec(raw.trim());
  return match ? match[1] : null;
}