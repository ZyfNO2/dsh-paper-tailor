/**
 * Phase 3 workbench HOST half: read-only HTTP face over the evolver stores.
 *
 * Spec: docs/mvp/phases/PHASE3-SPEC.md sections 7.2/8.2/8.4; redesign plan §4.1.
 * This plugin registers a prefix webserver route (`/evolver/api`) and serves
 * the read-only v2 projections of ./workbench-projection.ts.
 *
 * ACCESS CONTROL — two layers.
 *
 * LAYER 1 (authentication) uses DSH's OWN primitive,
 * `connection.requestRejection(req)`, the same three lines its `/api` route uses
 * (Host/Origin fence + browser auth). It closes cross-site and non-browser
 * callers.
 *
 * LAYER 2 (authorization) needs a capability. The server CANNOT derive the
 * caller: `webServer.register` passes a bare `IncomingMessage`
 * (`dsh-host-webserver/lib/index.js` L228-234), DSH's controllers take sessionId
 * as an argument, and the host cookie has no session id. But the PAGE does know
 * its session — `dsh-client-ui-session` binds the `session` slot scope with
 * `props: { sessionId }` — so `/scope-grant` issues a grant for the session the
 * page names, BOUND to that caller's fingerprint, and only for the tasks that
 * session actually owns on disk. This is the boundary DSH itself documents:
 * ids are predictable, so authorization, not secrecy, is the boundary.
 *
 * CONFIGURED MODE. When `required: true`, a request without a valid grant is
 * refused with SCOPE_DENIED. The default is `false` so the route still works on
 * a host where no grant has been minted; `/status` always reports which mode is
 * live, and the UI surfaces it. Turning the fence ON without a grant path would
 * make the workbench permanently empty rather than merely open.
 *
 * Other deliberate boundaries:
 *  - READ ONLY. Every Phase 3 write goes through the DSH Agent tools, where the
 *    owner is resolved from the invoking Agent. This route has no write method.
 *  - HostExecutionRecord rows are correlation evidence, NOT attestation; the
 *    Phase 1 provenance BLOCKER stays open regardless of what is recorded.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { WorkbenchStore } from './workbench-projection.ts';
import { WorkbenchResearchStore } from './workbench-research-projection.ts';
import {
  WorkbenchResearchService,
  createHostSourceResolver,
} from '../../application/workbench-research-service.ts';
import { WorkbenchScopeStore, bearerToken, callerFingerprint } from './workbench-scope.ts';
import { resolveRepoPath } from './repo-root.ts';

export const name = 'evolver-workbench-host';
export const inject: readonly string[] = ['webServer'];
export const provide: readonly string[] = ['evolverWorkbench'];

export interface EvolverWorkbenchHostConfig {
  /** Phase 2 experiment storage root, repo-relative (…/artifacts/research-execution). */
  researchExecutionRoot: string;
  /** Paper-only storage root, repo-relative (…/artifacts/paper-only). */
  paperOnlyRoot: string;
  /**
   * Phase 3 experiment store, repo-relative (…/artifacts/phase3/experiments).
   *
   * OPTIONAL with a default, deliberately: this field was added after the bundle
   * patch was written, and a config that names it as required made `apply()`
   * throw on path.resolve(undefined) — which failed the whole plugin load and
   * took the route with it (a 404 that looked like "the workbench is not
   * installed"). Defaulting here means an older host config keeps working and
   * still serves Phase 2 data; a missing Phase 3 store is then reported as an
   * empty Phase 3 surface rather than as a dead route.
   */
  phase3ExperimentRoot?: string;
  /**
   * The research-workbench sidecar root (…/artifacts/phase3/workbench-research).
   *
   * OPTIONAL with a default, for the same reason `phase3ExperimentRoot` is: a
   * config that names a new REQUIRED field made `apply()` throw on
   * `path.resolve(undefined)`, which failed the whole plugin load and presented
   * as a 404 on every route rather than as a config error. With a default, an
   * older host config keeps serving v2 and only v3 reports itself unavailable.
   */
  workbenchResearchRoot?: string;
  /** Where HostExecutionRecord rows are appended, repo-relative. */
  hostExecutionRoot?: string;
  /** Where read-scope grants are persisted, repo-relative. */
  scopeGrantRoot?: string;
  /** Repo root for resolving repo-relative defaults. */
  repoRoot?: string;
  /**
   * Require a valid bearer grant for every task read. See the module header.
   * Defaults to false so a host with no minted grant still renders; /status
   * always reports the live mode.
   */
  required?: boolean;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    evolverWorkbench?: { route: string | null; scopeRequired: boolean };
  }
}

/** The `connection` service shape this route uses, structurally typed. */
interface ConnectionLike {
  /** 403 for an untrusted host / cross-site request, 401 when unauthenticated. */
  requestRejection(request: unknown): number | undefined;
}

// ----------------- HostExecutionRecord -----------------

/**
 * A configuration error that must be visible as one.
 *
 * Thrown with a message naming the offending field, so a missing root reads as
 * "this field is required" instead of the anonymous
 * `TypeError: paths[1] must be of type string` that path.resolve produces.
 */
export class EvolverHostConfigError extends Error {
  constructor(message: string) {
    super(`evolver-workbench-host config error: ${message}`);
    this.name = 'EvolverHostConfigError';
  }
}

export interface HostExecutionRecord {
  schemaVersion: 1;
  id: string;
  phase: 'start' | 'completion';
  startRef: string | null;
  hostVersion: string;
  pluginBuildHash: string;
  entryKind: 'dsh_chat' | 'dsh_ui' | 'diagnostic';
  ownerSessionId: string | null;
  taskId: string | null;
  operationId: string | null;
  attemptId: string | null;
  toolCallRef: string | null;
  routeRef: string | null;
  startedAt: string;
  finishedAt: string | null;
  processFactsRef: string | null;
  note: string;
}

/**
 * Append one execution row.
 *
 * R12: a write failure here must be DISCLOSED, not swallowed — a silent null
 * made a missing evidence file indistinguishable from a request that never
 * happened. `strict` re-throws so a caller that needs the row for correlation
 * can tell the difference; the route keeps the non-throwing behaviour but logs.
 */
export function appendHostExecutionRecord(
  root: string,
  record: Omit<HostExecutionRecord, 'schemaVersion' | 'id'>,
  options: { strict?: boolean; logger?: (message: string) => void } = {},
): string | null {
  try {
    fs.mkdirSync(root, { recursive: true });
    const id = `her-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const full: HostExecutionRecord = { schemaVersion: 1, id, ...record };
    fs.writeFileSync(path.join(root, `${id}.json`), JSON.stringify(full, null, 2));
    return id;
  } catch (err) {
    const message = `HostExecutionRecord 写入失败（${root}）：${err instanceof Error ? err.message : String(err)}`;
    if (options.strict === true) throw new Error(message);
    options.logger?.(message);
    return null;
  }
}

// ----------------- Plugin -----------------

interface ReqLike {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}
interface ResLike {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body: string): unknown;
}

export function apply(ctx: Context, config: EvolverWorkbenchHostConfig): void {
  const repoRoot = resolveRepoPath(config.repoRoot ?? '.');
  // `path.resolve(undefined)` throws, and a throw HERE fails the whole plugin
  // load — which presents to the user as a 404 on every route rather than as a
  // config error. Each root is therefore resolved through a helper that reports
  // a missing required field explicitly.
  const resolveRoot = (value: string | undefined, fallback: string | null, field: string): string => {
    const chosen = value ?? fallback;
    if (chosen === null) {
      throw new EvolverHostConfigError(
        `${field} is required in the workbench host config (no default exists for it)`,
      );
    }
    return path.resolve(repoRoot, chosen);
  };
  const researchExecutionRoot = resolveRoot(config.researchExecutionRoot, null, 'researchExecutionRoot');
  const paperOnlyRoot = resolveRoot(config.paperOnlyRoot, null, 'paperOnlyRoot');
  const phase3ExperimentRoot = resolveRoot(
    config.phase3ExperimentRoot,
    'artifacts/phase3/experiments',
    'phase3ExperimentRoot',
  );
  const hostExecutionRoot = resolveRoot(config.hostExecutionRoot, 'artifacts/phase3/host-executions', 'hostExecutionRoot');
  const scopeGrantRoot = resolveRoot(config.scopeGrantRoot, 'artifacts/phase3/scope-grants', 'scopeGrantRoot');
  const workbenchResearchRoot = resolveRoot(
    config.workbenchResearchRoot,
    'artifacts/phase3/workbench-research',
    'workbenchResearchRoot',
  );
  const scopeRequired = config.required === true;

  const store = new WorkbenchStore({ researchExecutionRoot, paperOnlyRoot, phase3ExperimentRoot });

  /**
   * The v3 projection and its sidecar.
   *
   * Both are optional at load time. A host whose `workbenchResearchRoot` does
   * not exist yet still serves v2 exactly as before, and a v3 request then
   * answers 503 with the reason instead of throwing during plugin load — which
   * would present as a 404 on every route, the failure mode the
   * `phase3ExperimentRoot` post-mortem already documents.
   */
  let researchStore: WorkbenchResearchStore | null = null;
  let researchService: WorkbenchResearchService | null = null;
  let researchStoreError: string | null = null;
  try {
    researchService = new WorkbenchResearchService({
      root: workbenchResearchRoot,
      resolver: createHostSourceResolver({ repoRoot, researchExecutionRoot }),
    });
    researchStore = new WorkbenchResearchStore({
      repoRoot,
      researchService,
      roots: { researchExecutionRoot, paperOnlyRoot, phase3ExperimentRoot, workbenchResearchRoot },
    });
  } catch (err) {
    researchStoreError = err instanceof Error ? err.message : String(err);
  }

  const scope = new WorkbenchScopeStore({ root: scopeGrantRoot });

  /**
   * Give the v2 store the product task ids, so a GRANT can cover them.
   *
   * This closes the defect that silently deleted the whole v3 surface. The grant
   * was minted from `WorkbenchStore.allTaskIds()`, which knew only the Phase 2 and
   * Phase 3 stores — so it never named a product task. The page then sent its
   * capability with every request, the host filtered `/tasks?schemaVersion=3`
   * down to the granted ids, every product task was filtered out, and the menu
   * showed experiment tasks only. `isProductTask` was therefore never true and the
   * rationale and model data flow were unreachable by any user action.
   *
   * It is refreshed on EVERY grant request rather than once at load, because a
   * product task is created by a chat turn while the host is running: a snapshot
   * taken at plugin activation would name none of the tasks the user then creates,
   * which is the very case SPEC §7.2 requires the menu to pick up.
   */
  const refreshProductTaskIds = (): void => {
    try {
      store.setProductTaskIds(researchService === null ? [] : researchService.listTasks().map((t) => t.taskId));
    } catch {
      // A sidecar that cannot be listed contributes no product tasks; the grant
      // then covers exactly what could be read, which is the conservative answer.
      store.setProductTaskIds([]);
    }
  };
  refreshProductTaskIds();

  /**
   * The workspace's task ids AS THEY ARE NOW.
   *
   * A `workspace`-scoped grant means "the tasks in this workspace", and that set
   * grows while the page is open: a chat turn creates a product task, and the page
   * must be able to read it. Resolving live is what makes that work; the frozen
   * list the grant records is only a fallback and an audit record of what existed
   * at mint time.
   */
  const liveWorkspaceTaskIds = (): string[] => {
    refreshProductTaskIds();
    return store.allTaskIds();
  };
  const buildHash = computeBuildHash(typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url));

  // `connection` is NOT in `inject`: it is absent on hosts without a browser
  // connection service, and declaring it would leave this plugin's fiber
  // pending. An optional read through ctx.get() degrades to "no Layer 1".
  const connection = ctx.get('connection') as ConnectionLike | undefined;
  const logger = (message: string) => ctx.logger.warn(`${name}: ${message}`);

  const webserver = ctx.get('webServer') as
    | {
        register(route: {
          kind: 'exact' | 'prefix';
          path: string;
          handler: (req: unknown, res: unknown) => void | Promise<void>;
        }): () => void;
      }
    | undefined;

  ctx.on('dispose', () => { /* route disposal handled by register()'s disposer below */ });

  const record = (
    phase: 'start' | 'completion',
    fields: Partial<HostExecutionRecord>,
  ): string | null =>
    appendHostExecutionRecord(
      hostExecutionRoot,
      {
        phase,
        startRef: null,
        hostVersion: process.env.DSH_CLIENT_VERSION ?? 'unknown',
        pluginBuildHash: buildHash,
        entryKind: 'dsh_ui',
        ownerSessionId: null,
        taskId: null,
        operationId: null,
        attemptId: null,
        toolCallRef: null,
        routeRef: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        processFactsRef: null,
        note: '',
        ...fields,
      },
      { logger },
    );

  if (!webserver) {
    ctx.provide('evolverWorkbench', { route: null, scopeRequired });
    record('start', {
      entryKind: 'diagnostic',
      note: 'evolver-workbench-host applied WITHOUT webserver service; no /evolver/api route registered',
    });
    return;
  }

  /**
 * The route handler.
 *
 * It is async because the v3 branches resolve real artifacts and read source
 * revisions. Every `send()` inside remains synchronous from the caller's point
 * of view: the awaited work happens BEFORE the response is written, never after
 * it, so a v3 request cannot resolve after the socket has closed.
 */
const serve = async (req: ReqLike, res: ResLike): Promise<void> => {
    const started = new Date().toISOString();
    const url = (req.url ?? '/').split('?')[0];

    const send = (status: number, body: unknown, context: { taskId?: string | null; ownerSessionId?: string | null; note?: string } = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      record('completion', {
        startedAt: started,
        finishedAt: new Date().toISOString(),
        taskId: context.taskId ?? null,
        ownerSessionId: context.ownerSessionId ?? null,
        note: context.note ?? `${req.method ?? 'GET'} ${url} -> ${status}`,
      });
    };

    // LAYER 1: DSH's own Host/Origin + browser fence. Absent the `connection`
    // service (a headless host) this is a documented no-op, and /status says so.
    if (connection !== undefined) {
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) {
        send(rejection, { error: rejection === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN_HOST', message: '宿主拒绝该来源' });
        return;
      }
    }

    try {
      const query = new URL(req.url ?? '/', 'http://local').searchParams;

      /**
       * SCHEMA VERSION NEGOTIATION (SPEC section 1.2).
       *
       * Before this existed, `schemaVersion` was WRITTEN by the projection and
       * NEVER READ by anything: no query parameter was parsed, no unknown
       * version was refused. That is why WR-22 ("v2 preserved, v3 explicit,
       * unknown refused") is greenfield rather than an extension.
       *
       * The rules, and why each is stated:
       *  - ABSENT or "2" serves v2, byte-for-byte what shipped before. The v2
       *    path must not change for an existing page, so it is selected by
       *    falling through to the original branches untouched.
       *  - "3" opts into v3. It is never inferred from anything else.
       *  - ANYTHING ELSE is a 400. Coercing an unknown version to the newest one
       *    would hand a v4-shaped payload to a v3 client, and coercing it to v2
       *    would silently drop candidateDesigns — the exact failure the SPEC
       *    forbids. An unparseable value is also refused rather than defaulted,
       *    because `?schemaVersion=abc` is a client bug that must be visible.
       */
      const requestedVersion = query.get('schemaVersion');
      let schemaVersion: 2 | 3 = 2;
      if (requestedVersion !== null) {
        if (requestedVersion === '3') schemaVersion = 3;
        else if (requestedVersion !== '2') {
          send(400, {
            error: 'UNSUPPORTED_SCHEMA_VERSION',
            message: `schemaVersion=${JSON.stringify(requestedVersion)} is not served here; this host serves 2 (default) and 3 (?schemaVersion=3)`,
            supported: [2, 3],
            default: 2,
          }, { note: `rejected schemaVersion=${requestedVersion}` });
          return;
        }
      }

      /**
       * LAYER 2: resolve the presented capability.
       *
       * The owner comes from the GRANT, never from a request field for the
       * reads below. The grant endpoint above is the one place a session id is
       * accepted from a request, and it is why the grant is bound to the caller.
       */
      const caller = callerFingerprint(req.headers);
      const authorize = (taskId: string | null):
        | { ok: true; record: import('./workbench-scope.ts').GrantRecord | null }
        | { ok: false; status: number; body: unknown } => {
        const token = bearerToken(req.headers);
        const verdict = scope.verify(token, caller);
        if ('error' in verdict) {
          if (!scopeRequired) return { ok: true, record: null };
          const code = verdict.error === 'NO_TOKEN' ? 'SCOPE_DENIED' : 'SCOPE_INVALID';
          return {
            ok: false,
            status: 403,
            body: {
              error: code,
              message: `读取授权未通过：${verdict.error}`,
              // WRONG_CALLER and EXPIRED are recoverable by the page (re-request);
              // BAD_TOKEN is not, so the page is told which one happened.
              recoverable: verdict.error === 'EXPIRED' || verdict.error === 'WRONG_CALLER',
              required: true,
            },
          };
        }
        if (taskId !== null && !WorkbenchScopeStore.allows(verdict.record, taskId, liveWorkspaceTaskIds())) {
          return {
            ok: false,
            status: 403,
            body: {
              error: 'SCOPE_DENIED',
              message: `该授权不包含任务 ${taskId}`,
              grantedTasks: verdict.record.taskIds,
              ownerSessionId: verdict.record.sessionId,
            },
          };
        }
        return { ok: true, record: verdict.record };
      };

      /** The owner is the GRANT's session, never a request field. */
      const sessionOf = (a: { record: { sessionId: string } | null }): string | null =>
        a.record === null ? null : a.record.sessionId;

      /**
       * Grant endpoint.
       *
       * The page learns its own session id from the `conversation.view` slot
       * (`dsh-client-ui-session` binds `props: { sessionId }`), so it asks here
       * for a grant on THAT session. The scope is resolved from the STORES, not
       * from the request: the tasks that session owns, or — when it owns none, as
       * a brand-new chat session does — every task in this workspace, since this
       * host is one local researcher's tool over one repoRoot.
       *
       * `tier` is returned so the UI states which of the two it received instead
       * of implying a per-user isolation that does not exist on this host. The
       * caller can name a session; it cannot name a task, so this endpoint is not
       * a privilege-escalation oracle.
       */
      if (url === '/evolver/api/scope-grant') {
        const sessionId = query.get('sessionId');
        if (sessionId === null || sessionId.trim().length === 0) {
          send(400, { error: 'INVALID_INPUT', message: '需要 sessionId（页面从 conversation.view slot 获得）' });
          return;
        }
        // Refresh BEFORE resolving: a task created since the last grant must be
        // grantable now, or the page cannot reach the work it just started.
        refreshProductTaskIds();
        const resolved = store.readableTasks(sessionId.trim());
        if (resolved.grantedTier === 'none') {
          // Nothing published anywhere: say so plainly instead of handing out a
          // token that would fail on first use.
          send(200, {
            capability: null,
            sessionId: sessionId.trim(),
            tasks: [],
            tier: 'none',
            note: '本工作区没有任何已发布任务；工作台无可显示内容。',
          }, { ownerSessionId: sessionId.trim(), note: 'grant: no tasks in workspace' });
          return;
        }
        const minted = scope.mint(
          sessionId.trim(),
          resolved.tasks,
          'page_request',
          caller,
        );
        if ('error' in minted) {
          send(429, { error: 'SCOPE_REFUSED', message: minted.error });
          return;
        }
        // The token is returned ONCE and never persisted; the page keeps it in
        // memory only (setCapability), so it does not end up in localStorage.
        send(200, {
          capability: minted.token,
          sessionId: minted.record.sessionId,
          tasks: minted.record.taskIds,
          tier: resolved.grantedTier,
          expiresAt: minted.record.expiresAt,
        }, { ownerSessionId: minted.record.sessionId, note: `grant minted (${resolved.grantedTier}) for ${minted.record.taskIds.length} task(s)` });
        return;
      }

      if (url === '/evolver/api/status') {
        send(200, {
          // The DEFAULT served version stays 2. scripts/verify-workbench-live.ts
          // treats a non-2 value here as "the host is serving an older build",
          // so advertising 3 as the default would misreport a healthy host.
          // v3 is opt-in per request via ?schemaVersion=3.
          schemaVersion: 2,
          service: 'evolver-workbench',
          route: '/evolver/api',
          buildHash,
          schemaVersions: {
            default: 2,
            supported: [2, 3],
            optIn: 'append ?schemaVersion=3 to /tasks, /tasks/:taskId/workbench and /papers; /tasks/:taskId/changes is v3-only',
          },
          roots: {
            researchExecutionRoot,
            paperOnlyRoot,
            phase3ExperimentRoot,
            workbenchResearchRoot,
          },
          researchWorkbench: {
            available: researchStore !== null,
            // The reason is reported rather than thrown, so an operator can see
            // WHY v3 is unavailable without the whole route dying.
            unavailableReasonZh: researchStore === null ? (researchStoreError ?? '未初始化') : null,
            viewEpoch: researchStore?.viewEpochId ?? null,
          },
          access: {
            // Which layers are actually live on THIS host, so the UI never
            // claims enforcement that is not running.
            authentication: connection === undefined ? 'unavailable' : 'dsh-connection-fence',
            authorization: scopeRequired ? 'grant-required' : 'grant-optional',
            callerIdentityDerivedFromRequest: false,
            note: 'webServer 的 req 是裸 IncomingMessage，宿主不提供可派生的调用者身份；页面从 conversation.view slot 取得自己的 sessionId 后按会话申请 capability，宿主按存储中的权威 owner 记录签发。',
          },
        });
        return;
      }

      if (url === '/evolver/api/tasks') {
        const auth = authorize(null);
        if (!auth.ok) { send(auth.status, auth.body); return; }
        const cursor = query.get('cursor');
        const limit = Math.min(Math.max(Number(query.get('limit') ?? 20) || 20, 1), 100);
        if (schemaVersion === 3) {
          if (researchStore === null) {
            send(503, { error: 'UNSUPPORTED_CAPABILITY', message: `v3 不可用：${researchStoreError ?? '工作台侧车未初始化'}`, schemaVersion: 2 });
            return;
          }
          const result = researchStore.listTasksV3(cursor, limit);
          const live = liveWorkspaceTaskIds();
          const tasks = auth.record === null
            ? result.tasks
            : result.tasks.filter((t) => WorkbenchScopeStore.allows(auth.record as never, t.taskId, live));
          send(200, { schemaVersion: 3, ...result, tasks, scopeFiltered: auth.record !== null }, { ownerSessionId: sessionOf(auth), note: `listTasksV3 -> ${tasks.length} tasks` });
          return;
        }
        const result = store.listTasks(cursor, limit);
        // When a grant is presented the menu is narrowed to the tasks that
        // grant authorizes. Without a grant (optional mode) the list stands as
        // stored and `scopeFiltered` tells the UI which happened.
        const tasks = auth.record === null
          ? result.tasks
          : result.tasks.filter((t) => WorkbenchScopeStore.allows(auth.record as never, t.taskId, liveWorkspaceTaskIds()));
        send(200, { ...result, tasks, scopeFiltered: auth.record !== null }, { ownerSessionId: sessionOf(auth), note: `listTasks -> ${tasks.length} tasks` });
        return;
      }

      const workbenchMatch = /^\/evolver\/api\/tasks\/([^/]+)\/workbench$/.exec(url);
      if (workbenchMatch) {
        const taskId = decodeURIComponent(workbenchMatch[1]);
        const auth = authorize(taskId);
        if (!auth.ok) { send(auth.status, auth.body); return; }
        if (schemaVersion === 3) {
          if (researchStore === null) {
            send(503, { error: 'UNSUPPORTED_CAPABILITY', message: `v3 不可用：${researchStoreError ?? '工作台侧车未初始化'}`, schemaVersion: 2 }, { taskId, ownerSessionId: sessionOf(auth) });
            return;
          }
          const snap = await researchStore.getSnapshotV3(taskId);
          if (!snap.ok) {
            // 409 for an ambiguous id: the request is well-formed but the page
            // must pick a qualified identity. Collapsing it into 404 would hide
            // the second store and send the UI looking for a task that exists.
            const status = snap.code === 'AMBIGUOUS_TASK' ? 409 : 404;
            send(status, { error: snap.code, message: snap.message, candidates: snap.candidates ?? null, schemaVersion: 3 }, { taskId, ownerSessionId: sessionOf(auth) });
            return;
          }
          send(200, snap.value, { taskId, ownerSessionId: sessionOf(auth) });
          return;
        }
        const snap = store.getWorkbench(taskId);
        if ('error' in snap) {
          send(404, { error: 'NOT_FOUND', message: snap.error }, { taskId, ownerSessionId: sessionOf(auth) });
          return;
        }
        send(200, snap, { taskId, ownerSessionId: sessionOf(auth) });
        return;
      }

      // v3 change token (SPEC section 7.1). A dedicated route rather than a
      // query flag on an existing one, so a v2 client can never accidentally
      // start polling it.
      const changesMatch = /^\/evolver\/api\/tasks\/([^/]+)\/changes$/.exec(url);
      if (changesMatch) {
        if (schemaVersion !== 3) {
          send(400, { error: 'SCHEMA_VIOLATION', message: '/evolver/api/tasks/:taskId/changes 仅在 ?schemaVersion=3 下提供' }, { note: 'changes route requires v3' });
          return;
        }
        if (researchStore === null) {
          send(503, { error: 'UNSUPPORTED_CAPABILITY', message: `v3 不可用：${researchStoreError ?? '工作台侧车未初始化'}` });
          return;
        }
        const taskId = decodeURIComponent(changesMatch[1]);
        const auth = authorize(taskId);
        if (!auth.ok) { send(auth.status, auth.body); return; }
        const token = await researchStore.changes(taskId, query.get('sinceViewVersion'), query.get('sinceViewEpoch'));
        if ('error' in token) {
          send(token.error === 'AMBIGUOUS_TASK' ? 409 : 404, { error: token.error, message: token.message }, { taskId, ownerSessionId: sessionOf(auth) });
          return;
        }
        send(200, token, { taskId, ownerSessionId: sessionOf(auth) });
        return;
      }

      // v3 model data flow (SPEC section 7.1). A v3-only route: a v2 client
      // never learns this endpoint exists, so it cannot start polling it.
      const dataflowMatch = /^\/evolver\/api\/tasks\/([^/]+)\/dataflow$/.exec(url);
      if (dataflowMatch) {
        if (schemaVersion !== 3) {
          send(400, { error: 'SCHEMA_VIOLATION', message: '/evolver/api/tasks/:taskId/dataflow 仅在 ?schemaVersion=3 下提供' }, { note: 'dataflow route requires v3' });
          return;
        }
        if (researchStore === null) {
          send(503, { error: 'UNSUPPORTED_CAPABILITY', message: `v3 不可用：${researchStoreError ?? '工作台侧车未初始化'}` });
          return;
        }
        const taskId = decodeURIComponent(dataflowMatch[1]);
        const auth = authorize(taskId);
        if (!auth.ok) { send(auth.status, auth.body); return; }
        const candidateKey = query.get('candidateKey');
        if (candidateKey === null) {
          // The data flow is a view OF one candidate. With no candidate named,
          // picking the first would silently show another branch's structure.
          send(400, { error: 'INVALID_INPUT', message: '需要 candidateKey：模型数据流是某个候选的视图，不指定将默认选择第一支' }, { taskId, ownerSessionId: sessionOf(auth) });
          return;
        }
        const flow = await researchStore.dataflowV3(taskId, candidateKey, query.get('variantKey'));
        if ('error' in flow) {
          send(flow.code === 'DEPENDENCY_NOT_READY' ? 409 : 404, { error: flow.code, message: flow.message, unresolved: flow.unresolved ?? null }, { taskId, ownerSessionId: sessionOf(auth) });
          return;
        }
        send(200, flow.flow, { taskId, ownerSessionId: sessionOf(auth) });
        return;
      }

      if (url === '/evolver/api/modules') {
        const taskId = query.get('taskId');
        const auth = authorize(taskId);
        if (!auth.ok) { send(auth.status, auth.body); return; }
        send(200, { modules: store.listModules(taskId, query.get('query') ?? '') }, { taskId, ownerSessionId: sessionOf(auth) });
        return;
      }

      if (url === '/evolver/api/papers') {
        const auth = authorize(null);
        if (!auth.ok) { send(auth.status, auth.body); return; }
        if (schemaVersion === 3) {
          if (researchStore === null) {
            send(503, { error: 'UNSUPPORTED_CAPABILITY', message: `v3 不可用：${researchStoreError ?? '工作台侧车未初始化'}`, schemaVersion: 2 });
            return;
          }
          send(200, { schemaVersion: 3, papers: researchStore.listPapersV3(query.get('query') ?? '') }, { ownerSessionId: sessionOf(auth), note: 'listPapersV3' });
          return;
        }
        send(200, { papers: store.listPapers(query.get('query') ?? '') }, { ownerSessionId: sessionOf(auth) });
        return;
      }

      if (url === '/evolver/api/artifact') {
        // R05: the request is (taskId, ref, view). There is no path parameter.
        const taskId = query.get('taskId');
        const refId = query.get('ref');
        if (taskId === null || refId === null) {
          send(400, { error: 'INVALID_INPUT', message: '需要 taskId 与 ref（不是文件路径）' });
          return;
        }
        const auth = authorize(taskId);
        if (!auth.ok) { send(auth.status, auth.body); return; }
        const view = query.get('view') === 'detail' ? 'detail' : 'summary';
        const sha256 = query.get('sha256');
        const art = store.readArtifact(
          { taskId, ref: { id: refId, sha256: sha256 === null ? null : sha256 } },
          view,
        );
        if (!art.ok) {
          const status = art.code === 'FORBIDDEN_ARTIFACT' ? 403 : art.code === 'UNKNOWN_REF' || art.code === 'INVALID_TASK_ID' ? 404 : 400;
          send(status, { error: art.code, message: art.message }, { taskId, ownerSessionId: sessionOf(auth) });
          return;
        }
        send(200, art.value, { taskId, ownerSessionId: sessionOf(auth) });
        return;
      }

      send(404, { error: 'NOT_FOUND', message: `unknown endpoint: ${url}` });
    } catch (err) {
      logger?.(`workbench route failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      send(500, { error: 'INTERNAL', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const dispose = webserver.register({
    kind: 'prefix',
    path: '/evolver/api',
    handler: (req, res) => { void serve(req as ReqLike, res as ResLike); },
  });
  ctx.on('dispose', dispose);

  // Cordis requires an explicit provide before a context property assignment:
  // `ctx.evolverWorkbench = ...` throws "cannot set property ... without
  // provide" otherwise. The `provide` export alone is not enough at runtime.
  ctx.provide('evolverWorkbench', { route: '/evolver/api', scopeRequired });

  record('start', {
    entryKind: 'diagnostic',
    note: `evolver-workbench-host applied; GET /evolver/api registered (auth=${connection === undefined ? 'unavailable' : 'connection'}, scope=${scopeRequired ? 'required' : 'optional'})`,
  });
}

/** Content hash of this built file, for the workbench status row. */
function computeBuildHash(file: string): string {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return 'unknown';
  }
}
