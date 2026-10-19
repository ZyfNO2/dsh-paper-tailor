import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ExperimentError, expAssertArtifactRef, expNoExtraKeys, type ArtifactRef, type LightweightProtocol } from '../contracts/experiments.ts';
import { validateResearchCommand, type ResearchCommandReceipt } from '../contracts/research-command.ts';
import type { SearchExecutionIdentity, SearchNode } from '../contracts/search.ts';
import { canonicalJsonV1, parseJsonStrictV1, typedHash } from '../domain/research-canonical.ts';
import { LightweightRunner, type RunnerOptions, type ExecutionFacts } from '../domain/lightweight-runner.ts';
import { directoryBytes } from '../domain/task-profile.ts';
import { SearchStateStore } from './search-state-store.ts';
import { RootBudgetLedger } from './research-budget.ts';
import { buildSearchFeedbackPack, selectNextMutation, buildSearchProposalInput, buildScriptedProposalReceipt, candidateDraftFromReceipt,
  type SearchMetricEvidenceRefInput, type SearchCostFactInput } from './search-feedback-orchestration.ts';
import { assertGenerationContext, type GenerationContextPack } from './research-generation-context.ts';
import { PublishedResearchObservationReader } from './research-observation-reader.ts';

export interface ResearchLoopRound {
  round: number; nodeId: string; contextRef: ArtifactRef; proposalBindingRef: ArtifactRef; observationRef: ArtifactRef;
  writebackRefs: ArtifactRef[]; executionFacts: ExecutionFacts[]; decisionRefs: ArtifactRef[];
}
export type ResearchLeafOutput = Awaited<ReturnType<LightweightRunner['executeOne']>>;
interface LoopOperation {
  schemaVersion: 1; operationId: string; commandId: string; requestHash: string; taskId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled'; rounds: ResearchLoopRound[]; decisionRefs: ArtifactRef[];
  activeNodeId: string | null; activeAttemptId: string | null; firstError: { code: string; message: string } | null;
  resultRef: ArtifactRef | null;
  finalSearchRevision?: number;
}
export interface ResearchLoopOptions {
  directory: string; taskId: string; policyRef: ArtifactRef; budgetRef: ArtifactRef; store: SearchStateStore; budget: RootBudgetLedger;
  /** Checks actual caller identity on every command/query. */
  authorize(caller: unknown, mutation: boolean): void;
  reader: PublishedResearchObservationReader;
  baselineActualExecutionMs: number;
  /** Registry-bound adapter: no interpreter/runner path comes from a request. */
  prepare(caller: unknown, node: SearchNode, context: GenerationContextPack, contextRef: ArtifactRef, attemptId: string): Promise<{
    runnerOptions: RunnerOptions; protocol: LightweightProtocol; identity: SearchExecutionIdentity; executableRef: ArtifactRef;
  }>;
  context(caller: unknown, round: number, decisionRef: ArtifactRef, budgetSnapshot: Record<string, unknown>, previous: ResearchLoopRound[]): GenerationContextPack;
  /** Independently recompute metrics, register actual raw/facts/cost publications and return observation ref. */
  verifyAndPublish(caller: unknown, attemptId: string, output: ResearchLeafOutput[], executableRef: ArtifactRef): ArtifactRef;
  writeback(caller: unknown, observationRef: ArtifactRef): ResearchCommandReceipt;
  /** Failure observation/diagnostic publication must preserve the actual first error and output. */
  publishFailure(caller: unknown, attemptId: string, output: ResearchLeafOutput[], error: { code: string; message: string }): ArtifactRef;
}
const same = (a: unknown, b: unknown) => canonicalJsonV1(a) === canonicalJsonV1(b);

/** One serial coordinator; SearchStateStore and RootBudgetLedger remain the only tree/budget facts. */
export class ResearchLoopService {
  private readonly options: ResearchLoopOptions;
  private readonly active = new Map<string, { controller: AbortController; completion: Promise<ResearchCommandReceipt> }>();
  constructor(options: ResearchLoopOptions) {
    this.options = options;
    fs.mkdirSync(path.join(options.directory, 'operations'), { recursive: true }); fs.mkdirSync(path.join(options.directory, 'records'), { recursive: true }); fs.mkdirSync(path.join(options.directory, 'requests'), { recursive: true });
  }
  private publish(value: unknown): ArtifactRef {
    const bytes = Buffer.from(canonicalJsonV1(value)), sha256 = createHash('sha256').update(bytes).digest('hex'), id = `records/${sha256}.json`;
    const file = path.join(this.options.directory, id);
    if (fs.existsSync(file)) { if (!fs.readFileSync(file).equals(bytes)) throw new ExperimentError('ARTIFACT_CORRUPT', 'Loop publication changed'); }
    else { const fd = fs.openSync(file, 'wx'); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    return { id, sha256 };
  }
  private save(operation: LoopOperation): void {
    const file = path.join(this.options.directory, 'operations', `${operation.operationId}.json`), temporary = `${file}.pending`;
    const fd = fs.openSync(temporary, 'wx'); try { fs.writeFileSync(fd, canonicalJsonV1(operation)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  }
  private receipt(operation: LoopOperation): ResearchCommandReceipt {
    return { schemaVersion: 1, status: operation.status === 'completed' ? 'succeeded' : 'failed',
      error: operation.firstError ? { ...operation.firstError, fieldPaths: [] } : null,
      resultRefs: operation.resultRef ? [operation.resultRef] : [], receipt: { operationId: operation.operationId, commandId: operation.commandId,
        requestHash: operation.requestHash, taskRevision: operation.finalSearchRevision ?? this.options.store.getRevision() } };
  }
  startResearchLoop(caller: unknown, raw: unknown): Promise<ResearchCommandReceipt> {
    this.options.authorize(caller, true);
    const command = validateResearchCommand(raw, (payload) => { const p = expNoExtraKeys(payload, ['planRef'], 'loop input'); return { planRef: expAssertArtifactRef(p.planRef, 'planRef') }; });
    const plan = this.options.store.getPlan();
    if (command.taskId !== this.options.taskId || plan.taskId !== command.taskId || !same(command.policyRef, this.options.policyRef) || !same(command.budgetRef, this.options.budgetRef) || !same(command.payload.planRef, plan.planRef)) throw new ExperimentError('POLICY_DENIED', 'Loop command differs from frozen task/plan/policy/budget');
    const requestHash = typedHash('research-loop-command-v1', command), operationId = typedHash('research-loop-operation-v1', { taskId: command.taskId, commandId: command.commandId });
    const file = path.join(this.options.directory, 'operations', `${operationId}.json`);
    if (fs.existsSync(file)) {
      const old = this.getOperation(caller, operationId);
      if (old.requestHash !== requestHash) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Loop command was changed');
      if (old.status === 'running') { const live = this.active.get(operationId); if (!live) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Persisted lease has no live coordinator; budget cannot be refunded or execution restarted'); return live.completion; }
      return Promise.resolve(this.receipt(old));
    }
    if (this.active.size) throw new ExperimentError('HOST_BUSY', 'Task already has an active serial loop');
    if (command.expectedRevision !== this.options.store.getRevision()) throw new ExperimentError('REVISION_CONFLICT', 'Search revision differs');
    const controller = new AbortController();
    const operation: LoopOperation = { schemaVersion: 1, operationId, commandId: command.commandId, requestHash, taskId: command.taskId,
      status: 'running', rounds: [], decisionRefs: [], activeNodeId: null, activeAttemptId: null, firstError: null, resultRef: null };
    const lockPath = path.join(this.options.directory, 'loop.lock');
    let lock: number;
    try { lock = fs.openSync(lockPath, 'wx'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ExperimentError('RECONCILIATION_REQUIRED', 'Serial loop lease is already held'); throw error; }
    this.save(operation);
    const completion = this.run(caller, operation, controller).finally(() => { this.active.delete(operationId); fs.closeSync(lock); fs.unlinkSync(lockPath); });
    this.active.set(operationId, { controller, completion });
    return completion;
  }
  private decision(action: 'select' | 'expand' | 'retain' | 'prune' | 'repair' | 'stop', nodeId: string | null, reason: string, evidenceRefs: ArtifactRef[], subsequentRef: ArtifactRef | null = null): ArtifactRef {
    const plan = this.options.store.getPlan(), nodes = this.options.store.getNodes(), budget = this.options.budget.snapshot();
    return this.publish({ schemaVersion: 1, taskId: plan.taskId, action, nodeId, reasonCodes: [reason], reason,
      basisRevision: this.options.store.getRevision(), treeHash: typedHash('search-tree-v1', nodes), evidenceRefs,
      constraints: { maxNodes: plan.limits.maxNodes, maxDepth: plan.limits.maxDepth, testAccess: 'forbidden', budgetExceeded: budget.budgetExceeded },
      budgetRef: plan.rootBudgetRef, budgetHash: budget.ledgerHash, policyRef: this.options.policyRef, subsequentRef });
  }
  private async run(caller: unknown, operation: LoopOperation, controller: AbortController): Promise<ResearchCommandReceipt> {
    const plan = this.options.store.getPlan(); let output: ResearchLeafOutput[] = [];
    try {
      const startRound = Math.max(0, ...this.options.store.getNodes().map((node) => node.round)) + 1;
      for (let round = startRound; round <= plan.limits.requiredRounds; round++) {
        this.options.authorize(caller, true);
        if (controller.signal.aborted) throw new ExperimentError('POLICY_DENIED', 'Loop cancelled before next trial');
        const evidence: SearchMetricEvidenceRefInput[] = operation.rounds.flatMap((entry) => {
          const observation = this.options.reader.readObservation(caller, entry.observationRef);
          return observation.metrics.map((metric) => ({ nodeId: entry.nodeId, seed: metric.seed, metricId: metric.metricId, verifiedRef: observation.verifierRef! }));
        });
        const costs: SearchCostFactInput[] = [{ nodeId: 'baseline', costRef: plan.baseline.costRef, actualExecutionMs: this.options.baselineActualExecutionMs }, ...operation.rounds.map((entry) => ({ nodeId: entry.nodeId,
          costRef: this.options.reader.readObservation(caller, entry.observationRef).costRef, actualExecutionMs: entry.executionFacts.reduce((sum, facts) => sum + facts.durationMs, 0) }))];
        const store = this.options.store;
        const pack = buildSearchFeedbackPack(plan, store.getNodes(), { round, basisRevision: store.getRevision(), records: store.getFeedbackRecords(), metricEvidenceRefs: evidence, costFacts: costs });
        const packRef = store.recordFeedbackRecord(pack).ref;
        const selection = selectNextMutation(plan, pack, packRef, store.getRevision()), selectionRef = store.recordFeedbackRecord(selection).ref;
        if (!selection.selected) { operation.decisionRefs.push(this.decision('stop', null, selection.stopReason!, [selectionRef])); break; }
        const selectRef = this.decision('select', selection.selected.parentNodeId, selection.selected.selectionReason, [packRef, selectionRef]);
        operation.decisionRefs.push(selectRef);
        const context = assertGenerationContext(this.options.context(caller, round, selectRef, this.options.budget.snapshot(), operation.rounds));
        if (context.taskId !== plan.taskId || context.round !== round || context.proposalSource !== 'scripted_fixture') throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'This deterministic coordinator requires a correctly scoped scripted proposal profile; live provider must use the budgeted Team route');
        for (const previous of operation.rounds) if (!context.entries.some((entry) => same(entry.ref, previous.observationRef))) throw new ExperimentError('DEPENDENCY_NOT_READY', 'Generation input omitted previous verified observation');
        const contextRef = this.publish(context);
        const input = buildSearchProposalInput(plan, pack, packRef, selection, selectionRef, store.getRevision()), inputRef = store.recordFeedbackRecord(input).ref;
        const proposal = buildScriptedProposalReceipt(input, inputRef, selection, store.getRevision()), proposalRef = store.recordFeedbackRecord(proposal).ref;
        const bindingRef = this.publish({ schemaVersion: 1, source: 'scripted_fixture', actualModelCalls: 0, roleConfigurationRef: null, contextRef, inputRef, proposalRef,
          consumedInputHash: contextRef.sha256, outputHash: typedHash('research-proposal-output-v1', proposal.result), costRef: this.publish({ modelCalls: 0, inputTokens: 0, outputTokens: 0 }), firstErrorRef: null });
        const candidate = candidateDraftFromReceipt(proposal, proposalRef, [packRef, selectionRef, inputRef, proposalRef, contextRef, bindingRef,
          ...pack.eligibleParents.flatMap((parent) => [parent.costRef, ...parent.resultRefs, ...parent.metricEvidence.map((metric) => metric.verifiedRef)]), ...context.entries.map((entry) => entry.ref)]);
        const registered = store.registerCandidate(candidate);
        if (registered.duplicateOf) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Selected candidate duplicates previous proposal');
        const nodeId = registered.node.nodeId, attemptId = `attempt-${operation.operationId.slice(0, 12)}-r${round}`;
        operation.activeNodeId = nodeId; operation.activeAttemptId = attemptId; this.save(operation);
        store.transitionNode(nodeId, 'adapting');
        const prepared = await this.options.prepare(caller, registered.node, context, contextRef, attemptId);
        if (controller.signal.aborted) throw new ExperimentError('POLICY_DENIED', 'Loop cancelled during checks');
        store.transitionNode(nodeId, 'checking');
        const bound = store.bindExecution(nodeId, { identity: prepared.identity, executableRef: prepared.executableRef, phase3OperationId: `redesign-${attemptId}`, phase2OperationId: `leaf-${attemptId}` });
        if (bound.duplicateOf) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Selected candidate duplicates previous execution');
        if (!same(prepared.protocol.seeds, plan.experimentTemplate.pairedSeeds) || prepared.protocol.profileRef !== plan.experimentTemplate.profileRef || !same(prepared.protocol.dataSubsetRef, plan.experimentTemplate.dataSubsetRef)) throw new ExperimentError('SOURCE_MISMATCH', 'Prepared protocol differs from frozen seed/profile/data pins');
        const reservation = this.options.budget.reserveSweep({ reservationId: attemptId, attemptId, plannedTrials: plan.experimentTemplate.pairedSeeds.length, device: prepared.runnerOptions.device, serial: true });
        operation.decisionRefs.push(this.decision('expand', nodeId, 'frozen_prefix_checks_and_root_reservation_passed', [contextRef, prepared.executableRef], bindingRef));
        this.save(operation); store.transitionNode(nodeId, 'evaluating');
        const runner = new LightweightRunner({ ...prepared.runnerOptions, abortSignal: controller.signal,
          timeoutMs: Math.min(prepared.runnerOptions.timeoutMs, Math.floor(reservation.maxExecutionMs / reservation.plannedTrials)), resourceLimits: { maxWorkingSetBytes: reservation.maxMemoryBytes, maxOutputBytes: reservation.maxOutputBytesPerTrial } });
        const runDir = path.join(this.options.directory, 'runs', attemptId);
        for (const seed of plan.experimentTemplate.pairedSeeds) {
          if (controller.signal.aborted) break;
          const leaf = await runner.executeOne({ variant: candidate.candidateId, seed, runId: `${attemptId}-s${seed}` }, prepared.protocol, path.join(runDir, `seed-${seed}`));
          output.push(leaf);
          if (leaf.facts.exitCode !== 0 || leaf.facts.timedOut || leaf.facts.resourceLimitExceeded) break;
        }
        if (!output.length || output.some((leaf) => !leaf.facts.resourceSampleCount || leaf.facts.peakWorkingSetBytes === undefined)) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Execution lacks authoritative resource samples; reservation remains charged');
        const violations = this.options.budget.settleSweep(attemptId, { attemptedTrials: output.length, executionMs: output.reduce((sum, leaf) => sum + leaf.facts.durationMs, 0), stagedOutputBytes: directoryBytes(runDir), peakWorkingSetBytes: output.map((leaf) => leaf.facts.peakWorkingSetBytes!), executionFactsComplete: true });
        if (controller.signal.aborted) throw new ExperimentError('POLICY_DENIED', 'Loop cancelled; actual runner returned terminal execution facts');
        if (violations.length) throw new ExperimentError('BUDGET_EXHAUSTED', `Runner exceeded ${violations.join(', ')}`);
        for (const leaf of output) runner.verifyFacts(leaf.facts, leaf.rawResult);
        if (output.length !== plan.experimentTemplate.pairedSeeds.length) throw new ExperimentError('INVALID_RESULT', 'Paired sweep is incomplete');
        const observationRef = this.options.verifyAndPublish(caller, attemptId, output, prepared.executableRef), observation = this.options.reader.readObservation(caller, observationRef);
        if (observation.verification !== 'verified' || observation.attemptId !== attemptId || observation.metrics.some((metric) => metric.split !== 'validation') || !same(observation.executableRef, prepared.executableRef) || !same(observation.dataRef, plan.experimentTemplate.dataSubsetRef)) throw new ExperimentError('SOURCE_MISMATCH', 'Verified observation differs from frozen execution');
        store.recordVerifiedEvaluation(nodeId, { outcome: 'eligible', resultRefs: [observationRef, observation.verifierRef!, ...observation.rawResultRefs], costRef: observation.costRef, verifierRef: observation.verifierRef!,
          metricValues: observation.metrics.map((metric) => ({ seed: metric.seed, metricId: metric.metricId, value: metric.value!, unit: metric.unit, split: 'validation' })) });
        const writeback = this.options.writeback(caller, observationRef);
        if (writeback.status !== 'succeeded') throw new ExperimentError('RECONCILIATION_REQUIRED', 'Verified observation writeback is incomplete');
        const retain = this.decision('retain', nodeId, 'independently_verified_development_result', [observationRef, ...writeback.resultRefs]);
        operation.decisionRefs.push(retain); operation.rounds.push({ round, nodeId, contextRef, proposalBindingRef: bindingRef, observationRef,
          writebackRefs: writeback.resultRefs, executionFacts: output.map((leaf) => leaf.facts), decisionRefs: [selectRef, retain] });
        operation.activeNodeId = null; operation.activeAttemptId = null; output = []; this.save(operation);
      }
      operation.decisionRefs.push(this.decision('stop', null, 'frozen_required_rounds_or_prefix_space_complete', operation.rounds.map((entry) => entry.observationRef)));
      operation.status = 'completed';
    } catch (error) {
      const firstError = { code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error) };
      operation.firstError = firstError; operation.status = controller.signal.aborted ? 'cancelled' : 'failed';
      this.save(operation);
      if (operation.activeNodeId && operation.activeAttemptId) {
        const diagnostic = this.options.publishFailure(caller, operation.activeAttemptId, output, firstError);
        const current = this.options.store.getNodes().find((entry) => entry.nodeId === operation.activeNodeId)!;
        if (['proposed', 'adapting', 'checking', 'evaluating'].includes(current.status)) this.options.store.transitionNode(current.nodeId, operation.status === 'cancelled' ? 'cancelled' : 'failed', { ...firstError, diagnosticRef: diagnostic });
        operation.decisionRefs.push(this.decision('prune', current.nodeId, 'technical_failure_preserves_history', [diagnostic]));
      }
      operation.decisionRefs.push(this.decision('stop', operation.activeNodeId, operation.status, []));
    }
    operation.finalSearchRevision = this.options.store.getRevision(); operation.resultRef = this.publish(operation); this.save(operation); return this.receipt(operation);
  }
  getOperation(caller: unknown, operationId: string): LoopOperation {
    this.options.authorize(caller, false);
    if (!/^[0-9a-f]{64}$/.test(operationId)) throw new ExperimentError('SCHEMA_VIOLATION', 'Invalid loop operation ID');
    const record = parseJsonStrictV1(fs.readFileSync(path.join(this.options.directory, 'operations', `${operationId}.json`), 'utf8')) as unknown as LoopOperation;
    if (record.operationId !== operationId || record.taskId !== this.options.taskId || record.schemaVersion !== 1) throw new ExperimentError('ARTIFACT_CORRUPT', 'Loop operation identity differs');
    return record;
  }
  async cancel(caller: unknown, operationId: string): Promise<ResearchCommandReceipt> {
    this.options.authorize(caller, true); const live = this.active.get(operationId);
    if (!live) { const persisted = this.getOperation(caller, operationId); if (persisted.status === 'running') throw new ExperimentError('RECONCILIATION_REQUIRED', 'Cannot cancel a missing actual coordinator'); return this.receipt(persisted); }
    live.controller.abort(); return live.completion;
  }
  reconcile(caller: unknown, operationId: string): LoopOperation {
    const record = this.getOperation(caller, operationId);
    if (record.status === 'running' && !this.active.has(operationId)) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Lost runtime lease needs authoritative process and budget reconciliation');
    return record;
  }
  listOperations(caller: unknown): LoopOperation[] {
    this.options.authorize(caller, false);
    return fs.readdirSync(path.join(this.options.directory, 'operations')).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).map((name) => this.getOperation(caller, name.slice(0, -5)));
  }
  /** Records an authorized request; it never masquerades as an already executed mutation. */
  requestBranchDecision(caller: unknown, raw: unknown): ResearchCommandReceipt {
    this.options.authorize(caller, true);
    const command = validateResearchCommand(raw, (payload) => {
      const p = expNoExtraKeys(payload, ['action', 'nodeId', 'reason', 'evidenceRefs'], 'branch request');
      if (!['select', 'expand', 'prune', 'retain', 'repair', 'stop'].includes(String(p.action)) || typeof p.reason !== 'string' || !p.reason.trim() || p.nodeId !== null && typeof p.nodeId !== 'string' || !Array.isArray(p.evidenceRefs)) throw new ExperimentError('SCHEMA_VIOLATION', 'Invalid branch action/reason/target/evidence');
      return { action: p.action as 'select' | 'expand' | 'prune' | 'retain' | 'repair' | 'stop', nodeId: p.nodeId as string | null, reason: p.reason, evidenceRefs: p.evidenceRefs.map((ref) => expAssertArtifactRef(ref, 'branch evidence')) };
    });
    if (command.taskId !== this.options.taskId || !same(command.policyRef, this.options.policyRef) || !same(command.budgetRef, this.options.budgetRef)) throw new ExperimentError('POLICY_DENIED', 'Branch request policy/task/budget differs');
    const requestHash = typedHash('research-branch-request-v1', command), id = typedHash('research-branch-request-id-v1', { commandId: command.commandId, taskId: command.taskId });
    const file = path.join(this.options.directory, 'requests', `${id}.json`);
    if (fs.existsSync(file)) {
      const old = parseJsonStrictV1(fs.readFileSync(file, 'utf8')) as unknown as ResearchCommandReceipt;
      if (old.receipt.requestHash !== requestHash) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Branch request command changed');
      return old;
    }
    if (this.active.size && command.payload.action !== 'stop') throw new ExperimentError('HOST_BUSY', 'Only stop requests are admitted while the serial coordinator runs');
    if (command.expectedRevision !== this.options.store.getRevision()) throw new ExperimentError('REVISION_CONFLICT', 'Branch basis revision differs');
    const { action, nodeId, evidenceRefs, reason } = command.payload, plan = this.options.store.getPlan(), node = this.options.store.getNodes().find((entry) => entry.nodeId === nodeId);
    evidenceRefs.forEach((ref) => this.options.reader.readBytes(caller, ref));
    let rejected: string | null = null;
    if (action !== 'stop' && !node) throw new ExperimentError('DEPENDENCY_NOT_READY', 'Branch target does not exist');
    if (action !== 'stop' && !evidenceRefs.length) throw new ExperimentError('DEPENDENCY_NOT_READY', 'Branch decision needs trusted evidence');
    if (['select', 'retain', 'expand'].includes(action) && node?.status !== 'eligible') rejected = 'target_has_no_verified_development_result';
    if (action === 'expand' && (node!.depth >= plan.limits.maxDepth || this.options.store.getNodes().length >= plan.limits.maxNodes)) rejected = 'frozen_depth_or_node_limit';
    if (action === 'prune' && node && !['failed', 'rejected', 'cancelled', 'interrupted'].includes(node.status)) rejected = 'no_frozen_pruning_condition';
    if (action === 'repair' && (plan.limits.maxRepairsPerNode === 0 || node?.status !== 'failed')) rejected = 'repair_not_allowed_by_frozen_policy';
    if (this.options.budget.snapshot().budgetExceeded && action !== 'stop' && action !== 'prune') rejected = 'root_budget_exhausted';
    const decisionRef = this.decision(action, nodeId, rejected ?? reason, evidenceRefs);
    const recordRef = this.publish({ schemaVersion: 1, command, decisionRef, executionStatus: 'not_executed', admission: rejected ? 'blocked' : 'requested', constraintFailure: rejected });
    const receipt: ResearchCommandReceipt = { schemaVersion: 1, status: rejected ? 'blocked' : 'succeeded', resultRefs: [recordRef, decisionRef],
      error: rejected ? { code: 'POLICY_DENIED', message: rejected, fieldPaths: ['payload.action'] } : null,
      receipt: { operationId: id, commandId: command.commandId, requestHash, taskRevision: this.options.store.getRevision() } };
    fs.writeFileSync(file, canonicalJsonV1(receipt), { flag: 'wx' }); return receipt;
  }
  listBranchRequests(caller: unknown): ResearchCommandReceipt[] {
    this.options.authorize(caller, false);
    return fs.readdirSync(path.join(this.options.directory, 'requests')).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).map((name) => parseJsonStrictV1(fs.readFileSync(path.join(this.options.directory, 'requests', name), 'utf8')) as unknown as ResearchCommandReceipt);
  }
  readPublication(caller: unknown, ref: ArtifactRef): Buffer {
    this.options.authorize(caller, false); expAssertArtifactRef(ref, 'loop ref');
    if (ref.id !== `records/${ref.sha256}.json`) throw new ExperimentError('POLICY_DENIED', 'Outside loop publication namespace');
    const bytes = fs.readFileSync(path.join(this.options.directory, ref.id));
    if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new ExperimentError('ARTIFACT_CORRUPT', 'Loop publication bytes changed');
    return bytes;
  }
}
