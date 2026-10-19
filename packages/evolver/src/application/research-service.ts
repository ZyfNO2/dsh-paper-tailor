/**
 * Paper-only application service: owner binding, idempotency, two-layer budget accounting,
 * research-operation lifecycle, and single-descriptor atomic publication.
 * Spec: docs/mvp/PAPER-ONLY-CONTRACTS.md sections 6, 9.1, 9.3, 9.4, 9.5.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PROTOCOL_ID,
  ResearchError,
  isTerminal,
  assertStatusTransition,
  validateRequestBase,
  validateScoringPolicyRef,
  validateResearchBudget,
  validateResearchOperation,
  validateSynthesisResult,
  validateSynthesisContractVersion,
  MAX_MODULES_PER_CANDIDATE_V2,
  type SynthesisContractVersion,
  type ArtifactRef,
  type CardRef,
  type DiscoveryResult,
  type ResearchBudget,
  type ResearchErrorCode,
  type ResearchOperation,
  type ResearchOperationStatus,
  type ResearchPhase,
  type ResearchReceipt,
  type ResearchRequestBase,
  type ScoringPolicyRef,
  type ResearchTaskBrief,
  type ResearchBaselineCard,
  type ResearchModuleCard,
  type RankingResult,
  type SynthesisResult,
} from '../contracts/research.ts';
import { computeRequestHash, parseJsonStrictV1, sha256Hex, typedHash } from '../domain/research-canonical.ts';
import {
  CorpusRegistry,
  InputAccessGuard,
  UnavailableModelPort,
  executeDiscovery,
  formatCorrectionMessage,
  isFormatOnlyError,
  assertPromptClean,
  assertReportedTokenBudget,
  type ResearchModelPort,
} from '../domain/paper-discovery.ts';
import {
  assembleSynthesis,
  buildSynthesisPrompt,
  verifyCardChain,
  MAX_CANDIDATES_DEFAULT,
  type AssembledSynthesis,
  type CardChainFacts,
  type CardResolver,
  type ResolvedCard,
  type SynthesisDraft,
} from '../domain/research-synthesis.ts';
import { rankCandidates, type RankingContext } from '../domain/proposal-ranking.ts';

export interface ResearchCallerActor {
  sessionId: string;
  agentId?: string;
}

export interface DiscoverRequest extends ResearchRequestBase {
  inputRefs: ArtifactRef[];
}

export interface SynthesizeRequest extends ResearchRequestBase {
  taskBrief: ResearchTaskBrief;
  cardRefs: CardRef[];
  /** Quota declared by the protocol or an explicit user choice; the caller may not inflate it. */
  maxCandidates?: number;
}

export interface RankRequest extends ResearchRequestBase {
  candidateSetRef: ArtifactRef;
  scoringPolicyRef: ScoringPolicyRef;
  sourceOperationId: string;
}

export interface ServiceOutcome<T> {
  receipt: ResearchReceipt;
  operation: ResearchOperation;
  result?: T;
}

/**
 * A replayed idempotency key returns exactly what was recorded. A recorded failure is
 * re-raised rather than swallowed into an empty result, so "no card" never looks like success.
 */
function rethrowRecordedFailure(prior: ResearchOperation): never | void {
  if (prior.status === 'succeeded') return;
  const code = (prior.error?.code ?? 'DEPENDENCY_NOT_READY') as ResearchErrorCode;
  throw new ResearchError(code, prior.error?.message ?? `operation ${prior.id} is ${prior.status}`, {
    retryable: prior.error?.retryable ?? false,
    fieldPaths: prior.error?.fieldPaths ?? [],
  });
}

export interface Ports {
  discovery?: ResearchModelPort;
  synthesis?: ResearchModelPort;
}

interface CommandIndexEntry {
  operationId: string;
  requestHash: string;
  ownerSessionId: string;
}

interface SampleLedger {
  evalInvocationId: string;
  sampleKey: string;
  calls: number;
  startedAtMs: number;
  elapsedMs: number;
  operationIds: string[];
}

const PROCESS_IDENTITY = `${process.pid}-${Date.now()}`;

export interface OwnerRecord {
  identity: string;
  pid: number;
  startedAt: string;
  lastSeenAt: string;
  state: 'active' | 'closed';
}

/** A peer is treated as gone when it closed, died, or stopped being seen for this long. */
export const OWNER_STALE_MS = 15 * 60 * 1000;

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether the host that owns an operation is still working on this storage root. */
export function ownerIsAlive(
  record: OwnerRecord | undefined,
  nowMs: number,
  probe?: { staleMs?: number; pidAlive?: (pid: number) => boolean }
): boolean {
  if (!record) return false;
  if (record.state !== 'active') return false;
  if (!(probe?.pidAlive ?? isPidAlive)(record.pid)) return false;
  return nowMs - Date.parse(record.lastSeenAt) < (probe?.staleMs ?? OWNER_STALE_MS);
}

export function shouldInterruptOperation(args: {
  status: string;
  ownerIdentity?: string;
  selfIdentity: string;
  ownerAlive: boolean;
}): boolean {
  if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(args.status)) return false;
  if (!args.ownerIdentity) return true;
  if (args.ownerIdentity === args.selfIdentity) return false;
  return !args.ownerAlive;
}

export class ResearchService {
  readonly storageRoot: string;
  readonly hostId: string;
  readonly ownerStaleMs: number;
  readonly ports: Ports;
  readonly synthesisLimits: { maxCandidates?: number };
  readonly synthesisContractVersion: SynthesisContractVersion;
  private readonly synthesisPublicHash: string;
  private correctionNote = '';
  private readonly guard: InputAccessGuard;
  private readonly fixturesRoot: string;

  constructor(opts: {
    storageRoot: string;
    hostId?: string;
    ports?: Ports;
    guard: InputAccessGuard;
    fixturesRoot: string;
    /** Trusted host configuration; never accepted in tool payloads. */
    publicProtocolPath?: string;
    synthesisLimits?: { maxCandidates?: number };
    ownerStaleMs?: number;
  }) {
    this.storageRoot = path.resolve(opts.storageRoot);
    this.hostId = opts.hostId ?? PROCESS_IDENTITY;
    this.ownerStaleMs = opts.ownerStaleMs ?? OWNER_STALE_MS;
    this.ports = opts.ports ?? {};
    const protocol = JSON.parse(fs.readFileSync(opts.publicProtocolPath ?? path.join(opts.fixturesRoot, 'protocol/public.json'), 'utf8'));
    const { publicHash, ...protocolBody } = protocol;
    this.synthesisPublicHash = typedHash('protocol-public', protocolBody);
    if (publicHash !== this.synthesisPublicHash) throw new ResearchError('SOURCE_MISMATCH', 'Configured public protocol hash mismatch');
    this.synthesisContractVersion = validateSynthesisContractVersion(protocol.synthesisLimits?.contractVersion ?? 1);
    if (this.synthesisContractVersion === 2 && (protocol.synthesisLimits?.maxModulesPerCandidate !== MAX_MODULES_PER_CANDIDATE_V2 || protocol.synthesisLimits?.ablationPolicy !== 'leave-one-out-v1')) {
      throw new ResearchError('SCHEMA_VIOLATION', 'Synthesis v2 requires its declared module cap and ablation policy');
    }
    this.synthesisLimits = opts.synthesisLimits ?? protocol.synthesisLimits ?? {};
    this.guard = opts.guard;
    this.fixturesRoot = path.resolve(opts.fixturesRoot);
    for (const dir of ['operations', 'staging', 'index', 'owners']) {
      fs.mkdirSync(path.join(this.storageRoot, dir), { recursive: true });
    }
    this.registerOwner();
    this.reconcileAfterRestart();
  }

  private ownerFile(identity: string): string {
    return path.join(this.storageRoot, 'owners', `${identity}.json`);
  }

  /** Announces this host so peers can tell a live worker from a process that died mid-operation. */
  private registerOwner(): void {
    const now = new Date().toISOString();
    const previous = this.readOwnerRecord(this.hostId);
    const record: OwnerRecord = {
      identity: this.hostId,
      pid: process.pid,
      startedAt: previous?.startedAt ?? now,
      lastSeenAt: now,
      state: 'active',
    };
    this.writeJsonAtomic(this.ownerFile(this.hostId), record);
  }

  readOwnerRecord(identity: string): OwnerRecord | undefined {
    const file = this.ownerFile(identity);
    if (!fs.existsSync(file)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as OwnerRecord;
    } catch {
      return undefined;
    }
  }

  /** Callers that finish with a storage root close their host record, so a later start can reclaim. */
  dispose(): void {
    const existing = this.readOwnerRecord(this.hostId);
    if (!existing || existing.state === 'closed') return;
    this.writeJsonAtomic(this.ownerFile(this.hostId), { ...existing, state: 'closed', lastSeenAt: new Date().toISOString() });
  }

  // ----------------- storage primitives -----------------

  private commandIndexPath(): string {
    return path.join(this.storageRoot, 'index', 'command-index.json');
  }

  private sampleIndexPath(): string {
    return path.join(this.storageRoot, 'index', 'sample-ledger.json');
  }

  private readJsonMap<T>(file: string): Map<string, T> {
    if (!fs.existsSync(file)) return new Map();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, T>;
    return new Map(Object.entries(parsed));
  }

  /** Atomic replace: write to a sibling temp file, then rename over the target. */
  private writeJsonAtomic(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${PROCESS_IDENTITY}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  }

  descriptorPath(operationId: string): string {
    return path.join(this.storageRoot, 'operations', `${operationId}.json`);
  }

  loadOperation(operationId: string): ResearchOperation {
    const file = this.descriptorPath(operationId);
    if (!fs.existsSync(file)) {
      throw new ResearchError('DEPENDENCY_NOT_READY', `Operation "${operationId}" has no published descriptor`, {
        fieldPaths: ['operationId'],
      });
    }
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ResearchOperation;
  }

  listOperations(): ResearchOperation[] {
    const dir = path.join(this.storageRoot, 'operations');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ResearchOperation);
  }

  private saveDescriptor(op: ResearchOperation): void {
    validateResearchOperation(op);
    // Writing a descriptor is proof of life, so the host record is refreshed alongside it.
    this.registerOwner();
    const onDisk = this.readDescriptor(op.id);
    if (onDisk && isTerminal(onDisk.status)) {
      // A terminal state on disk is authoritative: a stale in-memory object must never
      // resurrect a cancelled or interrupted operation while writing diagnostics.
      op.status = onDisk.status;
      op.error = onDisk.error;
      op.resultRefs = onDisk.resultRefs;
      op.updatedAt = onDisk.updatedAt;
      op.ownerIdentity = onDisk.ownerIdentity ?? op.ownerIdentity;
      this.writeJsonAtomic(this.descriptorPath(op.id), op);
      return;
    }
    this.writeJsonAtomic(this.descriptorPath(op.id), op);
  }

  private readDescriptor(operationId: string): ResearchOperation | undefined {
    const file = this.descriptorPath(operationId);
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ResearchOperation;
  }

  // ----------------- lifecycle -----------------

  private transition(op: ResearchOperation, to: ResearchOperationStatus): void {
    if (op.status === to) return;
    assertStatusTransition(op.status, to);
    op.status = to;
    op.updatedAt = new Date().toISOString();
    this.saveDescriptor(op);
  }

  /**
   * An operation left non-terminal by a host that is gone becomes interrupted. An operation whose
   * host is still alive is left alone: a second process sharing this storage root must not cancel
   * a live peer's in-flight work, which is what made concurrent live runs look like route failures.
   */
  reconcileAfterRestart(): ResearchOperation[] {
    const interrupted: ResearchOperation[] = [];
    const nowMs = Date.now();
    for (const op of this.listOperations()) {
      if (!shouldInterruptOperation({
        status: op.status,
        ownerIdentity: op.ownerIdentity,
        selfIdentity: this.hostId,
        ownerAlive: ownerIsAlive(op.ownerIdentity ? this.readOwnerRecord(op.ownerIdentity) : undefined, nowMs, { staleMs: this.ownerStaleMs }),
      })) continue;
      assertStatusTransition(op.status, 'interrupted');
      op.status = 'interrupted';
      op.error = {
        code: 'INTERRUPTED',
        message: 'The host that owned this operation is no longer running; the publish commit point was not reached',
        retryable: false,
        fieldPaths: [],
        diagnosticRef: null,
      };
      op.updatedAt = new Date().toISOString();
      this.saveDescriptor(op);
      interrupted.push(op);
    }
    return interrupted;
  }

  // ----------------- request intake -----------------

  private assertActor(actor: ResearchCallerActor): void {
    if (!actor || typeof actor.sessionId !== 'string' || actor.sessionId.trim().length === 0) {
      throw new ResearchError('OWNER_MISMATCH', 'A non-empty session owner is required');
    }
  }

  private checkIsolation(inputRefs: ArtifactRef[]): void {
    for (const ref of inputRefs) {
      const abs = path.resolve(this.fixturesRoot, ref.id);
      const verdict = this.guard.check(abs);
      if (!verdict.allowed) {
        throw new ResearchError('POLICY_DENIED', `Input reference "${ref.id}" is outside the readable roots: ${verdict.reason}`, {
          fieldPaths: ['inputRefs'],
        });
      }
    }
  }

  private allocateStaging(evalInvocationId: string, phase: ResearchPhase, sampleKey: string, operationId: string): string {
    const dir = path.join(this.storageRoot, evalInvocationId, phase, sampleKey, operationId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private relativeRef(absoluteFile: string): ArtifactRef {
    const rel = path.relative(this.storageRoot, absoluteFile).replace(/\\/g, '/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ResearchError('POLICY_DENIED', `Artifact "${absoluteFile}" escapes the invocation root`);
    }
    return { id: rel, sha256: sha256Hex(fs.readFileSync(absoluteFile)) };
  }

  // ----------------- budget -----------------

  private loadSampleLedger(key: string): SampleLedger | undefined {
    return this.readJsonMap<SampleLedger>(this.sampleIndexPath()).get(key);
  }

  private beginSample(evalInvocationId: string, sampleKey: string, budget: ResearchBudget, operationId: string): SampleLedger {
    const key = `${evalInvocationId}::${sampleKey}`;
    const ledger = this.readJsonMap<SampleLedger>(this.sampleIndexPath());
    const existing = ledger.get(key) ?? {
      evalInvocationId,
      sampleKey,
      calls: 0,
      startedAtMs: Date.now(),
      elapsedMs: 0,
      operationIds: [],
    };
    if (!existing.operationIds.includes(operationId)) existing.operationIds.push(operationId);
    ledger.set(key, existing);
    this.writeJsonAtomic(this.sampleIndexPath(), Object.fromEntries(ledger));
    return existing;
  }

  private recordCall(sample: SampleLedger, used: number, elapsedMs: number): void {
    sample.calls += used;
    sample.elapsedMs += elapsedMs;
    const ledger = this.readJsonMap<SampleLedger>(this.sampleIndexPath());
    ledger.set(`${sample.evalInvocationId}::${sample.sampleKey}`, sample);
    this.writeJsonAtomic(this.sampleIndexPath(), Object.fromEntries(ledger));
  }

  /**
   * Initial call plus at most one format correction, accounted per evalInvocationId and
   * sampleKey so a fresh commandId cannot buy extra budget.
   */
  private assertSampleBudget(sample: SampleLedger, budget: ResearchBudget, minimumCalls: number): void {
    validateResearchBudget(budget);
    if (budget.maxCalls < minimumCalls) {
      throw new ResearchError('INVALID_INPUT', `budget.maxCalls ${budget.maxCalls} is below the ${minimumCalls} required for this phase`, {
        fieldPaths: ['budget.maxCalls'],
      });
    }
    if (sample.calls >= budget.maxCalls) {
      throw new ResearchError('BUDGET_EXHAUSTED', `Sample ${sample.sampleKey} already consumed ${sample.calls}/${budget.maxCalls} calls`, {
        fieldPaths: ['budget.maxCalls'],
      });
    }
    if (sample.elapsedMs >= budget.totalTimeoutMs) {
      throw new ResearchError('BUDGET_EXHAUSTED', `Sample ${sample.sampleKey} exceeded ${budget.totalTimeoutMs}ms`, {
        fieldPaths: ['budget.totalTimeoutMs'],
      });
    }
  }

  // ----------------- idempotency -----------------

  private idempotencyKey(ownerSessionId: string, phase: ResearchPhase, commandId: string): string {
    return `${ownerSessionId}::${phase}::${commandId}`;
  }

  private reserveOrReuse(
    ownerSessionId: string,
    phase: ResearchPhase,
    commandId: string,
    requestHash: string
  ): { operationId: string; reused: boolean } {
    const index = this.readJsonMap<CommandIndexEntry>(this.commandIndexPath());
    const key = this.idempotencyKey(ownerSessionId, phase, commandId);
    const existing = index.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ResearchError(
          'IDEMPOTENCY_CONFLICT',
          `commandId "${commandId}" was already used under this owner with a different payload`,
          { fieldPaths: ['commandId'] }
        );
      }
      return { operationId: existing.operationId, reused: true };
    }
    const operationId = `rop-${phase}-${sha256Hex(key).slice(0, 16)}`;
    index.set(key, { operationId, requestHash, ownerSessionId });
    this.writeJsonAtomic(this.commandIndexPath(), Object.fromEntries(index));
    return { operationId, reused: false };
  }

  // ----------------- publication -----------------

  /**
   * Staging files become consumable only when the single descriptor flips to succeeded.
   * A cancellation observed before the commit point blocks publication; after it the
   * succeeded descriptor is returned rather than pretending the work was withdrawn.
   */
  private publish(operation: ResearchOperation, resultFiles: string[], resultRef: ArtifactRef): ResearchOperation {
    // Re-read the descriptor so a cancel that landed while the artifacts were staged wins
    // the race: before the commit point nothing may be published as succeeded.
    const onDisk = this.loadOperation(operation.id);
    if (onDisk.status === 'succeeded') return onDisk;
    if (onDisk.status === 'cancelled' || onDisk.status === 'interrupted' || onDisk.status === 'failed') {
      throw new ResearchError('CANCELLED', `Operation ${operation.id} is ${onDisk.status}; the publish commit point was not reached`, {
        fieldPaths: ['status'],
      });
    }
    for (const file of resultFiles) {
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        throw new ResearchError('SOURCE_MISMATCH', `Staged artifact "${file}" is missing or empty`);
      }
    }
    operation.resultRefs = [resultRef];
    operation.error = null;
    assertStatusTransition(operation.status, 'succeeded');
    operation.status = 'succeeded';
    operation.updatedAt = new Date().toISOString();
    this.saveDescriptor(operation);
    return operation;
  }

  private failOperation(operation: ResearchOperation, err: unknown): ResearchOperation {
    const onDisk = this.loadOperation(operation.id);
    if (isTerminal(onDisk.status)) return onDisk;
    const e = err instanceof ResearchError ? err : null;
    onDisk.error = {
      code: e ? e.code : 'MODEL_RESPONSE_ERROR',
      // A non-ResearchError must stay distinguishable from a model refusal: swallowing a Host
      // defect as MODEL_RESPONSE_ERROR is how the synthesis port path went unnoticed.
      message: e ? e.message : `${err instanceof Error ? `${err.constructor.name}: ` : ''}${String(err)}`,
      retryable: e ? e.retryable : false,
      fieldPaths: e ? e.fieldPaths : [],
      diagnosticRef: e?.diagnosticRef ?? null,
    };
    assertStatusTransition(onDisk.status, 'failed');
    onDisk.status = 'failed';
    onDisk.updatedAt = new Date().toISOString();
    this.saveDescriptor(onDisk);
    return onDisk;
  }

  // ----------------- P5 -----------------

  async discoverPapers(
    request: DiscoverRequest,
    actor: ResearchCallerActor,
    deps: {
      registry: CorpusRegistry;
      publicProtocol: Record<string, unknown>;
      skillText: string;
      port?: ResearchModelPort;
      /** Lets a caller observe the accepted operation id without guessing it. */
      onOperationId?: (operationId: string) => void;
    }
  ): Promise<ServiceOutcome<DiscoveryResult>> {
    this.assertActor(actor);
    const { base } = validateRequestBase(request, ['inputRefs'], 'DiscoverRequest');
    if (!Array.isArray(request.inputRefs) || request.inputRefs.length === 0) {
      throw new ResearchError('INVALID_INPUT', 'inputRefs must be a non-empty array', { fieldPaths: ['inputRefs'] });
    }
    this.checkIsolation(request.inputRefs);

    const registry = deps.registry;
    const paperIds: string[] = [];
    for (const ref of request.inputRefs) {
      const entry = registry.entry(parseInputRefId(ref.id));
      if (entry.documentHash !== ref.sha256) {
        throw new ResearchError('SOURCE_MISMATCH', `Input "${entry.paperId}" hash ${ref.sha256} != registered ${entry.documentHash}`, {
          fieldPaths: ['inputRefs'],
        });
      }
      paperIds.push(entry.paperId);
    }

    const requestHash = computeRequestHash({
      protocolRef: base.protocolRef,
      sampleKey: base.sampleKey,
      budget: base.budget,
      inputRefs: request.inputRefs,
      phase: 'p5_discover',
    });

    const { operationId, reused } = this.reserveOrReuse(actor.sessionId.trim(), 'p5_discover', base.commandId, requestHash);
    if (reused) {
      // Same owner + commandId + payload returns what was already recorded: the model is
      // not called again, and a recorded failure is never retried into an answer.
      const prior = this.loadOperation(operationId);
      if (prior.status === 'accepted') {
        throw new ResearchError('DEPENDENCY_NOT_READY', `Operation ${operationId} is still ${prior.status}`, { fieldPaths: ['status'] });
      }
      rethrowRecordedFailure(prior);
      const result = prior.status === 'succeeded' ? this.readPublishedResult<DiscoveryResult>(prior) : undefined;
      return { receipt: { operationId, commandId: base.commandId, requestHash }, operation: prior, ...(result ? { result } : {}) };
    }
    const operation = this.createOperation(operationId, actor, base, requestHash, 'p5_discover');
    deps.onOperationId?.(operation.id);

    const sample = this.beginSample(base.evalInvocationId, base.sampleKey, base.budget, operationId);
    this.transition(operation, 'running');
    const stagingDir = this.allocateStaging(base.evalInvocationId, 'p5_discover', base.sampleKey, operationId);
    const port = deps.port ?? this.ports.discovery ?? new UnavailableModelPort();

    const files: string[] = [];
    try {
      this.assertSampleBudget(sample, base.budget, 1);
      const manifestPath = path.join(stagingDir, 'input-manifest.json');
      this.writeJsonAtomic(manifestPath, {
        protocolId: PROTOCOL_ID,
        corpusHash: registry.manifest.corpusHash,
        requested: paperIds,
        entries: registry.manifest.entries.filter((e) => paperIds.includes(e.paperId)),
      });
      files.push(manifestPath);

      const requestPath = path.join(stagingDir, 'request.json');
      this.writeJsonAtomic(requestPath, { base, inputRefs: request.inputRefs, requestHash });
      files.push(requestPath);

      const execution = await executeDiscovery(paperIds, {
        registry,
        publicProtocol: deps.publicProtocol,
        skillText: deps.skillText,
        port,
        budget: base.budget,
        producerOperationId: operationId,
        sampleKey: base.sampleKey,
        requestHash,
        saveRaw: (sequence, text) => {
          const rawPath = path.join(stagingDir, `attempt-${sequence}.raw.json`);
          fs.writeFileSync(rawPath, text, 'utf8');
          return this.relativeRef(rawPath);
        },
        recordAttempt: (attempt) => {
          operation.attempts = [...operation.attempts, attempt];
          this.saveDescriptor(operation);
        },
        updateAttempt: (attempt) => {
          operation.attempts = operation.attempts.map(a => a.sequence === attempt.sequence ? attempt : a);
          this.saveDescriptor(operation);
        },
        annotateAttempt: (sequence, message) => {
          const record = operation.attempts.find((a) => a.sequence === sequence);
          if (record) {
            record.formatError = message;
            this.saveDescriptor(operation);
          }
        },
      });

      const resultPath = path.join(stagingDir, 'result.json');
      this.writeJsonAtomic(resultPath, execution.result);
      files.push(resultPath);

      const index = this.buildCardIndex(execution.result, operationId);
      const indexPath = path.join(stagingDir, 'card-index.json');
      this.writeJsonAtomic(indexPath, index);
      files.push(indexPath);

      const resultRef = this.relativeRef(resultPath);
      const published = this.publish(operation, files, resultRef);
      this.recordCall(sample, execution.llmCalls, Date.now() - sample.startedAtMs);
      return { receipt: { operationId, commandId: base.commandId, requestHash }, operation: published, result: execution.result };
    } catch (err) {
      const failed = this.failOperation(operation, err);
      // Bill what was actually spent. This used to charge a flat 1, which
      // under-counted any attempt that had already run - a sample that burned a
      // call and then failed was recorded as a single call, so a shared per-sample
      // ceiling did not actually bound the number of model calls. The attempt
      // ledger is the authority here: it is appended by the execution itself and
      // holds one entry per model call, successful or not.
      this.recordCall(sample, failed.attempts.length, Date.now() - sample.startedAtMs);
      this.writeJsonAtomic(path.join(stagingDir, 'attempts.json'), { attempts: failed.attempts, error: failed.error });
      throw err;
    }
  }

  private buildCardIndex(result: DiscoveryResult, operationId: string): Record<string, CardRef> {
    const index: Record<string, CardRef> = {};
    const add = (card: ResearchBaselineCard | ResearchModuleCard): void => {
      index[card.id] = {
        id: card.id,
        revision: card.revision,
        sha256: typedHash('candidate', card),
        producerOperationId: operationId,
      };
    };
    result.baselineCards.forEach(add);
    result.moduleCards.forEach(add);
    return index;
  }

  private readPublishedResult<T>(operation: ResearchOperation): T {
    if (operation.status !== 'succeeded' || operation.resultRefs.length === 0) {
      throw new ResearchError('DEPENDENCY_NOT_READY', `Operation ${operation.id} is ${operation.status}; only succeeded results may be consumed`, {
        fieldPaths: ['status'],
      });
    }
    const ref = operation.resultRefs[0];
    const abs = path.resolve(this.storageRoot, ref.id);
    if (!abs.startsWith(this.storageRoot)) {
      throw new ResearchError('POLICY_DENIED', `Result reference "${ref.id}" resolves outside the invocation root`);
    }
    const bytes = fs.readFileSync(abs);
    if (sha256Hex(bytes) !== ref.sha256) {
      throw new ResearchError('SOURCE_MISMATCH', `Result "${ref.id}" content hash drifted`);
    }
    return JSON.parse(bytes.toString('utf8')) as T;
  }

  // ----------------- P6 -----------------

  async synthesizeResearch(
    request: SynthesizeRequest,
    actor: ResearchCallerActor,
    deps: {
      registry: CorpusRegistry;
      publicProtocol: Record<string, unknown>;
      skillText: string;
      /** Component-test escape hatch: a pre-supplied draft. Never used on the live path. */
      draft?: SynthesisDraft;
      port?: ResearchModelPort;
      /** Cards published by a real P5 operation; fixture cards must say so explicitly. */
      resolver?: CardResolver;
      /** Only for a deliberate multi-operation dev chain; the real chain resolves by producerOperationId. */
      includeAllPublishedCards?: boolean;
      fixtureProvenance?: 'fixture_only';
    }
  ): Promise<ServiceOutcome<SynthesisResult>> {
    this.assertActor(actor);
    const { base } = validateRequestBase(request, ['taskBrief', 'cardRefs', 'maxCandidates'], 'SynthesizeRequest');
    const { publicHash: promptPublicHash, ...promptProtocol } = deps.publicProtocol;
    if (base.protocolRef.publicHash !== this.synthesisPublicHash || promptPublicHash !== this.synthesisPublicHash || typedHash('protocol-public', promptProtocol) !== this.synthesisPublicHash) {
      throw new ResearchError('SOURCE_MISMATCH', 'Synthesis request/prompt must bind the configured public protocol');
    }
    if (!Array.isArray(request.cardRefs) || request.cardRefs.length === 0) {
      throw new ResearchError('INVALID_INPUT', 'cardRefs must be a non-empty array', { fieldPaths: ['cardRefs'] });
    }
    const requestHash = computeRequestHash({
      protocolRef: base.protocolRef,
      sampleKey: base.sampleKey,
      budget: base.budget,
      taskBrief: request.taskBrief,
      cardRefs: request.cardRefs,
      maxCandidates: request.maxCandidates ?? null,
      phase: 'p6_synthesize',
    });

    const { operationId, reused } = this.reserveOrReuse(actor.sessionId.trim(), 'p6_synthesize', base.commandId, requestHash);
    if (reused) {
      const prior = this.loadOperation(operationId);
      if (prior.status === 'accepted') {
        throw new ResearchError('DEPENDENCY_NOT_READY', `Operation ${operationId} is still ${prior.status}`, { fieldPaths: ['status'] });
      }
      rethrowRecordedFailure(prior);
      const result = prior.status === 'succeeded' ? this.readPublishedResult<SynthesisResult>(prior) : undefined;
      return { receipt: { operationId, commandId: base.commandId, requestHash }, operation: prior, ...(result ? { result } : {}) };
    }
    const operation = this.createOperation(operationId, actor, base, requestHash, 'p6_synthesize');
    const sample = this.beginSample(base.evalInvocationId, base.sampleKey, base.budget, operationId);
    this.transition(operation, 'running');
    const stagingDir = this.allocateStaging(base.evalInvocationId, 'p6_synthesize', base.sampleKey, operationId);
    const files: string[] = [];

    try {
      this.assertSampleBudget(sample, base.budget, 1);
      const resolver =
        deps.resolver ??
        this.publishedCardResolver({
          fixtureOnly: deps.fixtureProvenance === 'fixture_only',
          fixtureCards: [],
          extraRefs: request.cardRefs,
          includeAllPublished: deps.includeAllPublishedCards === true,
        });
      const chain: CardChainFacts = verifyCardChain(request.cardRefs, resolver);
      const prompt = buildSynthesisPrompt(
        request.taskBrief,
        chain.resolved.map((r) => r.card),
        deps.publicProtocol,
        deps.skillText
      );
      assertPromptClean(prompt.framing);

      const requestPath = path.join(stagingDir, 'request.json');
      this.writeJsonAtomic(requestPath, {
        base,
        cardRefs: request.cardRefs,
        requestHash,
        cardProvenance: deps.fixtureProvenance ?? 'published_p5_chain',
      });
      files.push(requestPath);

      const assemble = (draft: SynthesisDraft): AssembledSynthesis =>
        assembleSynthesis({
          taskBrief: request.taskBrief,
          draft,
          chain,
          producerOperationId: operationId,
          corpusHash: deps.registry.manifest.corpusHash,
          maxCandidates: this.allowedCandidateQuota(request.maxCandidates),
          contractVersion: this.synthesisContractVersion,
        });
      // Assembly runs inside the routed loop so that a shape violation found there gets the same
      // single format correction P5 grants; EVIDENCE_INVALID and other substantive errors do not.
      const assembled = deps.port
        ? await this.invokeSynthesisDraft(deps.port, prompt, base, stagingDir, operation, sample, assemble)
        : assemble(requireDraft(deps.draft));

      const resultPath = path.join(stagingDir, 'result.json');
      this.writeJsonAtomic(resultPath, assembled.result);
      files.push(resultPath);

      const proposalPath = path.join(stagingDir, 'proposal.md');
      fs.writeFileSync(proposalPath, assembled.proposalMarkdown, 'utf8');
      files.push(proposalPath);

      if (assembled.proposalRef.sha256 !== sha256Hex(fs.readFileSync(proposalPath))) {
        throw new ResearchError('SOURCE_MISMATCH', 'proposal hash does not match the rendered markdown');
      }

      const dedupPath = path.join(stagingDir, 'deduplication.json');
      this.writeJsonAtomic(dedupPath, assembled.deduplication);
      files.push(dedupPath);

      const resultRef = this.relativeRef(resultPath);
      const published = this.publish(operation, files, resultRef);
      // Bill the attempts this operation actually recorded. A hardcoded 1
      // under-counted every P6 that spent a format correction, so the shared
      // per-sample ceiling did not bound the real number of model calls.
      this.recordCall(sample, published.attempts.length, Date.now() - sample.startedAtMs);
      return { receipt: { operationId, commandId: base.commandId, requestHash }, operation: published, result: assembled.result };
    } catch (err) {
      const failed = this.failOperation(operation, err);
      this.recordCall(sample, failed.attempts.length, Date.now() - sample.startedAtMs);
      this.writeJsonAtomic(path.join(stagingDir, 'attempts.json'), { attempts: failed.attempts, error: failed.error });
      throw err;
    }
  }

  /** One initial call plus at most one format correction; substantive errors are not retried. */
  private async invokeSynthesisDraft(
    port: ResearchModelPort,
    prompt: { systemPrompt: string; userPrompt: string },
    base: ResearchRequestBase,
    stagingDir: string,
    operation: ResearchOperation,
    sample: SampleLedger,
    assemble: (draft: SynthesisDraft) => AssembledSynthesis
  ): Promise<AssembledSynthesis> {
    for (let sequence = 1; sequence <= 2; sequence += 1) {
      const isFormatCorrection = sequence === 2;
      // Contract section 6 bills the correction like any other call, so the budget is checked
      // per attempt rather than once per operation.
      if (sample.calls + operation.attempts.length >= base.budget.maxCalls) {
        throw new ResearchError('BUDGET_EXHAUSTED', `Sample ${sample.sampleKey} may not exceed ${base.budget.maxCalls} calls`, {
          fieldPaths: ['budget.maxCalls'],
        });
      }
      if (Date.now() - sample.startedAtMs >= base.budget.totalTimeoutMs) {
        throw new ResearchError('BUDGET_EXHAUSTED', `Sample ${sample.sampleKey} exceeded ${base.budget.totalTimeoutMs}ms`, {
          fieldPaths: ['budget.totalTimeoutMs'],
        });
      }
      const started = Date.now();
      const attempt = {
        sequence, startedAt: new Date(started).toISOString(), endedAt: null as string | null,
        route: port.route, inputTokens: null as number | null, outputTokens: null as number | null,
        rawResponseRef: null as ArtifactRef | null, exitReason: 'started', isFormatCorrection,
      };
      operation.attempts = [...operation.attempts, attempt];
      this.saveDescriptor(operation);
      let result;
      try {
        result = await port.invoke({
        route: port.route,
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt + (isFormatCorrection ? `\n\n${this.correctionNote}` : ''),
        maxOutputTokens: base.budget.maxOutputTokensPerCall,
        maxInputTokens: base.budget.maxInputTokensPerCall,
        timeoutMs: Math.min(base.budget.callTimeoutMs, base.budget.totalTimeoutMs - (started - sample.startedAtMs)),
        requestHash: operation.requestHash,
        isFormatCorrection,
        });
      } catch (err) {
        attempt.endedAt = new Date().toISOString();
        attempt.exitReason = err instanceof ResearchError ? err.code : 'MODEL_RESPONSE_ERROR';
        this.saveDescriptor(operation);
        throw err;
      }
      const rawPath = path.join(stagingDir, `attempt-${sequence}.raw.json`);
      fs.writeFileSync(rawPath, result.text, 'utf8');
      Object.assign(attempt, {
        endedAt: new Date().toISOString(), route: result.route,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        rawResponseRef: this.relativeRef(rawPath), exitReason: 'returned',
      });
      this.saveDescriptor(operation);
      assertReportedTokenBudget(result, base.budget);
      try {
        const parsed = parseJsonStrictV1(result.text) as { candidates?: unknown[] };
        if (!parsed || !Array.isArray(parsed.candidates)) {
          throw new ResearchError('SCHEMA_VIOLATION', 'Synthesis payload must be an object with a candidates array', {
            fieldPaths: ['candidates'],
          });
        }
        // Assembly is inside the guarded block: a shape violation it finds is still a format error,
        // while an unsupported citation or drifted card reference stays terminal.
        return assemble({ candidates: parsed.candidates as SynthesisDraft['candidates'] });
      } catch (err) {
        if (!isFormatOnlyError(err)) throw err;
        // Same rule as P5: the error that triggered the correction must stay on the record.
        const record = operation.attempts.find((a) => a.sequence === sequence);
        if (record) {
          record.formatError = (err as Error).message;
          this.saveDescriptor(operation);
        }
        if (sequence === 2) {
          throw new ResearchError('SCHEMA_VIOLATION', `Second attempt still failed to assemble: ${(err as Error).message}`, {
            fieldPaths: (err as ResearchError).fieldPaths,
          });
        }
        this.correctionNote = formatCorrectionMessage(err);
      }
    }
    throw new ResearchError('MODEL_RESPONSE_ERROR', 'Synthesis loop exited without a draft');
  }

  /** The candidate quota comes from the protocol; a caller may only lower it. */
  private allowedCandidateQuota(requested?: number | null): number {
    const protocolMax = this.synthesisLimits.maxCandidates ?? MAX_CANDIDATES_DEFAULT;
    if (requested === undefined || requested === null) return protocolMax;
    if (requested > protocolMax) {
      throw new ResearchError('POLICY_DENIED', `maxCandidates ${requested} exceeds the protocol quota ${protocolMax}`, {
        fieldPaths: ['maxCandidates'],
      });
    }
    return requested;
  }

  private createOperation(
    operationId: string,
    actor: ResearchCallerActor,
    base: ResearchRequestBase,
    requestHash: string,
    phase: ResearchPhase
  ): ResearchOperation {
    if (this.listOperations().some((o) => o.id === operationId)) {
      throw new ResearchError('IDEMPOTENCY_CONFLICT', `Operation ${operationId} already exists for a different payload`, {
        fieldPaths: ['commandId'],
      });
    }
    const now = new Date().toISOString();
    const fresh: ResearchOperation = {
      id: operationId,
      ownerSessionId: actor.sessionId.trim(),
      ownerIdentity: this.hostId,
      commandId: base.commandId,
      requestHash,
      phase,
      status: 'accepted',
      resultRefs: [],
      error: null,
      attempts: [],
      evalInvocationId: base.evalInvocationId,
      sampleKey: base.sampleKey,
      createdAt: now,
      updatedAt: now,
    };
    this.saveDescriptor(fresh);
    return fresh;
  }

  /** Resolves a CardRef only through succeeded, published P5 descriptors. */
  publishedCardResolver(opts: {
    fixtureOnly: boolean;
    fixtureCards?: Array<ResearchBaselineCard | ResearchModuleCard>;
    extraRefs?: CardRef[];
    includeAllPublished?: boolean;
  }): CardResolver {
    const cardIndex = new Map<string, { ref: CardRef; kind: 'baseline' | 'module'; card: ResearchBaselineCard | ResearchModuleCard; operationId: string }>();

    if (opts.fixtureOnly) {
      for (const card of opts.fixtureCards ?? []) {
        const ref: CardRef = {
          id: card.id,
          revision: card.revision,
          sha256: typedHash('candidate', card),
          producerOperationId: `fixture-${PROTOCOL_ID}`,
        };
        cardIndex.set(card.id, { ref, kind: 'module' in card ? 'module' : 'baseline', card, operationId: ref.producerOperationId });
      }
    }

    const candidatesByProducer = new Set<string>();
    for (const ref of opts.extraRefs ?? []) candidatesByProducer.add(ref.producerOperationId);
    const seenProducer = new Set<string>();
    for (const operation of this.listOperations()) {
      if (operation.phase !== 'p5_discover' || operation.status !== 'succeeded') continue;
      if (opts.includeAllPublished === true) candidatesByProducer.add(operation.id);
      if (!candidatesByProducer.has(operation.id)) continue;
      if (seenProducer.has(operation.id)) continue;
      seenProducer.add(operation.id);
      const indexPath = path.resolve(this.storageRoot, path.posix.join(path.dirname(operation.resultRefs[0]?.id ?? ''), 'card-index.json'));
      if (!fs.existsSync(indexPath)) continue;
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Record<string, CardRef>;
      const result = this.readPublishedResult<DiscoveryResult>(operation);
      for (const [id, ref] of Object.entries(index)) {
        const card =
          result.baselineCards.find((c) => c.id === id) ??
          result.moduleCards.find((c) => c.id === id);
        if (!card) continue;
        cardIndex.set(id, {
          ref,
          kind: result.baselineCards.some((c) => c.id === id) ? 'baseline' : 'module',
          card,
          operationId: operation.id,
        });
      }
    }

    return {
      resolve: (ref: CardRef): ResolvedCard => {
        const found = cardIndex.get(ref.id);
        if (!found) {
          throw new ResearchError('DEPENDENCY_NOT_READY', `Card "${ref.id}" is not published by any succeeded operation`, {
            fieldPaths: [ref.id],
          });
        }
        return {
          ref: found.ref,
          kind: found.kind,
          card: found.card,
          producerStatus: 'succeeded',
          ownerOperationId: found.operationId,
        };
      },
    };
  }

  // ----------------- P7 -----------------

  rankResearch(
    request: RankRequest,
    actor: ResearchCallerActor,
    deps: { scoringPolicy: Record<string, unknown>; resolvableEvidenceIds: Set<string>; cardsById: RankingContext['cardsById'] }
  ): ServiceOutcome<RankingResult> {
    this.assertActor(actor);
    const { base } = validateRequestBase(request, ['candidateSetRef', 'scoringPolicyRef', 'sourceOperationId'], 'RankRequest');
    validateScoringPolicyRef(request.scoringPolicyRef);
    if (base.budget.maxCalls !== 0) {
      throw new ResearchError('INVALID_INPUT', 'P7 must not request model calls; budget.maxCalls must be 0', {
        fieldPaths: ['budget.maxCalls'],
      });
    }
    const requestHash = computeRequestHash({
      protocolRef: base.protocolRef,
      sampleKey: base.sampleKey,
      budget: base.budget,
      candidateSetRef: request.candidateSetRef,
      scoringPolicyRef: request.scoringPolicyRef,
      sourceOperationId: request.sourceOperationId,
      phase: 'p7_rank',
    });

    const { operationId, reused } = this.reserveOrReuse(actor.sessionId.trim(), 'p7_rank', base.commandId, requestHash);
    if (reused) {
      const prior = this.loadOperation(operationId);
      if (prior.status === 'accepted') {
        throw new ResearchError('DEPENDENCY_NOT_READY', `Operation ${operationId} is still ${prior.status}`, { fieldPaths: ['status'] });
      }
      rethrowRecordedFailure(prior);
      const result = prior.status === 'succeeded' ? this.readPublishedResult<RankingResult>(prior) : undefined;
      return { receipt: { operationId, commandId: base.commandId, requestHash }, operation: prior, ...(result ? { result } : {}) };
    }
    const operation = this.createOperation(operationId, actor, base, requestHash, 'p7_rank');
    const sample = this.beginSample(base.evalInvocationId, base.sampleKey, base.budget, operationId);
    this.transition(operation, 'running');
    const stagingDir = this.allocateStaging(base.evalInvocationId, 'p7_rank', base.sampleKey, operationId);

    try {
      const source = this.loadOperation(request.sourceOperationId);
      if (source.phase !== 'p6_synthesize' || source.status !== 'succeeded') {
        throw new ResearchError('DEPENDENCY_NOT_READY', `Candidate source operation ${source.id} is ${source.phase}/${source.status}`, {
          fieldPaths: ['sourceOperationId'],
        });
      }
      const synthesis = this.readPublishedResult<SynthesisResult>(source);
      validateSynthesisResult(synthesis, 'SynthesisResult', { knownSpanIds: deps.resolvableEvidenceIds });
      if (request.candidateSetRef.id !== source.resultRefs[0]?.id) {
        throw new ResearchError('SOURCE_MISMATCH', `candidateSetRef "${request.candidateSetRef.id}" is not the published result of ${source.id}`, {
          fieldPaths: ['candidateSetRef'],
        });
      }

      const scoringPolicyHash = typedHash('policy', deps.scoringPolicy);
      if (request.scoringPolicyRef.sha256 !== scoringPolicyHash) {
        throw new ResearchError(
          'MODEL_UNAVAILABLE',
          `scoring policy "${request.scoringPolicyRef.policyId}" does not match the frozen protocol policy; candidates may not choose their own scorer`,
          { fieldPaths: ['scoringPolicyRef'] }
        );
      }
      const outcome = rankCandidates({
        candidates: synthesis.candidates,
        ctx: { resolvableEvidenceIds: deps.resolvableEvidenceIds, cardsById: deps.cardsById },
        producerOperationId: operationId,
        scoringPolicyHash,
      });

      const requestPath = path.join(stagingDir, 'request.json');
      this.writeJsonAtomic(requestPath, { base, requestHash, candidateSetHash: outcome.result.candidateSetHash, scoringPolicyHash });

      const resultPath = path.join(stagingDir, 'result.json');
      this.writeJsonAtomic(resultPath, outcome.result);

      const resultRef = this.relativeRef(resultPath);
      const published = this.publish(operation, [requestPath, resultPath], resultRef);
      return { receipt: { operationId, commandId: base.commandId, requestHash }, operation: published, result: outcome.result };
    } catch (err) {
      this.failOperation(operation, err);
      this.recordCall(sample, 0, 0);
      throw err;
    }
  }

  // ----------------- read / cancel -----------------

  getResearchOperation(operationId: string, actor: ResearchCallerActor): ResearchOperation {
    this.assertActor(actor);
    const op = this.loadOperation(operationId);
    if (op.ownerSessionId !== actor.sessionId.trim()) {
      throw new ResearchError('OWNER_MISMATCH', `Operation ${operationId} belongs to another owner`);
    }
    return op;
  }

  /** Idempotent stop; cancellation is never gated by the remaining budget. */
  stopResearchOperation(operationId: string, commandId: string, actor: ResearchCallerActor): ResearchOperation {
    this.assertActor(actor);
    const op = this.loadOperation(operationId);
    if (op.ownerSessionId !== actor.sessionId.trim()) {
      throw new ResearchError('OWNER_MISMATCH', `Operation ${operationId} belongs to another owner`);
    }
    if (isTerminal(op.status)) return op;
    if (op.status !== 'stopping') {
      assertStatusTransition(op.status, 'stopping');
      op.status = 'stopping';
      op.updatedAt = new Date().toISOString();
      this.saveDescriptor(op);
    }
    assertStatusTransition('stopping', 'cancelled');
    op.status = 'cancelled';
    op.error = {
      code: 'CANCELLED',
      message: `Cancelled by command ${commandId}`,
      retryable: false,
      fieldPaths: [],
      diagnosticRef: null,
    };
    op.updatedAt = new Date().toISOString();
    this.saveDescriptor(op);
    return op;
  }

  /** Parent session ending cancels everything it owns. */
  cancelOperationsOfSession(sessionId: string, reason: string): ResearchOperation[] {
    const cancelled: ResearchOperation[] = [];
    for (const op of this.listOperations()) {
      if (op.ownerSessionId !== sessionId || isTerminal(op.status)) continue;
      op.status = 'cancelled';
      op.error = { code: 'CANCELLED', message: reason, retryable: false, fieldPaths: [], diagnosticRef: null };
      op.updatedAt = new Date().toISOString();
      this.saveDescriptor(op);
      cancelled.push(op);
    }
    return cancelled;
  }

  static cardContentHash(card: ResearchBaselineCard | ResearchModuleCard): string {
    return typedHash('candidate', card);
  }

}

export function rankBudgetZero(totalTimeoutMs = 30_000): ResearchBudget {
  return { maxCalls: 0, maxInputTokensPerCall: 0, maxOutputTokensPerCall: 0, callTimeoutMs: 30_000, totalTimeoutMs };
}

function requireDraft(draft?: SynthesisDraft): SynthesisDraft {
  if (!draft || !Array.isArray(draft.candidates)) {
    throw new ResearchError('INVALID_INPUT', 'Either a synthesis draft or a model port must be supplied', {
      fieldPaths: ['draft'],
    });
  }
  return draft;
}

/** Input refs are registry ids, never caller-chosen paths. */
function parseInputRefId(id: string): string {
  const match = /^inputs\/([A-Za-z0-9_-]+)$/.exec(id);
  if (!match) {
    throw new ResearchError('INVALID_INPUT', `Input reference "${id}" is not a registered artifact id`, { fieldPaths: ['inputRefs'] });
  }
  return match[1];
}
