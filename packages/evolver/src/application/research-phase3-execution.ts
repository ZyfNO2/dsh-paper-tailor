import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExperimentError, expAssertArtifactRef, expNoExtraKeys, type ArtifactRef } from '../contracts/experiments.ts';
import { validateResearchCommand, type ResearchCommandReceipt } from '../contracts/research-command.ts';
import { canonicalJsonV1, typedHash } from '../domain/research-canonical.ts';
import { ResearchExperimentPlanService, type ResearchExperimentPlan } from './research-experiment-plan-service.ts';
import type { Phase3Service } from './phase3-service.ts';
import { RootBudgetLedger } from './research-budget.ts';
import type { CallerActor } from './index.ts';

/** Trusted installation maps ready research plans to an already frozen Phase 3 candidate, never user argv. */
export interface Phase3ResearchBinding {
  taskId: string; searchId: string; candidateId: string; freezeOperationId: string; protocolRef: ArtifactRef;
  schemeRef: ArtifactRef; configRef: ArtifactRef; conditionsRef: ArtifactRef; components: ResearchExperimentPlan['components']; runnerId: string;
  constraints: ResearchExperimentPlan['constraints'];
}
export class ResearchPhase3ExecutionService {
  private readonly options: { directory: string; taskId: string; policyRef: ArtifactRef; budgetRef: ArtifactRef; plans: ResearchExperimentPlanService; ledger: RootBudgetLedger;
    phase3: Pick<Phase3Service, 'runSearchCandidate' | 'cancelRun' | 'getOperation' | 'getOperationForResearchCommand'>;
    actorFor(caller: unknown, mutation: boolean): CallerActor; bindings: ReadonlyMap<string, Phase3ResearchBinding>;
    readFrozenProtocol(caller: unknown, freezeOperationId: string, ref: ArtifactRef): Buffer;
  };
  constructor(options: ResearchPhase3ExecutionService['options']) { this.options = { ...options, bindings: new Map([...options.bindings].map(([key, value]) => [key, structuredClone(value)])) }; fs.mkdirSync(options.directory, { recursive: true }); }
  async executeExperiment(caller: unknown, raw: unknown): Promise<ResearchCommandReceipt> {
    const actor = this.options.actorFor(caller, true), command = validateResearchCommand(raw, (payload) => {
      const p = expNoExtraKeys(payload, ['planRef'], 'execute input'); return { planRef: expAssertArtifactRef(p.planRef, 'planRef') };
    });
    if (command.taskId !== this.options.taskId || canonicalJsonV1(command.policyRef) !== canonicalJsonV1(this.options.policyRef) || canonicalJsonV1(command.budgetRef) !== canonicalJsonV1(this.options.budgetRef)) throw new ExperimentError('POLICY_DENIED', 'Execution command differs from installed task/policy/budget');
    const requestHash = typedHash('research-phase3-execution-command-v1', { command, sessionId: actor.sessionId }), operationId = typedHash('research-phase3-execution-id-v1', { commandId: command.commandId, taskId: command.taskId, sessionId: actor.sessionId }), intentFile = path.join(this.options.directory, `${operationId}.json`);
    if (fs.existsSync(intentFile)) {
      const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8')) as { requestHash: string };
      if (intent.requestHash !== requestHash) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Execution envelope changed');
      const previous = this.options.phase3.getOperationForResearchCommand(command.taskId, command.commandId, actor);
      if (!previous || ['accepted', 'running', 'interrupted'].includes(previous.status)) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Execution intent has no reconciled terminal Phase 3 operation; no redispatch');
      if (previous.status !== 'succeeded' || !previous.resultRef) throw new ExperimentError('INVALID_RESULT', previous.error?.message ?? `Existing execution is ${previous.status}`);
      return { schemaVersion: 1, status: 'succeeded', receipt: { operationId: previous.id, commandId: command.commandId, requestHash: previous.requestHash, taskRevision: command.expectedRevision }, resultRefs: [previous.resultRef], error: null };
    }
    if (command.expectedRevision !== this.options.plans.listExperimentPlans(caller).revision) throw new ExperimentError('REVISION_CONFLICT', 'Execution plan store revision differs');
    const plan = this.options.plans.assertExecutablePlan(caller, command.payload.planRef), binding = this.options.bindings.get(plan.planKey);
    if (!binding) throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Ready plan has no installed Phase 3 frozen candidate binding');
    const expected = { taskId: binding.taskId, schemeRef: binding.schemeRef, configRef: binding.configRef, conditionsRef: binding.conditionsRef, protocolRef: binding.protocolRef, components: binding.components, runnerId: binding.runnerId, constraints: binding.constraints };
    const actual = { taskId: plan.taskId, schemeRef: plan.schemeRef, configRef: plan.configRef, conditionsRef: plan.conditionsRef, protocolRef: plan.protocolRef, components: plan.components, runnerId: plan.runnerId, constraints: plan.constraints };
    if (canonicalJsonV1(expected) !== canonicalJsonV1(actual)) throw new ExperimentError('SOURCE_MISMATCH', 'Plan parameters or pins differ from the installed execution binding');
    const frozen = this.options.phase3.getOperation(binding.freezeOperationId, actor);
    if (frozen.taskId !== plan.taskId || frozen.method !== 'freezeExperiment' || frozen.status !== 'succeeded' || canonicalJsonV1(frozen.resultRef) !== canonicalJsonV1(binding.protocolRef)) throw new ExperimentError('DEPENDENCY_NOT_READY', 'Protocol is not an owned successful frozen Phase 3 operation');
    const bytes = this.options.readFrozenProtocol(caller, binding.freezeOperationId, binding.protocolRef);
    if (createHash('sha256').update(bytes).digest('hex') !== binding.protocolRef.sha256) throw new ExperimentError('ARTIFACT_CORRUPT', 'Frozen execution protocol bytes changed');
    const published = JSON.parse(bytes.toString('utf8')) as { protocol?: { taskId?: string; variants?: Array<{ id: string }> } };
    if (published.protocol?.taskId !== plan.taskId || !published.protocol.variants?.some((variant) => variant.id === binding.candidateId)) throw new ExperimentError('SOURCE_MISMATCH', 'Bound candidate does not exist in the registered protocol');
    const fd = fs.openSync(intentFile, 'wx'); try { fs.writeFileSync(fd, canonicalJsonV1({ schemaVersion: 1, command, requestHash, sessionId: actor.sessionId, planRef: command.payload.planRef })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const result = await this.options.phase3.runSearchCandidate({ commandId: command.commandId, taskId: command.taskId, expectedRevision: command.expectedRevision,
      searchId: binding.searchId, attemptId: `research-${command.commandId}`, candidateId: binding.candidateId }, actor, this.options.ledger);
    const operation = this.options.phase3.getOperation(result.receipt.operationId, actor);
    if (operation.status !== 'succeeded' || !operation.resultRef || canonicalJsonV1(operation.resultRef) !== canonicalJsonV1(result.campaignReportRef)) throw new ExperimentError('INVALID_RESULT', `Execution is ${operation.status}; a receipt does not establish a successful campaign`);
    return { schemaVersion: 1, status: 'succeeded', receipt: result.receipt, resultRefs: [result.campaignReportRef], error: null };
  }
  async cancel(caller: unknown, payload: Parameters<Phase3Service['cancelRun']>[0]) {
    const actor = this.options.actorFor(caller, true);
    if (payload.taskId !== this.options.taskId) throw new ExperimentError('POLICY_DENIED', 'Cancellation task differs');
    const result = await this.options.phase3.cancelRun(payload, actor); // SAME service holding the actual runner.
    return { ...result, operation: this.options.phase3.getOperation(payload.operationId, actor) };
  }
  getExperiment(caller: unknown, operationId: string) { return this.options.phase3.getOperation(operationId, this.options.actorFor(caller, false)); }
}
