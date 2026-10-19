import { CycleError, cycleRequestHash, type CycleState } from '../contracts/research-cycle.ts';
import type { GeneralSchedule } from '../contracts/general-schedule.ts';
import type { GeneralResearch } from '../contracts/general-research.ts';
import { ResearchBootstrapStore, requireResearch } from './research-bootstrap-store.ts';
import { ResearchCycleStore } from './research-cycle-store.ts';
import { ResearchCycleService } from './research-cycle-service.ts';
import type { CycleRoleExecutor } from './research-cycle-roles.ts';
import type { CycleRole } from '../contracts/research-cycle.ts';
import { freezeGeneralInputs } from './general-cycle-context.ts';
import { assertGeneralSourceAccess } from './general-source-access.ts';
import { object, str, num, list } from '../contracts/general-data.ts';
const coordinator = { kind: 'coordinator' as const, identity: 'approved-schedule-coordinator', actionId: null };
const activeRun = (status: string) => ['queued', 'running', 'waiting_result', 'cancelling'].includes(status);
import { generalScheduleHash } from './general-schedule-context.ts';
export { generalScheduleHash } from './general-schedule-context.ts';
/** Persisted approved finite work, using existing CycleStore/CAS and role execution. */
export class GeneralScheduleService {
  readonly bootstrap: ResearchBootstrapStore;
  readonly cycles: ResearchCycleService;
  private readonly live = new Map<string, AbortController>();
  constructor(bootstrap: ResearchBootstrapStore, cycles: ResearchCycleService) { this.bootstrap = bootstrap; this.cycles = cycles; }
  private store(id: string) { return new ResearchCycleStore(this.bootstrap.workspaceRoot, id); }
  private find(state: CycleState, id: string) { const s = state.schedules.find(s => s.scheduleId === id); if (!s) throw new CycleError('NOT_FOUND', 'Schedule not found in this research'); return s; }
  private context(researchId: string, expected?: number) {
    const state = this.bootstrap.readStateOrEmpty(); if (expected !== undefined && state.revision !== expected) throw new CycleError('REVISION_CONFLICT', 'Bootstrap changed before schedule authorization');
    const g = requireResearch(state, researchId).general; if (!g) throw new CycleError('POLICY_DENIED', 'Scheduling requires generic research'); return { state, g };
  }
  private assertCurrent(g: GeneralResearch, s: GeneralSchedule) {
    if (generalScheduleHash(g, s) !== s.contextHash) throw new CycleError('BASE_GRAPH_CHANGED', 'Frozen queue context changed; create a newly reviewed queue, old authorization cannot expand');
    if (s.deadline && Date.parse(s.deadline) <= Date.now()) throw new CycleError('POLICY_DENIED', 'Frozen schedule deadline elapsed');
    for (const id of new Set(s.tasks.flatMap(t => t.sourceIds))) assertGeneralSourceAccess(g, id);
  }
  create(input: { operationId: string; researchId: string; expectedBootstrapRevision: number; expectedCycleRevision: number; ideaId: string; tasks: { nodeId: string; sourceIds: string[] }[] }, identity: string) {
    num(input.expectedBootstrapRevision, 'expectedBootstrapRevision', 0, Number.MAX_SAFE_INTEGER);
    const { state, g } = this.context(input.researchId, input.expectedBootstrapRevision);
    if (!g.ideas.some(i => i.ideaId === input.ideaId)) throw new CycleError('NOT_FOUND', 'Schedule Idea missing');
    const tasks = list(input.tasks, 'schedule tasks', 10).map(v => { const t = object(v, ['nodeId', 'sourceIds'], 'schedule selection'); return { nodeId: str(t.nodeId, 'nodeId', 200, true), sourceIds: list(t.sourceIds, 'sources', 10).map(id => str(id, 'sourceId', 200, true)) }; });
    if (!tasks.length || tasks.length > g.limits.maxRounds || new Set(tasks.map(t => t.nodeId)).size !== tasks.length) throw new CycleError('POLICY_DENIED', 'Queue task count exceeds current rounds or repeats a node');
    for (const task of tasks) { if (!g.graph.nodes.some(n => n.nodeId === task.nodeId)) throw new CycleError('NOT_FOUND', 'Queue node missing'); freezeGeneralInputs(this.bootstrap.workspaceRoot, input.researchId, g, task.sourceIds, state); }
    return this.store(input.researchId).mutate({ operationId: `schedule-create-${input.operationId}`, researchId: input.researchId, baseRevision: input.expectedCycleRevision, kind: 'create_general_schedule', requestPayload: { ideaId: input.ideaId, tasks }, apply: context => {
      this.context(input.researchId, input.expectedBootstrapRevision);
      const now = context.now(), schedule: GeneralSchedule = { scheduleId: context.mint('schedule'), researchId: input.researchId, ideaId: input.ideaId, contextHash: generalScheduleHash(g, { ideaId: input.ideaId, tasks: tasks.map(t => ({ ...t, taskId: '', runId: null, status: 'pending' })) }), status: 'pending', coordinationRevision: 0, maxTasks: g.limits.maxRounds, deadline: g.limits.deadline, createdAt: now, updatedAt: now, authorizedBy: identity, error: null, stopHistory: [], tasks: tasks.map(t => ({ ...t, taskId: context.mint('schedule-task'), runId: null, status: 'pending' })) };
      context.state.schedules.push(schedule); return { changed: true, result: { scheduleId: schedule.scheduleId, status: schedule.status } };
    } });
  }
  private update(researchId: string, operationId: string, scheduleId: string, grant: number, change: (s: GeneralSchedule) => void, allowStopped = false) {
    const store = this.store(researchId);
    for (let tries = 0; ; tries++) try { return store.mutate({ operationId, researchId, baseRevision: store.readStateOrEmpty().revision, kind: 'advance_general_schedule', requestPayload: { scheduleId, grant }, apply: context => {
      const s = this.find(context.state, scheduleId); if (s.coordinationRevision !== grant || s.status !== 'running' && !(allowStopped && s.status === 'stopped')) throw new CycleError('REVISION_CONFLICT', 'Queue grant is stopped or superseded'); change(s); s.updatedAt = context.now(); return { changed: true, result: { status: s.status } };
    } }); } catch (e) { if (e instanceof CycleError && e.code === 'REVISION_CONFLICT' && tries < 4 && this.find(store.readStateOrEmpty(), scheduleId).status === 'running') continue; throw e; }
  }
  async run(input: { operationId: string; researchId: string; scheduleId: string; expectedBootstrapRevision: number; expectedCycleRevision: number; authorize: boolean }, identity: string, factory: (runId: string) => ReadonlyMap<CycleRole, CycleRoleExecutor>) {
    return this.begin(input, identity, factory).completion;
  }
  begin(input: Parameters<GeneralScheduleService['run']>[0], identity: string, factory: (runId: string) => ReadonlyMap<CycleRole, CycleRoleExecutor>) {
    num(input.expectedBootstrapRevision, 'expectedBootstrapRevision', 0, Number.MAX_SAFE_INTEGER);
    if (input.authorize !== true) throw new CycleError('POLICY_DENIED', 'Queue execution needs explicit current user authorization');
    const store = this.store(input.researchId), { g } = this.context(input.researchId, input.expectedBootstrapRevision);
    const s = this.find(store.readStateOrEmpty(), input.scheduleId); this.assertCurrent(g, s);
    const acquired = store.mutate({ operationId: `schedule-run-${input.operationId}`, researchId: input.researchId, baseRevision: input.expectedCycleRevision, kind: 'run_general_schedule', requestPayload: { scheduleId: input.scheduleId, authorize: true }, apply: context => {
      const q = this.find(context.state, input.scheduleId); if (q.status === 'running' || q.status === 'completed' || context.state.schedules.some(s => s.status === 'running')) throw new CycleError('POLICY_DENIED', 'Queue already running/completed or another queue owns coordination');
      if (context.state.runs.some(r => activeRun(r.status))) throw new CycleError('POLICY_DENIED', 'Stop or complete existing active runs before queue coordination');
      this.assertCurrent(this.context(input.researchId, input.expectedBootstrapRevision).g, q);
      q.status = 'running'; q.coordinationRevision = context.state.revision + 1; q.updatedAt = context.now(); q.error = null; q.authorizedBy = identity;
      return { changed: true, result: { grant: q.coordinationRevision } };
    } });
    if (acquired.replayed) { const status = this.find(store.readStateOrEmpty(), input.scheduleId).status; return { status, replayed: true, completion: Promise.resolve({ status, replayed: true }) }; }
    return { status: 'running' as const, replayed: false, completion: this.coordinate(input, acquired.result.grant, factory) };
  }
  private async coordinate(input: Parameters<GeneralScheduleService['run']>[0], grant: number, factory: (runId: string) => ReadonlyMap<CycleRole, CycleRoleExecutor>) {
    const store = this.store(input.researchId), s = this.find(store.readStateOrEmpty(), input.scheduleId), controller = new AbortController(); this.live.set(input.scheduleId, controller);
    try {
      for (const taskId of s.tasks.map(t => t.taskId)) {
        let q = this.find(store.readStateOrEmpty(), input.scheduleId), task = q.tasks.find(t => t.taskId === taskId)!;
        if (q.status !== 'running' || q.coordinationRevision !== grant) return { status: q.status, replayed: false };
        this.assertCurrent(this.context(input.researchId).g, q);
        if (task.status === 'completed') continue;
        if (!task.runId) {
          this.update(input.researchId, `schedule-starting-${taskId}-${grant}`, q.scheduleId, grant, s => { s.tasks.find(t => t.taskId === taskId)!.status = 'starting'; });
          const started = this.cycles.startCycle(coordinator, { commandId: `schedule-${taskId}`, scheduleTask: { scheduleId: q.scheduleId, taskId, coordinationRevision: grant }, researchId: input.researchId, selectedIdeaId: q.ideaId, nodeId: task.nodeId, sourceIds: task.sourceIds, authorize: true, expectedBootstrapRevision: this.bootstrap.readStateOrEmpty().revision, expectedCycleRevision: store.readStateOrEmpty().revision });
          this.update(input.researchId, `schedule-bind-${taskId}-${grant}`, q.scheduleId, grant, s => { const t = s.tasks.find(t => t.taskId === taskId)!; t.runId = started.runId; t.status = 'running'; });
          task = this.find(store.readStateOrEmpty(), q.scheduleId).tasks.find(t => t.taskId === taskId)!;
        }
        const run = store.readStateOrEmpty().runs.find(r => r.runId === task.runId)!;
        let status = run.status;
        if (status === 'queued') status = (await this.cycles.runCycle(coordinator, input.researchId, run.runId, { executors: factory(run.runId), signal: controller.signal })).status as typeof status;
        if (status !== 'completed') throw new CycleError('POLICY_DENIED', `Scheduled run ${run.runId} stopped as ${status}; retry/reconcile it explicitly before continuing`);
        this.update(input.researchId, `schedule-complete-${taskId}-${grant}`, q.scheduleId, grant, s => { s.tasks.find(t => t.taskId === taskId)!.status = 'completed'; if (s.tasks.every(t => t.status === 'completed')) s.status = 'completed'; });
      }
      return { status: this.find(store.readStateOrEmpty(), input.scheduleId).status, replayed: false };
    } catch (e) {
      const q = this.find(store.readStateOrEmpty(), input.scheduleId);
      if (['running', 'stopped'].includes(q.status) && q.coordinationRevision === grant) this.update(input.researchId, `schedule-stop-${input.operationId}`, q.scheduleId, grant, s => {
        const error = { code: e instanceof CycleError ? e.code : 'SCHEDULE_FAILED', message: (e instanceof Error ? e.message : String(e)).slice(0, 4000) };
        if (s.status === 'running') { s.status = 'stopped'; s.error = error; s.stopHistory.push({ ...error, recordedAt: new Date().toISOString() }); }
        for (const t of s.tasks.filter(t => t.status !== 'completed')) { const run = t.runId ? store.readStateOrEmpty().runs.find(r => r.runId === t.runId) : null; if (run && ['failed', 'cancelled', 'interrupted'].includes(run.status)) t.status = run.status as 'failed' | 'cancelled' | 'interrupted'; else if (!run && t.status === 'starting') t.status = 'blocked'; }
      }, true);
      throw e;
    } finally { if (this.live.get(input.scheduleId) === controller) this.live.delete(input.scheduleId); }
  }
  stop(input: { operationId: string; researchId: string; scheduleId: string; expectedCycleRevision: number }, identity: string) {
    const store = this.store(input.researchId);
    const result = store.mutate({ operationId: `schedule-stop-user-${input.operationId}`, researchId: input.researchId, baseRevision: input.expectedCycleRevision, kind: 'stop_general_schedule', requestPayload: { scheduleId: input.scheduleId }, apply: context => {
      const s = this.find(context.state, input.scheduleId); if (s.status === 'completed') throw new CycleError('POLICY_DENIED', 'Completed queue cannot be stopped');
      s.status = 'stopped'; s.updatedAt = context.now(); s.error = { code: 'USER_STOPPED', message: `Stopped by ${identity}` }; s.stopHistory.push({ ...s.error, recordedAt: context.now() });
      return { changed: true, result: { status: s.status } };
    } });
    if (!result.replayed) this.live.get(input.scheduleId)?.abort(); return result;
  }
  sweep(researchId: string) {
    const store = this.store(researchId), state = store.readStateOrEmpty();
    const needsSweep = (s: GeneralSchedule, state: CycleState) => s.status === 'running' || s.status !== 'completed' && s.tasks.some(t => !t.runId && state.receipts.some(r => r.operationId === `start-schedule-${t.taskId}`));
    if (!state.schedules.some(s => needsSweep(s, state))) return;
    return store.mutate({ operationId: `schedule-restart-${state.revision}`, researchId, baseRevision: state.revision, kind: 'interrupt_general_schedules', requestPayload: { observedRevision: state.revision }, apply: context => {
      for (const s of context.state.schedules.filter(s => needsSweep(s, context.state))) {
        const wasRunning = s.status === 'running'; let recovered = false;
        for (const t of s.tasks) {
          // Earlier queue versions registered a run before a separate binding write.
          if (!t.runId && (t.status === 'starting' || context.state.receipts.some(r => r.operationId === `start-schedule-${t.taskId}`))) {
            const receipt = context.state.receipts.find(r => r.operationId === `start-schedule-${t.taskId}`);
            if (receipt) {
              const runId = receipt.result.runId;
              const run = context.state.runs.find(r => r.runId === runId);
              if (!run || run.nodeId !== t.nodeId || run.selectedIdeaRef?.ideaId !== s.ideaId || run.mode !== 'general') throw new CycleError('STATE_CORRUPT', 'Unbound scheduled receipt does not match its queue task');
              const payload = { op: 'start_cycle', researchId, selectedIdeaId: s.ideaId, taskId: run.taskId, ideaContentHash: run.selectedIdeaRef.contentHash, nodeId: t.nodeId, sourceIds: t.sourceIds };
              if (receipt.requestHash !== cycleRequestHash(payload) && receipt.requestHash !== cycleRequestHash({ ...payload, scheduleTask: { scheduleId: s.scheduleId, taskId: t.taskId } })) throw new CycleError('STATE_CORRUPT', 'Scheduled receipt scope hash differs from queue');
              t.runId = run.runId;
              recovered = true;
            } else t.status = 'pending';
          }
          const run = t.runId ? context.state.runs.find(r => r.runId === t.runId) : null;
          if (run && ['interrupted', 'failed', 'cancelled'].includes(run.status)) t.status = run.status as 'interrupted' | 'failed' | 'cancelled';
          else if (run?.status === 'completed') t.status = 'completed';
          else if (run) t.status = 'running';
        }
        s.status = s.tasks.every(t => t.status === 'completed') ? 'completed' : 'stopped';
        if (s.status === 'completed') s.error = null;
        else if (wasRunning) s.error = { code: 'HOST_RESTARTED', message: 'Coordinator interrupted; explicitly authorize recovery after reconciling native jobs' };
        if (wasRunning && s.error) s.stopHistory.push({ ...s.error, recordedAt: context.now() });
        if (!wasRunning && recovered) s.stopHistory.push({ code: 'RECOVERED_RUN_BINDING', message: 'Recovered the original registered run; previous stop reason and execution grant remain unchanged', recordedAt: context.now() });
        s.updatedAt = context.now();
      }
      return { changed: true, result: { status: 'stopped' } };
    } });
  }
}
