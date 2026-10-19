/**
 * Research Cycle HOST half (Phase2): read-only projection, trusted action
 * bridge and in-process coordination for the evidence loop.
 *
 * Architecture §5 (Host 与前端入口): three authenticated routes reusing the
 * bootstrap bridge's workspace resolution and browser auth model:
 * - `GET /evolver/research-cycle` — the loop projection (runs, steps with
 *   blocking reasons, artifacts, effective DAG, applied decisions, nextActions).
 * - `GET /evolver/research-cycle/artifacts` — registered outputs / assigned snapshots.
 * - `GET /evolver/research-cycle/trace` — bounded native member event projection.
 * - `POST /evolver/research-cycle/actions` — start / cancel / retry. Receipts
 *   say `queued` honestly; the UI re-reads persisted state (受理 ≠ 完成).
 *
 * `sessionId` only LOCATES the workspace; it is never a write grant. Real
 * members get their permissions from the service boundary (assigned steps).
 *
 * Startup sweep: runs left queued/running/cancelling by a previous host process
 * become `interrupted` (content kept, statuses honest). A waiting_result run
 * keeps its completed steps — its decision can still be applied.
 *
 * Production coordination adapts native DSH Team members/tasks to the domain
 * loop. Missing native capabilities reject admission. An explicit executor
 * factory remains a test/demo seam, never an implicit production fallback.
 */

import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ArtifactRef } from '../../contracts/experiments.ts';
import { CycleError, type CycleRole } from '../../contracts/research-cycle.ts';
import type { BootstrapSourceResolver } from '../../contracts/research-bootstrap.ts';
import { ResearchBootstrapStore } from '../../application/research-bootstrap-store.ts';
import { ResearchCycleService } from '../../application/research-cycle-service.ts';
import type { CycleRoleExecutor } from '../../application/research-cycle-roles.ts';
import { assertNoForbiddenFields, workspaceForSession } from './research-bootstrap-graph-tools.ts';
import { paperLibraryResolver } from './research-bootstrap-graph-tools.ts';
import { applyResearchCycleTools, type ResearchCycleConfig } from './research-cycle-tools.ts';
import { cycleTeamCapability, nativeCycleExecutors } from './research-cycle-team.ts';

import { GeneralScheduleService } from '../../application/general-schedule-service.ts';
import { ResearchCycleStore } from '../../application/research-cycle-store.ts';
export const name = 'evolver-research-cycle';
export const inject = ['webServer', 'connection', 'workspaceRegistry', 'tools', 'agents', 'skills', 'sessionPersistence'];

const SESSION_PATTERN = /^[\w-]+$/;
/** Events the UI may send; anything else is refused, never guessed. */
const ACTION_TYPES = ['create_schedule', 'run_schedule', 'stop_schedule', 'start_cycle', 'cancel_cycle', 'retry_cycle', 'resume_cycle'] as const;
type ActionType = (typeof ACTION_TYPES)[number];

interface RegistryWorkspace { id: string; path: string; title: string; sessionIds: readonly string[] }
type WorkspaceRegistry = { list(): RegistryWorkspace[] };

interface ActiveCoordination { service: ResearchCycleService; runId: string; researchId: string; scheduleId?: string }

export function apply(ctx: Context, config: ResearchCycleConfig = {}): void {
  const registry = config.workspaceRegistry ?? (ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined);
  if (registry === undefined || typeof registry?.list !== 'function') {
    throw new Error('Research cycle host requires the DSH workspaceRegistry service');
  }
  const connection = ctx.get('connection') as { requestRejection(req: IncomingMessage): number | undefined };
  if (typeof connection?.requestRejection !== 'function') {
    throw new Error('Research cycle host requires DSH connection.requestRejection (browser auth)');
  }
  const web = ctx.get('webServer') as { register(route: { kind: string; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): () => void };
  if (typeof web?.register !== 'function') throw new Error('Research cycle host requires the DSH webServer');

  const storeFactory = config.storeFactory ?? ((workspacePath: string) => new ResearchBootstrapStore(workspacePath, { ...(config.now !== undefined ? { now: config.now } : {}) }));
  const resolverFactory = config.resolverFactory ?? paperLibraryResolver;
  const executorsFactory = config.executorsFactory;

  // The agent-facing member tools are registered HERE so a live Team can run
  // role steps through the same service boundary.
  applyResearchCycleTools(ctx, {
    workspaceRegistry: registry,
    storeFactory,
    resolverFactory,
    ...(config.now !== undefined ? { now: config.now } : {}),
  });

  const serviceFor = (workspacePath: string): ResearchCycleService => new ResearchCycleService({
    workspaceRoot: workspacePath,
    bootstrapStore: storeFactory(workspacePath),
    resolver: resolverFactory(workspacePath),
    ...(config.now !== undefined ? { now: config.now } : {}),
  });
  const schedules = new Map<string, GeneralScheduleService>();
  const scheduleFor = (root: string, researchId: string) => {
    const key = JSON.stringify([root, researchId]); let service = schedules.get(key);
    if (!service) { service = new GeneralScheduleService(storeFactory(root), serviceFor(root)); schedules.set(key, service); }
    return service;
  };

  // Restart sweep: honest interruption for runs whose live coordinator died
  // with the previous host process.
  for (const workspace of registry.list()) {
    try {
      const bootstrap = storeFactory(workspace.path).readState();
      if (bootstrap === null) continue;
      for (const research of bootstrap.researches) {
        try {
          const swept = serviceFor(workspace.path).sweepInterruptedRuns(research.researchId);
          scheduleFor(workspace.path, research.researchId).sweep(research.researchId);
          if (swept.length > 0) ctx.logger?.info?.(`Research cycle sweep interrupted ${swept.length} run(s) in ${workspace.title}`);
        } catch (error) { ctx.logger?.warn?.(`Cycle sweep skipped for ${research.researchId}: ${String(error)}`); }
      }
    } catch (error) { ctx.logger?.warn?.(`Cycle startup sweep skipped for ${workspace.title}: ${String(error)}`); }
  }

  // Live in-process coordinations, keyed by runId so cancel reaches the same
  // service instance that owns the abort controller.
  const active = new Map<string, ActiveCoordination>();

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };

  const dispatch = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname === '/evolver/research-cycle') { handleRead(req, res, url); return; }
    if (url.pathname === '/evolver/research-cycle/artifacts') { handleArtifact(req, res, url); return; }
    if (url.pathname === '/evolver/research-cycle/trace') { void handleTrace(req, res, url); return; }
    if (url.pathname === '/evolver/research-cycle/actions') { handleActions(req, res, url); return; }
    send(res, 404, { error: 'NOT_FOUND' });
  };
  const disposeRoute = web.register({ kind: 'prefix', path: '/evolver/research-cycle', handler: dispatch });
  ctx.on('dispose', disposeRoute);

  const requireSession = (url: URL): RegistryWorkspace => {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId || sessionId.length > 200 || !SESSION_PATTERN.test(sessionId)) {
      throw new CycleError('INVALID_INPUT', 'sessionId is required to locate the workspace');
    }
    return workspaceForSession(registry, sessionId);
  };

  async function ensureNativeLead(sessionId: string): Promise<void> {
    if (executorsFactory || (ctx.get('agents') as any)?.get(sessionId)) return;
    const controller = ctx.get('sessionController') as any;
    if (typeof controller?.resolveAgent !== 'function') return;
    const resolved = await controller.resolveAgent(sessionId);
    if ('error' in resolved) throw new CycleError('UNSUPPORTED_CAPABILITY', resolved.error.message);
  }

  async function handleRead(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const rejection = connection.requestRejection(req);
    if (rejection !== undefined) { send(res, rejection, { error: 'AUTH_REQUIRED' }); return; }
    if (req.method !== 'GET') { send(res, 405, { error: 'READ_ONLY' }); return; }
    try {
      const workspace = requireSession(url);
      let preparationError: string | null = null;
      try { await ensureNativeLead(url.searchParams.get('sessionId')!); }
      catch (error) { preparationError = error instanceof Error ? error.message : String(error); ctx.logger?.warn?.(`Research native runtime unavailable during read: ${preparationError}`); }
      const researchId = url.searchParams.get('researchId');
      if (researchId === null) { send(res, 400, { error: 'RESEARCH_REQUIRED' }); return; }
      const runId = url.searchParams.get('runId');
      const service = serviceFor(workspace.path);
      const view = service.getResearchCycleView(
        { identity: `web-ui:${url.searchParams.get('sessionId')}`, kind: 'user', actionId: null },
        { researchId, ...(runId !== null ? { runId } : {}) },
      );
      const native = ctx.get('agentTeams') as any;
      const lead = (ctx.get('agents') as any)?.get(url.searchParams.get('sessionId'));
      const memberIds = new Set(view.steps.map((step) => step.assignedMemberId));
      const taskIds = new Set(view.steps.map((step) => step.nativeTask?.taskId));
      send(res, 200, { schemaVersion: 1, scope: 'workspace-files', workspace: { id: workspace.id, title: workspace.title }, ...view,
        schedules: new ResearchCycleStore(workspace.path, researchId).readStateOrEmpty().schedules,
        runtime: executorsFactory ? { available: true, reason: null, mode: 'configured-executor' } : { ...(preparationError ? { available: false, reason: preparationError } : cycleTeamCapability(ctx, url.searchParams.get('sessionId')!)), mode: 'native-team',
          members: native && lead ? native.listMembers(lead).filter((member: any) => memberIds.has(member.id)) : [],
          tasks: native && lead ? native.listTasks(lead).filter((task: any) => taskIds.has(task.id)) : [],
          limits: { maxMembers: 4, maxRounds: 1, maxModelStepsPerMember: 16, maxToolCallsPerMember: 24, deadlineMs: 600000, cost: 'unavailable' } } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`Research cycle read failed: ${message}`);
      send(res, 500, { error: 'CYCLE_READ_FAILED', message });
    }
  }

  function handleArtifact(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const rejection = connection.requestRejection(req);
    if (rejection !== undefined) { send(res, rejection, { error: 'AUTH_REQUIRED' }); return; }
    if (req.method !== 'GET') { send(res, 405, { error: 'READ_ONLY' }); return; }
    try {
      const workspace = requireSession(url);
      const researchId = url.searchParams.get('researchId');
      const id = url.searchParams.get('id');
      const sha256 = url.searchParams.get('sha256');
      if (researchId === null || id === null || sha256 === null) {
        send(res, 400, { error: 'REF_REQUIRED', message: 'researchId, id and sha256 are required' });
        return;
      }
      const service = serviceFor(workspace.path);
      const artifact = service.getCycleArtifact(
        { identity: `web-ui:${url.searchParams.get('sessionId')}`, kind: 'user', actionId: null },
        { researchId, ref: { id, sha256 } satisfies ArtifactRef },
      );
      send(res, 200, { schemaVersion: 1, meta: artifact.meta, content: artifact.content });
    } catch (error) {
      if (error instanceof CycleError && ['NOT_FOUND', 'POLICY_DENIED'].includes(error.code)) {
        send(res, 200, { ok: false, error: error.code, message: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`Research cycle artifact read failed: ${message}`);
      send(res, 500, { error: 'CYCLE_ARTIFACT_READ_FAILED', message });
    }
  }

  async function handleTrace(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const rejection = connection.requestRejection(req);
    if (rejection !== undefined) { send(res, rejection, { error: 'AUTH_REQUIRED' }); return; }
    if (req.method !== 'GET') { send(res, 405, { error: 'READ_ONLY' }); return; }
    try {
      const workspace = requireSession(url), researchId = url.searchParams.get('researchId'), memberId = url.searchParams.get('memberId');
      if (!researchId || !memberId) throw new Error('researchId and memberId are required');
      const view = serviceFor(workspace.path).getResearchCycleView({ identity: `web-ui:${url.searchParams.get('sessionId')}`, kind: 'user', actionId: null }, { researchId });
      if (!view.steps.some((step) => step.assignedMemberId === memberId)) throw new Error('Member is outside the selected research run');
      const persistence = ctx.get('sessionPersistence') as any;
      const handle = await persistence.open(memberId, 'read', { signal: AbortSignal.timeout(5000) });
      try {
        const meta = await persistence.stat(memberId);
        const read = await handle.read(Math.max(0, (meta?.eventCount ?? 200) - 200), 200, { signal: AbortSignal.timeout(5000) });
        const calls = new Map<string, string>(read.events.filter((event: any) => event.type === 'tool/call').map((event: any) => [event.data.callId, event.data.name]));
        const events = read.events.filter((event: any) => ['tool/call', 'tool/result', 'step/start', 'step/end', 'turn/end'].includes(event.type)).map((event: any) => ({
          seq: event.seq, type: event.type, turn: event.data.turn, step: event.data.step,
          ...(event.type === 'tool/call' ? { tool: event.data.name, callId: event.data.callId } : {}),
          ...(event.type === 'tool/result' ? { callId: event.data.message.toolCallId, isError: event.data.message.isError, error: event.data.error?.code ?? null,
            errorContext: event.data.message.isError && ['evolver_read_assigned_input', 'evolver_publish_assigned_artifact', 'skill'].includes(calls.get(event.data.message.toolCallId) ?? '')
              ? event.data.message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n').slice(0, 2000) : null } : {}),
        }));
        send(res, 200, { source: 'native-session-event-log', events });
      } finally { await handle.close(); }
    } catch (error) { send(res, 200, { ok: false, error: 'TRACE_READ_FAILED', message: error instanceof Error ? error.message : String(error) }); }
  }

  function handleActions(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const rejection = connection.requestRejection(req);
    if (rejection !== undefined) { send(res, rejection, { error: 'AUTH_REQUIRED' }); return; }
    if (req.method !== 'POST') { send(res, 405, { error: 'POST_ONLY' }); return; }
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); if (raw.length > 512 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const workspace = requireSession(url);
        const sessionId = url.searchParams.get('sessionId')!;
        let body: Record<string, unknown>;
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { send(res, 400, { error: 'INVALID_JSON' }); return; }
        try { assertNoForbiddenFields(body, 'action'); }
        catch (error) { send(res, 400, { error: 'INVALID_INPUT', message: error instanceof Error ? error.message : String(error) }); return; }
        const type = body.type;
        if (typeof type !== 'string' || !(ACTION_TYPES as readonly string[]).includes(type)) {
          send(res, 200, { ok: false, message: '未知的研究循环动作', reason: `unknown action type ${String(type)}`, state: 'rejected' });
          return;
        }
        const operationId = body.operationId;
        if (typeof operationId !== 'string' || operationId.trim().length === 0 || operationId.length > 200) {
          send(res, 200, { ok: false, message: '缺少 operationId', reason: 'operationId is required and reused across retries', state: 'rejected' });
          return;
        }
        const researchId = typeof body.researchId === 'string' ? body.researchId : null;
        if (researchId === null) { send(res, 200, { ok: false, message: '缺少 researchId', state: 'rejected' }); return; }
        const user = { identity: `web-ui:${sessionId}`, kind: 'user' as const, actionId: operationId };
        const service = serviceFor(workspace.path);
        try {
          if (type === 'create_schedule' || type === 'run_schedule' || type === 'stop_schedule') {
            if ('actor' in body || 'identity' in body || body.renewChain !== undefined || body.allowIndependentConcurrency !== undefined) throw new CycleError('POLICY_DENIED', 'Queue actor/grant comes from trusted Host; renewal/concurrency need their separate reviewed entry');
            if (!Number.isSafeInteger(body.cycleRevision) || (body.cycleRevision as number) < 0) throw new CycleError('INVALID_INPUT', 'Queue cycleRevision required');
            if (type !== 'stop_schedule' && (!Number.isSafeInteger(body.baseRevision) || (body.baseRevision as number) < 0)) throw new CycleError('INVALID_INPUT', 'Queue Bootstrap baseRevision required');
            const queue = scheduleFor(workspace.path, researchId);
            if (type === 'create_schedule') {
              const result = queue.create({ operationId, researchId, expectedBootstrapRevision: body.baseRevision as number, expectedCycleRevision: body.cycleRevision as number, ideaId: body.selectedIdeaId as string, tasks: body.tasks as { nodeId: string; sourceIds: string[] }[] }, user.identity);
              send(res, 200, { ok: true, operationId, state: 'final', ...result.result, cycleRevision: result.revision, replayed: result.replayed, message: '有限队列已保存，尚未执行。' }); return;
            }
            if (typeof body.scheduleId !== 'string') throw new CycleError('INVALID_INPUT', 'scheduleId required');
            if (type === 'stop_schedule') {
              const result = queue.stop({ operationId, researchId, scheduleId: body.scheduleId, expectedCycleRevision: body.cycleRevision as number }, user.identity);
              send(res, 200, { ok: true, operationId, state: 'stopped', cycleRevision: result.revision, replayed: result.replayed, message: '队列停止已登记；当前协调器收到取消，实际任务状态需继续读取。' }); return;
            }
            if (body.authorize !== true) throw new CycleError('POLICY_DENIED', 'Explicit queue execution authorization required');
            await ensureNativeLead(sessionId);
            if (!executorsFactory && !cycleTeamCapability(ctx, sessionId).available) throw new CycleError('UNSUPPORTED_CAPABILITY', cycleTeamCapability(ctx, sessionId).reason!);
            const scheduleId = body.scheduleId;
            const owned = new Map<string, ActiveCoordination>();
            const begun = queue.begin({ operationId, researchId, scheduleId, expectedBootstrapRevision: body.baseRevision as number, expectedCycleRevision: body.cycleRevision as number, authorize: true }, user.identity, runId => {
              const executors = executorsFactory ? executorsFactory(workspace.path) : nativeCycleExecutors(ctx, sessionId, runId, 'general', queue.cycles.executionDeadline(researchId, runId));
              const ownership = { service: queue.cycles, runId, researchId, scheduleId }; owned.set(runId, ownership); active.set(runId, ownership); return executors;
            });
            if (!begun.replayed) void begun.completion.catch(error => ctx.logger?.warn?.(`Queue stopped: ${String(error)}`)).finally(() => { for (const [id, value] of owned) if (active.get(id) === value) active.delete(id); });
            send(res, 200, { ok: true, operationId, state: 'queued', scheduleId, replayed: begun.replayed, message: '队列授权已受理；后台按冻结范围推进，页面读取真实完成/停止状态。' }); return;
          }
          if (type !== 'start_cycle' && body.renewChain !== undefined) throw new CycleError('POLICY_DENIED', 'Retry/resume/cancel cannot renew a budget; explicitly start a new user-authorized chain');
          if (type !== 'start_cycle' && body.allowIndependentConcurrency !== undefined) throw new CycleError('POLICY_DENIED', 'Retry/resume cannot expand an existing concurrency grant; authorize a new start');
          if ((type === 'start_cycle' || type === 'retry_cycle' || type === 'resume_cycle') && service.readResearch(researchId).research.general && body.authorize !== true) throw new CycleError('POLICY_DENIED', 'Generic execution/retry requires explicit authorization before attaching the native lead');
          if (type === 'start_cycle' || type === 'retry_cycle' || type === 'resume_cycle') await ensureNativeLead(sessionId);
          if (type === 'start_cycle') {
            if (!executorsFactory && !cycleTeamCapability(ctx, sessionId).available) throw new CycleError('UNSUPPORTED_CAPABILITY', cycleTeamCapability(ctx, sessionId).reason!);
            const selectedIdeaId = body.selectedIdeaId;
            const baseRevision = body.baseRevision;
            const cycleRevision = body.cycleRevision;
            if (typeof selectedIdeaId !== 'string' || !Number.isSafeInteger(baseRevision) || (baseRevision as number) < 0 ||
                !Number.isSafeInteger(cycleRevision) || (cycleRevision as number) < 0) {
              send(res, 200, { ok: false, message: '参数不完整', reason: 'start_cycle needs selectedIdeaId, baseRevision (bootstrap) and cycleRevision', state: 'rejected' });
              return;
            }
            const started = service.startCycle(user, {
              commandId: operationId, researchId, selectedIdeaId, nodeId: body.nodeId as string | undefined, sourceIds: body.sourceIds as string[] | undefined, authorize: body.authorize as boolean | undefined, allowIndependentConcurrency: body.allowIndependentConcurrency as boolean | undefined, renewChain: body.renewChain as { reason: string } | undefined,
              taskDraftId: typeof body.taskDraftId === 'string' ? body.taskDraftId : undefined,
              taskId: typeof body.taskId === 'string' ? body.taskId : null,
              expectedBootstrapRevision: baseRevision as number,
              expectedCycleRevision: cycleRevision as number,
            });
            if (started.replayed) { send(res, 200, { ok: true, operationId, state: 'final', runId: started.runId, replayed: true, message: '启动请求已处理；未重复创建协调器或模型任务，请读取当前运行状态。' }); return; }
            const executors = executorsFactory !== undefined ? executorsFactory(workspace.path) : nativeCycleExecutors(ctx, sessionId, started.runId, service.readResearch(researchId).research.general ? 'general' : 'legacy', service.executionDeadline(researchId, started.runId));
            if (executors !== undefined) {
              const coordinator = { identity: `host-cycle:${started.runId}`, kind: 'coordinator' as const, actionId: operationId };
              active.set(started.runId, { service, runId: started.runId, researchId });
              void service.runCycle(coordinator, researchId, started.runId, { executors })
                .catch((error: unknown) => ctx.logger?.warn?.(`Research cycle ${started.runId} coordination failed: ${String(error)}`))
                .finally(() => { active.delete(started.runId); });
            }
            send(res, 200, {
              ok: true,
              message: executors !== undefined
                ? '研究循环已受理并开始协调（页面轮询读取真实状态）。'
                : '研究循环已受理（等待协调器；页面轮询读取真实状态）。',
              operationId, state: 'queued', runId: started.runId, cycleRevision: started.cycleRevision,
              resultRefs: [{ kind: 'external', key: started.runId, label: `cycle run ${started.runId}` }],
            });
            return;
          }
          if (type === 'retry_cycle' || type === 'resume_cycle') {
            if (typeof body.runId !== 'string' || (type === 'retry_cycle' && typeof body.stepId !== 'string') || !Number.isSafeInteger(body.cycleRevision)) throw new Error('retry_cycle needs runId, stepId and cycleRevision');
            if (active.has(body.runId)) throw new Error('Wait for the live coordinator to stop before retrying');
            const executors = executorsFactory ? executorsFactory(workspace.path) : nativeCycleExecutors(ctx, sessionId, body.runId, service.readResearch(researchId).research.general ? 'general' : 'legacy', service.executionDeadline(researchId, body.runId));
            const coordinator = { identity: `host-cycle:${body.runId}`, kind: 'coordinator' as const, actionId: operationId };
            if (type === 'resume_cycle') service.resumeCycle(coordinator, researchId, { commandId: operationId, runId: body.runId, expectedCycleRevision: body.cycleRevision as number, authorize: body.authorize as boolean | undefined, expectedBootstrapRevision: body.baseRevision as number | undefined });
            else service.retryStep(coordinator, researchId, { commandId: operationId, runId: body.runId, stepId: body.stepId as string, expectedCycleRevision: body.cycleRevision as number, authorize: body.authorize as boolean | undefined, expectedBootstrapRevision: body.baseRevision as number | undefined });
            active.set(body.runId, { service, runId: body.runId, researchId });
            void service.runCycle(coordinator, researchId, body.runId, { executors }).finally(() => active.delete(body.runId as string)).catch((error: unknown) => ctx.logger?.warn?.(`Cycle retry failed: ${String(error)}`));
            send(res, 200, { ok: true, operationId, state: 'queued', runId: body.runId, message: type === 'resume_cycle' ? '未开始的轮次已明确恢复；沿用原 attempt 和预算。' : '已创建新 attempt；历史产物保留。' });
            return;
          }
          // cancel_cycle
          const runId = body.runId;
          if (typeof runId !== 'string') {
            send(res, 200, { ok: false, message: '缺少 runId', state: 'rejected' });
            return;
          }
          const owner = active.get(runId)?.service ?? service;
          if (body.cycleRevision !== undefined && (!Number.isSafeInteger(body.cycleRevision) || (body.cycleRevision as number) < 0)) throw new CycleError('INVALID_INPUT', 'Cancellation cycleRevision must be a nonnegative integer');
          void owner.cancelCycle(user, { commandId: operationId, researchId, runId, expectedCycleRevision: body.cycleRevision as number | undefined })
            .then((outcome) => send(res, 200, { ok: true, message: `循环状态：${outcome.status}`, operationId, state: outcome.status, runId }))
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              ctx.logger?.warn?.(`Research cycle cancel failed: ${message}`);
              send(res, 200, { ok: false, message: '取消被拒绝', reason: message.slice(0, 500), operationId, state: 'rejected' });
            });
          return;
        } catch (error) {
          // Domain rejections are 200 + ok:false so the UI renders the reason honestly.
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger?.warn?.(`Research cycle action ${String(type)} failed: ${message}`);
          send(res, 200, { ok: false, message: '动作被拒绝', reason: message.slice(0, 800), operationId, state: 'rejected' });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger?.warn?.(`Research cycle action route failed: ${message}`);
        send(res, 500, { error: 'CYCLE_ACTION_ROUTE_FAILED', message });
      }
    });
  }
}

export type { CycleRole, CycleRoleExecutor };
