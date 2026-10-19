/** Native task-board bridge; uncertain dispatch never silently creates another task. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExperimentError } from '../../contracts/experiments.ts';
import { canonicalJsonV1, typedHash } from '../../domain/research-canonical.ts';
import { TeamResearchService } from '../../application/team-research-service.ts';
import type { ResearchAgent } from './team-research-runtime.ts';

interface NativeTask {
  id: string; revision: number; subject: string; description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'; ownerName?: string;
  blockedBy: string[]; writeScopes: string[]; ready: boolean;
}
export interface ResearchTaskBoard {
  listTasks(caller: ResearchAgent): NativeTask[];
  createTask(caller: ResearchAgent, request: { subject: string; description: string; blockedBy: string[]; writeScopes: string[] }): Promise<NativeTask>;
  updateTask(caller: ResearchAgent, request: { taskId: string; expectedRevision: number; action: 'claim' }): Promise<NativeTask>;
}

export class DshResearchTaskRouter {
  private readonly directory: string;
  private readonly board: ResearchTaskBoard;
  private readonly service: TeamResearchService;
  private readonly lead: ResearchAgent;

  constructor(directory: string, board: ResearchTaskBoard, service: TeamResearchService, lead: ResearchAgent) {
    service.assertLead(lead);
    if (![board.listTasks, board.createTask, board.updateTask].every((method) => typeof method === 'function')) {
      throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Host task board lacks required APIs');
    }
    this.directory = path.resolve(directory); this.board = board; this.service = service; this.lead = lead;
    fs.mkdirSync(this.directory, { recursive: true });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw new ExperimentError('POLICY_DENIED', 'Routing journal root cannot be a reparse alias');
  }

  async dispatchPrepared(member: ResearchAgent, handoffId: string, signal: AbortSignal): Promise<NativeTask> {
    this.service.assertLead(this.lead);
    const grant = this.service.authorize(member);
    const view = this.service.getTeamResearch(this.lead);
    const handoff = view.handoffs.find((entry) => entry.handoffId === handoffId);
    if (!handoff || handoff.toSessionId !== member.id || handoff.grantId !== grant.grantId) {
      throw new ExperimentError('OWNER_MISMATCH', 'Routing recipient differs from prepared handoff');
    }
    if (!['prepared', 'accepted', 'completed'].includes(handoff.status)) throw new ExperimentError('DEPENDENCY_NOT_READY', 'Handoff is terminal without deliverable');
    if (signal.aborted || Date.now() >= Date.parse(handoff.deadlineAt)) throw new ExperimentError('POLICY_DENIED', 'Routing cancelled or deadline passed');
    handoff.inputRefs.forEach((ref) => this.service.readInput(member, ref));
    const key = typedHash('research-native-dispatch-v1', { grantId: grant.grantId, handoffId });
    const subject = `Research handoff ${key}`;
    const description = canonicalJsonV1({ handoffId, goal: handoff.goal, inputRefs: handoff.inputRefs,
      expectedOutputs: handoff.expectedOutputs, exitCriteria: handoff.exitCriteria, deadlineAt: handoff.deadlineAt });
    const intentPath = path.join(this.directory, `${key}.intent.json`);
    const intentBytes = canonicalJsonV1({ key, handoffId, grantId: grant.grantId, subject, description });
    const lockPath = path.join(this.directory, `${key}.lock`);
    let lock: number;
    try { lock = fs.openSync(lockPath, 'wx'); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ExperimentError('RECONCILIATION_REQUIRED', 'Routing owner is uncertain; retain lock');
      throw error;
    }
    try {
      if (fs.existsSync(intentPath) && (fs.lstatSync(intentPath).isSymbolicLink() || fs.readFileSync(intentPath, 'utf8') !== intentBytes)) {
        throw new ExperimentError('ARTIFACT_CORRUPT', 'Routing intent bytes differ from prepared handoff');
      }
      const matches = this.board.listTasks(this.lead).filter((task) => task.subject === subject);
      if (matches.length > 1) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Native task identity is ambiguous');
      let task = matches[0];
      if (!task) {
        if (fs.existsSync(intentPath) || handoff.status !== 'prepared') {
          throw new ExperimentError('RECONCILIATION_REQUIRED', 'Prior native dispatch cannot be proven absent; refusing duplicate creation');
        }
        const fd = fs.openSync(intentPath, 'wx');
        try { fs.writeFileSync(fd, intentBytes); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        this.service.authorize(member);
        if (signal.aborted) throw new ExperimentError('POLICY_DENIED', 'Cancelled before native task creation');
        task = await this.board.createTask(this.lead, { subject, description, blockedBy: [], writeScopes: [...grant.roleConfiguration.writeRoots] });
      }
      if (task.subject !== subject || task.description !== description || task.blockedBy.length ||
          canonicalJsonV1(task.writeScopes) !== canonicalJsonV1(grant.roleConfiguration.writeRoots)) {
        throw new ExperimentError('SOURCE_MISMATCH', 'Native task differs from pinned handoff');
      }
      this.service.authorize(member);
      if (signal.aborted) throw new ExperimentError('POLICY_DENIED', 'Cancelled before native task claim');
      if (task.status === 'pending' && task.ready) {
        task = await this.board.updateTask(member, { taskId: task.id, expectedRevision: task.revision, action: 'claim' });
      }
      if (task.ownerName !== grant.memberName || !['in_progress', 'completed'].includes(task.status)) {
        throw new ExperimentError('OWNER_MISMATCH', 'Native task was not accepted by delegated member');
      }
      const current = this.service.getTeamResearch(this.lead);
      const latest = current.handoffs.find((entry) => entry.handoffId === handoffId);
      if (!latest || !['prepared', 'accepted', 'completed'].includes(latest.status)) {
        throw new ExperimentError('REVISION_CONFLICT', 'Handoff changed while native acceptance was pending');
      }
      if (latest.status === 'prepared') {
        this.service.recordHandoffAcceptance(this.lead, member, {
          schemaVersion: 1, commandId: `native-accept-${key}`, taskId: grant.taskId, expectedRevision: current.revision,
          policyRef: grant.policyRef, budgetRef: grant.budgetRef,
          payload: { handoffId, nativeTaskId: task.id, nativeTaskRevision: task.revision, ownerSessionId: member.id },
        });
      }
      return task;
    } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
  }
}
