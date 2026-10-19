import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  SearchError,
  validateCandidateDraft,
  validateSearchArtifactRef,
  validateSearchNode,
  validateSearchPlan,
  searchFeedbackRef,
  validateSearchFeedbackRecord,
  type ArtifactRef,
  type CandidateDraft,
  type SearchCheckpoint,
  type SearchExecutionIdentity,
  type SearchFeedbackPack,
  type SearchFeedbackRecord,
  type SearchProposalInput,
  type SearchProposalReceipt,
  type SearchSelectionDecision,
  type SearchMetricValue,
  type SearchNode,
  type SearchNodeStatus,
  type SearchPlan,
} from '../contracts/index.ts';
import { canonicalJsonV1, parseJsonStrictV1, typedHash } from '../domain/research-canonical.ts';

const ZERO_HASH = '0'.repeat(64);
const SEARCH_EVENT_TYPES = new Set(['initialized', 'candidate_registered', 'node_transitioned', 'execution_bound', 'evaluation_recorded', 'checkpoint_created', 'search_feedback_recorded']);
const ACTIVE_TRANSITIONS: Record<string, SearchNodeStatus[]> = {
  proposed: ['adapting', 'failed', 'cancelled', 'interrupted'],
  adapting: ['checking', 'failed', 'cancelled', 'interrupted'],
  checking: ['evaluating', 'failed', 'cancelled', 'interrupted'],
  evaluating: ['eligible', 'rejected', 'failed', 'cancelled', 'interrupted'],
};

interface SearchState {
  schemaVersion: 1;
  searchId: string;
  plan: SearchPlan;
  nodes: SearchNode[];
  proposalAttempts: number;
  checkpoint: SearchCheckpoint | null;
}

interface SearchSnapshot {
  schemaVersion: 1;
  revision: number;
  headHash: string;
  state: SearchState;
}

interface SearchEvent {
  schemaVersion: 1;
  revision: number;
  previousHash: string;
  eventType: string;
  payload: Record<string, unknown>;
  state: SearchState;
  eventHash: string;
}

export interface SearchStateStoreOptions {
  directory: string;
  plan: SearchPlan;
}

export interface ExecutionBindingInput {
  executableRef: ArtifactRef;
  phase3OperationId: string;
  phase2OperationId: string;
  identity: SearchExecutionIdentity;
}

export interface VerifiedSearchEvaluation {
  resultRefs: ArtifactRef[];
  costRef: ArtifactRef;
  verifierRef: ArtifactRef;
  metricValues: SearchMetricValue[];
  outcome: 'eligible' | 'rejected';
  rejectionReason?: string;
}

export interface StoredSearchFeedbackRecord {
  record: SearchFeedbackRecord;
  ref: ArtifactRef;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[], at: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new SearchError('RECONCILIATION_REQUIRED', `${at} contains unexpected field "${key}"`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new SearchError('RECONCILIATION_REQUIRED', `${at}.${key} is missing`);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJsonV1(a) === canonicalJsonV1(b);
}

function validateCheckpoint(value: unknown): SearchCheckpoint {
  if (!isRecord(value)) throw new SearchError('RECONCILIATION_REQUIRED', 'checkpoint must be an object');
  exactKeys(value, ['schemaVersion', 'searchId', 'revision', 'treeHash', 'eventHeadHash', 'budgetLedgerRef', 'createdAt', 'checkpointHash'], 'checkpoint');
  if (value.schemaVersion !== 1 || typeof value.searchId !== 'string' || !Number.isSafeInteger(value.revision) ||
      typeof value.treeHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.treeHash) ||
      typeof value.eventHeadHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.eventHeadHash) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.checkpointHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.checkpointHash)) {
    throw new SearchError('RECONCILIATION_REQUIRED', 'checkpoint fields are invalid');
  }
  const budgetLedgerRef = value.budgetLedgerRef as ArtifactRef;
  const core = {
    schemaVersion: 1 as const,
    searchId: value.searchId,
    revision: value.revision as number,
    treeHash: value.treeHash,
    eventHeadHash: value.eventHeadHash,
    budgetLedgerRef,
    createdAt: value.createdAt,
  };
  if (typedHash('search-checkpoint-v1', core) !== value.checkpointHash) {
    throw new SearchError('RECONCILIATION_REQUIRED', 'checkpoint hash does not match its contents');
  }
  return { ...core, checkpointHash: value.checkpointHash };
}

function proposalKeyFor(plan: SearchPlan, candidate: CandidateDraft): string {
  const moduleHashes = candidate.orderedModuleIds.map((moduleId) => {
    const pin = plan.candidateSpace.modulePins.find((entry) => entry.moduleId === moduleId);
    if (!pin) throw new SearchError('INCOMPATIBLE_BINDING', `module "${moduleId}" has no frozen implementation hash`);
    return { moduleId, sha256: pin.implementationSha256 };
  });
  return typedHash('search-proposal-key-v1', {
    baselineRef: plan.baseline.executableRef,
    parentNodeId: candidate.parentNodeId,
    orderedModuleIds: candidate.orderedModuleIds,
    moduleHashes,
    slotId: candidate.slotId,
    hypothesisScope: candidate.hypothesisScope,
  });
}

function executionKeyFor(identity: SearchExecutionIdentity): string {
  return typedHash('search-execution-key-v1', {
    implementationHash: identity.implementationHash,
    recipeHash: identity.recipeHash,
    recipeModuleIds: identity.recipeModuleIds,
    profileRef: identity.profileRef,
    dataSubsetRef: identity.dataSubsetRef,
    evaluatorRef: identity.evaluatorRef,
    pairedSeeds: identity.pairedSeeds,
    trialLimit: identity.trialLimit,
    primaryMetric: identity.primaryMetric,
  });
}

function validateExecutionIdentity(plan: SearchPlan, node: SearchNode, identity: SearchExecutionIdentity): SearchExecutionIdentity {
  if (identity.profileRef !== plan.experimentTemplate.profileRef ||
      !same(identity.dataSubsetRef, plan.experimentTemplate.dataSubsetRef) ||
      !same(identity.evaluatorRef, plan.experimentTemplate.evaluatorRef) ||
      !same(identity.pairedSeeds, plan.experimentTemplate.pairedSeeds) ||
      !same(identity.trialLimit, plan.experimentTemplate.trialLimit) ||
      identity.primaryMetric !== plan.experimentTemplate.primaryMetricId) {
    throw new SearchError('POLICY_DENIED', 'execution identity changes a frozen experiment-template field');
  }
  if (!node.candidate || !same(identity.recipeModuleIds, node.candidate.orderedModuleIds)) {
    throw new SearchError('INCOMPATIBLE_BINDING', 'compiled recipe module IDs differ from the frozen candidate prefix');
  }
  const checked = validateSearchNode({
    schemaVersion: 1,
    searchId: plan.searchId,
    nodeId: node.nodeId,
    kind: node.kind,
    parentNodeId: node.parentNodeId,
    depth: node.depth,
    round: node.round,
    status: 'checking',
    candidate: node.candidate,
    proposalKey: node.proposalKey,
    executionKey: null,
    executionIdentity: identity,
    executableRef: null,
    phase3OperationId: null,
    phase2OperationId: null,
    resultRefs: [],
    costRef: null,
    verifierRef: null,
    metricValues: [],
    duplicateOf: null,
    error: null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  });
  return checked.executionIdentity!;
}

function stateFromUnknown(value: unknown): SearchState {
  if (!isRecord(value)) throw new SearchError('RECONCILIATION_REQUIRED', 'search state must be an object');
  exactKeys(value, ['schemaVersion', 'searchId', 'plan', 'nodes', 'proposalAttempts', 'checkpoint'], 'searchState');
  if (value.schemaVersion !== 1 || typeof value.searchId !== 'string' || !Array.isArray(value.nodes) || !Number.isSafeInteger(value.proposalAttempts)) {
    throw new SearchError('RECONCILIATION_REQUIRED', 'search state header is invalid');
  }
  const plan = validateSearchPlan(value.plan);
  const nodes = value.nodes.map((node) => validateSearchNode(node));
  const checkpoint = value.checkpoint === null ? null : validateCheckpoint(value.checkpoint);
  if (value.searchId !== plan.searchId) throw new SearchError('RECONCILIATION_REQUIRED', 'search state identity differs from its plan');
  const attempts = value.proposalAttempts as number;
  if (attempts < 0 || attempts > plan.limits.maxProposalAttempts || nodes.length < 1 || nodes.length > plan.limits.maxNodes) {
    throw new SearchError('RECONCILIATION_REQUIRED', 'search state exceeds frozen node or proposal-attempt ceilings');
  }
  validateNodeTree(plan, nodes);
  return { schemaVersion: 1, searchId: plan.searchId, plan, nodes, proposalAttempts: attempts, checkpoint };
}

function validateNodeTree(plan: SearchPlan, nodes: SearchNode[]): void {
  const byId = new Map<string, SearchNode>();
  const indexById = new Map<string, number>();
  if (nodes.length === 0) throw new SearchError('RECONCILIATION_REQUIRED', 'search tree has no baseline node');
  for (const [index, raw] of nodes.entries()) {
    const node = validateSearchNode(raw);
    if (byId.has(node.nodeId)) throw new SearchError('RECONCILIATION_REQUIRED', `search tree repeats node ID "${node.nodeId}"`);
    if (node.searchId !== plan.searchId) throw new SearchError('RECONCILIATION_REQUIRED', 'node belongs to a different search');
    byId.set(node.nodeId, node);
    indexById.set(node.nodeId, index);
  }
  const baselineNodes = nodes.filter((node) => node.kind === 'baseline');
  const baseline = baselineNodes[0];
  if (baselineNodes.length !== 1 || baseline.nodeId !== 'baseline' || baseline.parentNodeId !== null || baseline.depth !== 0 || baseline.status !== 'eligible' ||
      !same(baseline.executableRef, plan.baseline.executableRef) || !baseline.resultRefs.some((ref) => same(ref, plan.baseline.runnerResultRef)) ||
      !same(baseline.costRef, plan.baseline.costRef)) {
    throw new SearchError('RECONCILIATION_REQUIRED', 'baseline node is inconsistent with frozen baseline evidence');
  }

  const proposalCanonical = new Map<string, SearchNode>();
  const executionCanonical = new Map<string, SearchNode>();
  for (const node of nodes) {
    if (node.kind === 'baseline') continue;
    if (!node.candidate || !node.parentNodeId) throw new SearchError('RECONCILIATION_REQUIRED', 'candidate node has no candidate or parent');
    const parent = byId.get(node.parentNodeId);
    if (!parent || parent.status !== 'eligible') throw new SearchError('RECONCILIATION_REQUIRED', `node "${node.nodeId}" has a missing or ineligible parent`);
    if (node.kind !== 'combination') throw new SearchError('RECONCILIATION_REQUIRED', 'the frozen finite search does not permit repair nodes');
    const prefix = plan.candidateSpace.legalPrefixes.find((entry) => entry.variantId === node.candidate!.candidateId);
    if (!prefix || !same(prefix.moduleIds, node.candidate.orderedModuleIds) || node.depth !== prefix.moduleIds.length || node.round !== node.depth ||
        node.candidate.slotId !== plan.candidateSpace.slotId || node.candidate.repairOfNodeId !== null) {
      throw new SearchError('RECONCILIATION_REQUIRED', `node "${node.nodeId}" is outside the frozen ordered candidate space`);
    }
    const parentModules = parent.candidate?.orderedModuleIds ?? [];
    if (prefix.moduleIds.length !== parentModules.length + 1 || !same(prefix.moduleIds.slice(0, -1), parentModules) ||
        !same(node.candidate.addedModuleIds, [prefix.moduleIds[prefix.moduleIds.length - 1]])) {
      throw new SearchError('RECONCILIATION_REQUIRED', `node "${node.nodeId}" does not append exactly one module to its parent`);
    }
    const expectedProposalKey = proposalKeyFor(plan, node.candidate);
    if (node.proposalKey !== expectedProposalKey) throw new SearchError('RECONCILIATION_REQUIRED', `node "${node.nodeId}" proposal key does not match its frozen inputs`);
    const priorProposal = proposalCanonical.get(expectedProposalKey);
    if (priorProposal) {
      if (node.status !== 'duplicate' || node.duplicateOf !== priorProposal.nodeId) {
        throw new SearchError('RECONCILIATION_REQUIRED', `proposal duplicate node "${node.nodeId}" is not linked to its canonical node`);
      }
    } else {
      proposalCanonical.set(expectedProposalKey, node);
    }
    if (node.executionIdentity) {
      const expectedExecutionKey = executionKeyFor(node.executionIdentity);
      if (node.executionKey !== expectedExecutionKey || !same(node.executionIdentity.recipeModuleIds, node.candidate.orderedModuleIds)) {
        throw new SearchError('RECONCILIATION_REQUIRED', `node "${node.nodeId}" execution key does not match its compiled recipe identity`);
      }
      const priorExecution = executionCanonical.get(expectedExecutionKey);
      if (priorExecution && (node.status !== 'duplicate' || node.duplicateOf !== priorExecution.nodeId)) {
        throw new SearchError('RECONCILIATION_REQUIRED', `execution duplicate node "${node.nodeId}" is not linked to its canonical node`);
      }
      if (!priorExecution) executionCanonical.set(expectedExecutionKey, node);
    } else if (node.executionKey !== null) {
      throw new SearchError('RECONCILIATION_REQUIRED', `node "${node.nodeId}" has an execution key without its frozen identity fields`);
    }
    if (node.duplicateOf !== null) {
      const duplicateTarget = byId.get(node.duplicateOf);
      if (!duplicateTarget || duplicateTarget.nodeId === node.nodeId || indexById.get(duplicateTarget.nodeId)! >= indexById.get(node.nodeId)!) {
        throw new SearchError('RECONCILIATION_REQUIRED', `node "${node.nodeId}" points to an invalid duplicate target`);
      }
    }
  }
}

export class SearchStateStore {
  private readonly directory: string;
  private readonly eventsPath: string;
  private readonly snapshotPath: string;
  private readonly lockPath: string;
  private readonly lockToken: string;
  private state: SearchState;
  private feedbackRecords: StoredSearchFeedbackRecord[];
  private revision: number;
  private headHash: string;
  private poisoned = false;
  private closed = false;

  private constructor(directory: string, lockToken: string, state: SearchState, revision: number, headHash: string, feedbackRecords: StoredSearchFeedbackRecord[] = []) {
    this.directory = directory;
    this.eventsPath = path.join(directory, 'events.jsonl');
    this.snapshotPath = path.join(directory, 'snapshot.json');
    this.lockPath = path.join(directory, '.writer.lock');
    this.lockToken = lockToken;
    this.state = state;
    this.feedbackRecords = feedbackRecords;
    this.revision = revision;
    this.headHash = headHash;
  }

  static create(options: SearchStateStoreOptions): SearchStateStore {
    const plan = validateSearchPlan(options.plan);
    fs.mkdirSync(options.directory, { recursive: true });
    const eventsPath = path.join(options.directory, 'events.jsonl');
    const snapshotPath = path.join(options.directory, 'snapshot.json');
    if (fs.existsSync(eventsPath) || fs.existsSync(snapshotPath)) throw new SearchError('IDEMPOTENCY_CONFLICT', 'search state already exists; open it for reconciliation');
    const lockToken = SearchStateStore.acquireLock(options.directory);
    const now = new Date().toISOString();
    const baseline = validateSearchNode({
      schemaVersion: 1,
      searchId: plan.searchId,
      nodeId: 'baseline',
      kind: 'baseline',
      parentNodeId: null,
      depth: 0,
      round: 0,
      status: 'eligible',
      candidate: null,
      proposalKey: null,
      executionKey: null,
      executionIdentity: null,
      executableRef: plan.baseline.executableRef,
      phase3OperationId: plan.baseline.campaignRef.id,
      phase2OperationId: plan.baseline.runnerResultRef.id,
      resultRefs: [plan.baseline.campaignRef, plan.baseline.runnerResultRef],
      costRef: plan.baseline.costRef,
      verifierRef: null,
      metricValues: plan.baseline.observations.map(({ seed, metricId, value, unit, split }) => ({ seed, metricId, value, unit, split })),
      duplicateOf: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    const state = stateFromUnknown({ schemaVersion: 1, searchId: plan.searchId, plan, nodes: [baseline], proposalAttempts: 0, checkpoint: null });
    const store = new SearchStateStore(options.directory, lockToken, state, 0, ZERO_HASH);
    try {
      store.commit('initialized', { baselineNodeId: baseline.nodeId }, state);
      return store;
    } catch (error) {
      store.releaseLock();
      throw error;
    }
  }

  static open(directory: string, expectedPlan?: SearchPlan): SearchStateStore {
    const lockToken = SearchStateStore.acquireLock(directory);
    try {
      const eventsPath = path.join(directory, 'events.jsonl');
      const snapshotPath = path.join(directory, 'snapshot.json');
      if (!fs.existsSync(eventsPath) || !fs.existsSync(snapshotPath)) throw new SearchError('RECONCILIATION_REQUIRED', 'search event log or snapshot is missing');
      const text = fs.readFileSync(eventsPath, 'utf8');
      if (!text.endsWith('\n')) throw new SearchError('RECONCILIATION_REQUIRED', 'search event log has a partial final record');
      const lines = text.slice(0, -1).split('\n');
      if (lines.length === 0 || lines.some((line) => line.length === 0)) throw new SearchError('RECONCILIATION_REQUIRED', 'search event log has an empty record');
      let previousHash = ZERO_HASH;
      let revision = 0;
      let state: SearchState | null = null;
      const feedbackRecords: StoredSearchFeedbackRecord[] = [];
      const checkpointEvents = new Map<string, SearchCheckpoint>();
      for (const [index, line] of lines.entries()) {
        const parsed = parseJsonStrictV1(line);
        if (!isRecord(parsed)) throw new SearchError('RECONCILIATION_REQUIRED', `event ${index + 1} is not an object`);
        exactKeys(parsed, ['schemaVersion', 'revision', 'previousHash', 'eventType', 'payload', 'state', 'eventHash'], `event[${index}]`);
        if (parsed.schemaVersion !== 1 || parsed.revision !== revision + 1 || parsed.previousHash !== previousHash ||
            typeof parsed.eventType !== 'string' || !SEARCH_EVENT_TYPES.has(parsed.eventType) || !isRecord(parsed.payload) || typeof parsed.eventHash !== 'string') {
          throw new SearchError('RECONCILIATION_REQUIRED', `event ${index + 1} has an invalid header or chain link`);
        }
        const eventState = stateFromUnknown(parsed.state);
        if (state && !same(eventState.plan, state.plan)) throw new SearchError('RECONCILIATION_REQUIRED', 'search plan changed inside the event log');
        if (parsed.eventType === 'search_feedback_recorded') {
          if (!state || !same(eventState, state)) throw new SearchError('RECONCILIATION_REQUIRED', `feedback event ${index + 1} changed the search state`);
          feedbackRecords.push(SearchStateStore.validateFeedbackJournalPayload(parsed.payload, state, feedbackRecords, revision));
        } else if (parsed.eventType === 'candidate_registered' && feedbackRecords.length > 0) {
          SearchStateStore.validateCandidateFeedbackLineage(eventState, feedbackRecords, parsed.payload);
        }
        const core = {
          schemaVersion: 1 as const,
          revision: parsed.revision as number,
          previousHash: previousHash,
          eventType: parsed.eventType,
          payload: parsed.payload,
          state: eventState,
        };
        const eventHash = typedHash('search-state-event-v1', core);
        if (eventHash !== parsed.eventHash) throw new SearchError('RECONCILIATION_REQUIRED', `event ${index + 1} hash does not match`);
        if (index === 0 && parsed.eventType !== 'initialized') throw new SearchError('RECONCILIATION_REQUIRED', 'first search event is not initialization');
        if (index > 0 && parsed.eventType === 'initialized') throw new SearchError('RECONCILIATION_REQUIRED', 'search initialization event appears after the first revision');
        if (parsed.eventType === 'checkpoint_created') {
          const checkpoint = validateCheckpoint(parsed.payload.checkpoint);
          if (checkpoint.revision !== revision || checkpoint.eventHeadHash !== previousHash ||
              checkpoint.searchId !== eventState.searchId || checkpoint.treeHash !== typedHash('search-tree-v1', eventState.nodes) ||
              !same(checkpoint.budgetLedgerRef, eventState.plan.rootBudgetRef) || !same(eventState.checkpoint, checkpoint) ||
              !same(eventState.nodes, state?.nodes ?? [])) {
            throw new SearchError('RECONCILIATION_REQUIRED', `checkpoint event ${index + 1} does not match its prior tree`);
          }
          checkpointEvents.set(checkpoint.checkpointHash, checkpoint);
        }
        state = eventState;
        revision = parsed.revision as number;
        previousHash = eventHash;
      }
      if (!state) throw new SearchError('RECONCILIATION_REQUIRED', 'search log contains no state');
      if (expectedPlan && !same(validateSearchPlan(expectedPlan), state.plan)) throw new SearchError('SOURCE_MISMATCH', 'expected SearchPlan differs from persisted plan');
      if (state.checkpoint && !checkpointEvents.has(state.checkpoint.checkpointHash)) throw new SearchError('RECONCILIATION_REQUIRED', 'latest checkpoint is not committed in the event log');
      const snapshotRaw = parseJsonStrictV1(fs.readFileSync(snapshotPath, 'utf8'));
      if (!isRecord(snapshotRaw)) throw new SearchError('RECONCILIATION_REQUIRED', 'search snapshot is not an object');
      exactKeys(snapshotRaw, ['schemaVersion', 'revision', 'headHash', 'state'], 'searchSnapshot');
      const snapshotState = stateFromUnknown(snapshotRaw.state);
      const snapshot: SearchSnapshot = {
        schemaVersion: snapshotRaw.schemaVersion as 1,
        revision: snapshotRaw.revision as number,
        headHash: snapshotRaw.headHash as string,
        state: snapshotState,
      };
      if (snapshot.schemaVersion !== 1 || snapshot.revision !== revision || snapshot.headHash !== previousHash || !same(snapshot.state, state)) {
        throw new SearchError('RECONCILIATION_REQUIRED', 'snapshot does not match the verified event-log head');
      }
      return new SearchStateStore(directory, lockToken, state, revision, previousHash, feedbackRecords);
    } catch (error) {
      SearchStateStore.releaseLockFile(directory, lockToken);
      throw error;
    }
  }

  getPlan(): SearchPlan { this.ensureReadable(); return clone(this.state.plan); }
  getNodes(): SearchNode[] { this.ensureReadable(); return clone(this.state.nodes); }
  getRevision(): number { this.ensureReadable(); return this.revision; }
  getProposalAttempts(): number { this.ensureReadable(); return this.state.proposalAttempts; }
  getCheckpoint(): SearchCheckpoint | null { this.ensureReadable(); return this.state.checkpoint ? clone(this.state.checkpoint) : null; }
  getFeedbackRecords(): StoredSearchFeedbackRecord[] { this.ensureReadable(); return clone(this.feedbackRecords); }

  recordFeedbackRecord(recordInput: SearchFeedbackRecord): StoredSearchFeedbackRecord {
    this.ensureWritable();
    const record = validateSearchFeedbackRecord(recordInput);
    const ref = searchFeedbackRef(record);
    const stored = SearchStateStore.validateFeedbackRecordAgainstState(record, ref, this.state, this.revision, this.feedbackRecords);
    this.commit('search_feedback_recorded', { record: stored.record, ref: stored.ref }, this.state);
    this.feedbackRecords.push(stored);
    return clone(stored);
  }

  registerCandidate(candidateInput: CandidateDraft): { node: SearchNode; duplicateOf: string | null } {
    this.ensureWritable();
    const candidate = validateCandidateDraft(candidateInput);
    if (this.feedbackRecords.length > 0) SearchStateStore.validateCandidateFeedbackLineage(this.state, this.feedbackRecords, { nodeId: null, candidate });
    if (candidate.repairOfNodeId !== null) {
      throw new SearchError('POLICY_DENIED', 'repair candidates are forbidden by this frozen finite search');
    }
    if (this.state.proposalAttempts >= this.state.plan.limits.maxProposalAttempts) throw new SearchError('BUDGET_EXHAUSTED', 'proposal-attempt ceiling is exhausted');
    if (this.state.nodes.length >= this.state.plan.limits.maxNodes) throw new SearchError('BUDGET_EXHAUSTED', 'search-node ceiling is exhausted');
    const parent = this.state.nodes.find((node) => node.nodeId === candidate.parentNodeId);
    if (!parent) throw new SearchError('NOT_FOUND', `parent node "${candidate.parentNodeId}" was not found`);
    if (parent.status !== 'eligible') throw new SearchError('DEPENDENCY_NOT_READY', 'only an eligible verified node may parent a candidate');
    const prefix = this.state.plan.candidateSpace.legalPrefixes.find((entry) => entry.variantId === candidate.candidateId);
    const parentModules = parent.candidate?.orderedModuleIds ?? [];
    if (!prefix || candidate.slotId !== this.state.plan.candidateSpace.slotId || !same(prefix.moduleIds, candidate.orderedModuleIds) ||
        prefix.moduleIds.length !== parentModules.length + 1 || !same(prefix.moduleIds.slice(0, -1), parentModules) ||
        !same(candidate.addedModuleIds, [prefix.moduleIds[prefix.moduleIds.length - 1]])) {
      throw new SearchError('INCOMPATIBLE_BINDING', 'candidate is not the next frozen ordered prefix under its parent');
    }
    const proposalKey = proposalKeyFor(this.state.plan, candidate);
    const prior = this.state.nodes.find((node) => node.proposalKey === proposalKey) ?? null;
    const now = new Date().toISOString();
    const node = validateSearchNode({
      schemaVersion: 1,
      searchId: this.state.searchId,
      nodeId: `node-${String(this.state.nodes.length).padStart(4, '0')}`,
      kind: 'combination',
      parentNodeId: parent.nodeId,
      depth: prefix.moduleIds.length,
      round: prefix.moduleIds.length,
      status: prior ? 'duplicate' : 'proposed',
      candidate,
      proposalKey,
      executionKey: null,
      executionIdentity: null,
      executableRef: null,
      phase3OperationId: null,
      phase2OperationId: null,
      resultRefs: [],
      costRef: null,
      verifierRef: null,
      metricValues: [],
      duplicateOf: prior?.nodeId ?? null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    const next = stateFromUnknown({
      ...this.state,
      nodes: [...this.state.nodes, node],
      proposalAttempts: this.state.proposalAttempts + 1,
    });
    this.commit('candidate_registered', { nodeId: node.nodeId, proposalKey, duplicateOf: node.duplicateOf }, next);
    return { node: clone(node), duplicateOf: node.duplicateOf };
  }

  transitionNode(nodeId: string, nextStatus: 'adapting' | 'checking' | 'evaluating' | 'failed' | 'cancelled' | 'interrupted', error?: { code: string; message: string; diagnosticRef: ArtifactRef | null }): SearchNode {
    this.ensureWritable();
    const index = this.requireCandidateIndex(nodeId);
    const current = this.state.nodes[index];
    const allowed = ACTIVE_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(nextStatus)) throw new SearchError('INVALID_TRANSITION', `cannot move search node from ${current.status} to ${nextStatus}`);
    if (nextStatus === 'evaluating' && (!current.executionKey || !current.executionIdentity || !current.executableRef || !current.phase2OperationId || !current.phase3OperationId)) {
      throw new SearchError('DEPENDENCY_NOT_READY', 'candidate execution must be bound before entering evaluation');
    }
    if ((nextStatus === 'failed' || nextStatus === 'cancelled' || nextStatus === 'interrupted') && !error) {
      throw new SearchError('INVALID_INPUT', `${nextStatus} transition requires an error record`);
    }
    if (error) {
      if (error.code.trim() === '' || error.message.trim() === '') throw new SearchError('INVALID_INPUT', 'node error code and message must be non-empty');
    }
    const node = validateSearchNode({ ...current, status: nextStatus, error: error ?? null, updatedAt: new Date().toISOString() });
    const nodes = [...this.state.nodes];
    nodes[index] = node;
    const next = stateFromUnknown({ ...this.state, nodes });
    this.commit('node_transitioned', { nodeId, from: current.status, to: nextStatus, error: error ?? null }, next);
    return clone(node);
  }

  bindExecution(nodeId: string, input: ExecutionBindingInput): { node: SearchNode; duplicateOf: string | null; replay: boolean } {
    this.ensureWritable();
    const index = this.requireCandidateIndex(nodeId);
    const current = this.state.nodes[index];
    if (current.status !== 'checking') throw new SearchError('INVALID_TRANSITION', 'execution can only be bound after checks and before evaluation');
    const identity = validateExecutionIdentity(this.state.plan, current, input.identity);
    const executionKey = executionKeyFor(identity);
    const executableRef = input.executableRef;
    const phase3OperationId = input.phase3OperationId.trim();
    const phase2OperationId = input.phase2OperationId.trim();
    if (!phase3OperationId || !phase2OperationId) throw new SearchError('INVALID_INPUT', 'both Phase 3 and Phase 2 operation IDs are required');
    if (current.executionKey) {
      if (current.executionKey !== executionKey || !same(current.executableRef, executableRef) ||
          current.phase3OperationId !== phase3OperationId || current.phase2OperationId !== phase2OperationId) {
        throw new SearchError('IDEMPOTENCY_CONFLICT', 'node already has a different execution binding');
      }
      return { node: clone(current), duplicateOf: null, replay: true };
    }
    const prior = this.state.nodes.find((node) => node.nodeId !== nodeId && node.executionKey === executionKey) ?? null;
    const node = validateSearchNode({
      ...current,
      status: prior ? 'duplicate' : 'checking',
      executionKey,
      executionIdentity: identity,
      executableRef,
      phase3OperationId: prior ? null : phase3OperationId,
      phase2OperationId: prior ? null : phase2OperationId,
      duplicateOf: prior?.nodeId ?? current.duplicateOf,
      updatedAt: new Date().toISOString(),
    });
    const nodes = [...this.state.nodes];
    nodes[index] = node;
    const next = stateFromUnknown({ ...this.state, nodes });
    this.commit('execution_bound', { nodeId, executionKey, duplicateOf: node.duplicateOf, operationIds: prior ? null : { phase3OperationId, phase2OperationId } }, next);
    return { node: clone(node), duplicateOf: node.duplicateOf, replay: false };
  }

  recordVerifiedEvaluation(nodeId: string, evaluation: VerifiedSearchEvaluation): SearchNode {
    this.ensureWritable();
    const index = this.requireCandidateIndex(nodeId);
    const current = this.state.nodes[index];
    if (current.status !== 'evaluating' || !current.executionKey || !current.executionIdentity || !current.phase2OperationId || !current.phase3OperationId) {
      throw new SearchError('INVALID_TRANSITION', 'verified results require a bound execution in evaluating status');
    }
    if (evaluation.resultRefs.length === 0) throw new SearchError('INVALID_INPUT', 'verified evaluation requires result artifacts');
    if (evaluation.outcome === 'rejected' && !evaluation.rejectionReason?.trim()) throw new SearchError('INVALID_INPUT', 'a rejected node requires its frozen decision reason');
    const metricValues = this.validateMetricVector(evaluation.metricValues);
    const node = validateSearchNode({
      ...current,
      status: evaluation.outcome,
      resultRefs: evaluation.resultRefs,
      costRef: evaluation.costRef,
      verifierRef: evaluation.verifierRef,
      metricValues,
      error: evaluation.outcome === 'rejected'
        ? { code: 'VALIDATION_REJECTED', message: evaluation.rejectionReason!.trim(), diagnosticRef: evaluation.verifierRef }
        : null,
      updatedAt: new Date().toISOString(),
    });
    const nodes = [...this.state.nodes];
    nodes[index] = node;
    const next = stateFromUnknown({ ...this.state, nodes });
    this.commit('evaluation_recorded', {
      nodeId,
      outcome: evaluation.outcome,
      resultRefs: evaluation.resultRefs,
      costRef: evaluation.costRef,
      verifierRef: evaluation.verifierRef,
    }, next);
    return clone(node);
  }

  checkpoint(): SearchCheckpoint {
    this.ensureWritable();
    const core = {
      schemaVersion: 1 as const,
      searchId: this.state.searchId,
      revision: this.revision,
      treeHash: typedHash('search-tree-v1', this.state.nodes),
      eventHeadHash: this.headHash,
      budgetLedgerRef: this.state.plan.rootBudgetRef,
      createdAt: new Date().toISOString(),
    };
    const checkpoint: SearchCheckpoint = { ...core, checkpointHash: typedHash('search-checkpoint-v1', core) };
    const next = stateFromUnknown({ ...this.state, checkpoint });
    this.commit('checkpoint_created', { checkpoint }, next);
    return clone(checkpoint);
  }

  close(): void {
    if (this.closed) return;
    this.releaseLock();
    this.closed = true;
  }

  private validateMetricVector(input: SearchMetricValue[]): SearchMetricValue[] {
    const plan = this.state.plan;
    const expected = new Set<string>();
    for (const seed of plan.experimentTemplate.pairedSeeds) {
      for (const spec of plan.experimentTemplate.metricSpecs) expected.add(`${seed}\u0000${spec.id}`);
    }
    const seen = new Set<string>();
    for (const metric of input) {
      const spec = plan.experimentTemplate.metricSpecs.find((item) => item.id === metric.metricId);
      if (!spec || metric.split !== 'validation' || metric.unit !== spec.unit || !Number.isFinite(metric.value) ||
          metric.value < spec.validRange[0] || metric.value > spec.validRange[1]) {
        throw new SearchError('SCHEMA_VIOLATION', `metric "${metric.metricId}" is outside the frozen validation metric contract`);
      }
      const key = `${metric.seed}\u0000${metric.metricId}`;
      if (!expected.has(key) || seen.has(key)) throw new SearchError('SCHEMA_VIOLATION', 'metric vector has an unexpected or duplicate seed/metric pair');
      seen.add(key);
    }
    if (seen.size !== expected.size) throw new SearchError('SCHEMA_VIOLATION', 'metric vector must contain every frozen metric for every paired seed');
    const order = new Map(plan.experimentTemplate.metricSpecs.map((item, index) => [item.id, index]));
    return [...input].sort((a, b) => a.seed - b.seed || (order.get(a.metricId)! - order.get(b.metricId)!));
  }

  private requireCandidateIndex(nodeId: string): number {
    const index = this.state.nodes.findIndex((node) => node.nodeId === nodeId);
    if (index < 0) throw new SearchError('NOT_FOUND', `search node "${nodeId}" was not found`);
    if (this.state.nodes[index].kind === 'baseline') throw new SearchError('POLICY_DENIED', 'baseline is immutable');
    return index;
  }

  private commit(eventType: string, payload: Record<string, unknown>, nextState: SearchState): void {
    this.ensureWritable();
    const revision = this.revision + 1;
    const core = { schemaVersion: 1 as const, revision, previousHash: this.headHash, eventType, payload, state: nextState };
    const event: SearchEvent = { ...core, eventHash: typedHash('search-state-event-v1', core) };
    try {
      fs.appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
      const snapshot: SearchSnapshot = { schemaVersion: 1, revision, headHash: event.eventHash, state: nextState };
      const temporary = `${this.snapshotPath}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(snapshot), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, this.snapshotPath);
      this.state = nextState;
      this.revision = revision;
      this.headHash = event.eventHash;
    } catch (error) {
      this.poisoned = true;
      throw new SearchError('RECONCILIATION_REQUIRED', `durable search commit failed at revision ${revision}: ${String(error)}`);
    }
  }

  private static validateFeedbackJournalPayload(
    payload: Record<string, unknown>,
    state: SearchState,
    priorRecords: StoredSearchFeedbackRecord[],
    basisRevision: number,
  ): StoredSearchFeedbackRecord {
    exactKeys(payload, ['record', 'ref'], 'searchFeedbackEvent.payload');
    const record = validateSearchFeedbackRecord(payload.record);
    const ref = validateSearchArtifactRef(payload.ref, 'searchFeedbackEvent.ref');
    const stored = SearchStateStore.validateFeedbackRecordAgainstState(record, ref, state, basisRevision, priorRecords);
    if (!same(stored, { record, ref })) throw new SearchError('RECONCILIATION_REQUIRED', 'search feedback journal envelope is not canonical');
    return stored;
  }

  private static validateFeedbackRecordAgainstState(
    record: SearchFeedbackRecord,
    ref: ArtifactRef,
    state: SearchState,
    basisRevision: number,
    priorRecords: StoredSearchFeedbackRecord[],
  ): StoredSearchFeedbackRecord {
    if (record.searchId !== state.searchId || !same(record.planRef, state.plan.planRef)) throw new SearchError('SOURCE_MISMATCH', 'feedback record belongs to a different search plan');
    if (record.basisRevision !== basisRevision || record.treeHash !== typedHash('search-tree-v1', state.nodes)) throw new SearchError('SOURCE_MISMATCH', 'feedback record is based on a stale revision or node tree');
    if (record.round > state.plan.limits.requiredRounds) throw new SearchError('POLICY_DENIED', 'feedback record exceeds the frozen round limit');
    const expectedRef = searchFeedbackRef(record);
    if (!same(ref, expectedRef)) throw new SearchError('SOURCE_MISMATCH', 'feedback evidence ref does not match its canonical record hash');
    if (priorRecords.some((entry) => entry.record.recordId === record.recordId || (entry.record.kind === record.kind && entry.record.round === record.round))) {
      throw new SearchError('IDEMPOTENCY_CONFLICT', `duplicate ${record.kind} record for round ${record.round}`);
    }
    const roundRecords = priorRecords.filter((entry) => entry.record.round === record.round);
    const findPrior = <T extends SearchFeedbackRecord>(wantedRef: ArtifactRef, kind: T['kind']): T => {
      const entry = priorRecords.find((candidate) => candidate.record.kind === kind && same(candidate.ref, wantedRef));
      if (!entry) throw new SearchError('DEPENDENCY_NOT_READY', `${record.kind} references a missing earlier ${kind} record`);
      return entry.record as T;
    };
    const receipts = [...priorRecords.map((entry) => entry.record), ...(record.kind === 'proposal_receipt' ? [record] : [])]
      .filter((entry): entry is SearchProposalReceipt => entry.kind === 'proposal_receipt');
    const modelCalls = receipts.reduce((sum, receipt) => sum + receipt.actualModelCalls, 0);
    const totalTokens = receipts.reduce((sum, receipt) => sum + receipt.inputTokens + receipt.outputTokens, 0);
    if (modelCalls > state.plan.proposalProfile.maxModelCalls || totalTokens > state.plan.proposalProfile.maxTotalTokens) throw new SearchError('BUDGET_EXHAUSTED', 'proposal evidence exceeds the frozen model-call or token budget');

    if (record.kind === 'feedback_pack') {
      if (roundRecords.length !== 0) throw new SearchError('INVALID_TRANSITION', `round ${record.round} feedback pack must be its first evidence record`);
      const priorReceipt = record.round === 1 ? undefined : priorRecords.find((entry) => entry.record.kind === 'proposal_receipt' && entry.record.round === record.round - 1);
      if (record.round > 1) {
        if (!priorReceipt || priorReceipt.record.kind !== 'proposal_receipt' || priorReceipt.record.result.kind !== 'candidate') throw new SearchError('DEPENDENCY_NOT_READY', `round ${record.round} requires a prior candidate receipt`);
        const selectedCandidateId = priorReceipt.record.result.candidate.candidateId;
        const evaluated = state.nodes.find((node) => node.candidate?.candidateId === selectedCandidateId && node.status === 'eligible');
        if (!evaluated || evaluated.depth !== record.round - 1 || evaluated.parentNodeId !== priorReceipt.record.result.candidate.parentNodeId) {
          throw new SearchError('DEPENDENCY_NOT_READY', `round ${record.round} requires its prior candidate to have a verified eligible evaluation`);
        }
      }
      SearchStateStore.validateFeedbackPackAgainstState(record, state, priorRecords);
    } else if (record.kind === 'selection_decision') {
      const pack = findPrior<SearchFeedbackPack>(record.feedbackPackRef, 'feedback_pack');
      if (pack.round !== record.round || pack.treeHash !== record.treeHash || !same(pack.planRef, record.planRef)) throw new SearchError('SOURCE_MISMATCH', 'selection decision does not use its round feedback pack');
      const available = new Map(pack.legalNextPrefixes.map((prefix) => [`${prefix.parentNodeId}\u0000${prefix.candidateId}`, prefix]));
      const ranked = new Set<string>();
      for (const item of record.rankedParents) {
        if (ranked.has(item.nodeId)) throw new SearchError('SCHEMA_VIOLATION', 'selection decision ranks a parent more than once');
        ranked.add(item.nodeId);
        const evidence = pack.eligibleParents.find((parent) => parent.nodeId === item.nodeId);
        if (!evidence || evidence.actualExecutionMs !== item.actualExecutionMs || !same(evidence.costRef, item.costRef)) throw new SearchError('SOURCE_MISMATCH', `selection score for ${item.nodeId} does not match feedback evidence`);
        const primary = evidence.metricEvidence.filter((metric) => metric.metricId === pack.primaryMetricId).map((metric) => metric.value);
        const mean = primary.reduce((sum, value) => sum + value, 0) / primary.length;
        if (mean !== item.primaryMetricMean || ![...available.keys()].some((key) => key.startsWith(`${item.nodeId}\u0000`))) throw new SearchError('SOURCE_MISMATCH', `selection parent ${item.nodeId} is not scored from its verified next-prefix evidence`);
      }
      if (record.rankedParents.length !== available.size) throw new SearchError('SOURCE_MISMATCH', 'selection decision must rank every parent with an available legal prefix');
      const metricDirection = state.plan.experimentTemplate.metricSpecs.find((metric) => metric.id === state.plan.experimentTemplate.primaryMetricId)!.direction;
      const ordered = [...record.rankedParents].sort((a, b) => (metricDirection === 'minimize' ? a.primaryMetricMean - b.primaryMetricMean : b.primaryMetricMean - a.primaryMetricMean) || a.actualExecutionMs - b.actualExecutionMs || a.nodeId.localeCompare(b.nodeId));
      if (!same(record.rankedParents, ordered)) throw new SearchError('SOURCE_MISMATCH', 'selection parent ranking violates the frozen deterministic tie-break');
      if (record.selected) {
        const prefix = available.get(`${record.selected.parentNodeId}\u0000${record.selected.candidateId}`);
        if (!prefix || !same(prefix.orderedModuleIds, record.selected.orderedModuleIds) || prefix.addedModuleId !== record.selected.addedModuleId ||
            record.rankedParents[0]?.nodeId !== record.selected.parentNodeId || record.stopReason !== null) {
          throw new SearchError('POLICY_DENIED', 'selected mutation is not the deterministic highest-ranked legal prefix');
        }
      } else if (record.stopReason === 'proposal_attempt_budget_exhausted' && state.proposalAttempts < state.plan.limits.maxProposalAttempts) {
        throw new SearchError('SOURCE_MISMATCH', 'selection claims exhausted proposal attempts before the frozen limit');
      } else if (record.stopReason === 'node_budget_exhausted' && state.nodes.length < state.plan.limits.maxNodes) {
        throw new SearchError('SOURCE_MISMATCH', 'selection claims exhausted node capacity before the frozen limit');
      } else if (record.stopReason === 'finite_prefix_space_exhausted' && pack.legalNextPrefixes.length > 0) {
        throw new SearchError('SOURCE_MISMATCH', 'selection claims exhausted prefix space while a legal prefix remains');
      }
    } else if (record.kind === 'proposal_input') {
      const pack = findPrior<SearchFeedbackPack>(record.feedbackPackRef, 'feedback_pack');
      const decision = findPrior<SearchSelectionDecision>(record.selectionDecisionRef, 'selection_decision');
      if (pack.round !== record.round || decision.round !== record.round || decision.feedbackPackRef.sha256 !== record.feedbackPackRef.sha256 ||
          !same(record.envelope.feedbackPack, pack) || !same(record.envelope.selectionDecision, decision) || !decision.selected ||
          record.envelope.round !== record.round || record.envelope.taskId !== state.plan.taskId || record.envelope.primaryMetricId !== state.plan.experimentTemplate.primaryMetricId ||
          record.envelope.candidateSpace.slotId !== state.plan.candidateSpace.slotId || !same(record.envelope.candidateSpace.orderedModuleIds, state.plan.candidateSpace.orderedModuleIds) ||
          !same(record.envelope.candidateSpace.legalPrefixes, state.plan.candidateSpace.legalPrefixes) ||
          !same(record.envelope.candidateSpace.forbiddenChanges, state.plan.candidateSpace.forbiddenChanges) ||
          record.envelope.experimentTemplate.profileRef !== state.plan.experimentTemplate.profileRef ||
          !same(record.envelope.experimentTemplate.dataSubsetRef, state.plan.experimentTemplate.dataSubsetRef) ||
          !same(record.envelope.experimentTemplate.evaluatorRef, state.plan.experimentTemplate.evaluatorRef) ||
          !same(record.envelope.experimentTemplate.pairedSeeds, state.plan.experimentTemplate.pairedSeeds) ||
          !same(record.envelope.experimentTemplate.trialLimit, state.plan.experimentTemplate.trialLimit)) {
        throw new SearchError('SOURCE_MISMATCH', 'proposal input does not preserve the exact frozen plan and verified feedback');
      }
    } else {
      const input = findPrior<SearchProposalInput>(record.proposalInputRef, 'proposal_input');
      if (input.round !== record.round || input.inputHash !== record.inputHash) throw new SearchError('SOURCE_MISMATCH', 'proposal receipt input ref or hash does not match');
      const selected = input.envelope.selectionDecision.selected;
      if (record.result.kind === 'candidate') {
        if (!selected || record.result.candidate.parentNodeId !== selected.parentNodeId || record.result.candidate.candidateId !== selected.candidateId ||
            record.result.candidate.slotId !== state.plan.candidateSpace.slotId || !same(record.result.candidate.orderedModuleIds, selected.orderedModuleIds) ||
            !same(record.result.candidate.addedModuleIds, [selected.addedModuleId])) throw new SearchError('POLICY_DENIED', 'proposal receipt candidate differs from deterministic selected mutation');
      }
      if (record.source === 'live_model' && !state.plan.proposalProfile.liveProviderBudgetVerified) throw new SearchError('POLICY_DENIED', 'live proposal is blocked until the provider budget is verified and frozen');
    }
    return { record: clone(record), ref: clone(ref) };
  }

  private static validateFeedbackPackAgainstState(pack: SearchFeedbackPack, state: SearchState, priorRecords: StoredSearchFeedbackRecord[]): void {
    const plan = state.plan;
    const denominator = plan.experimentTemplate.pairedSeeds.flatMap((seed) => plan.experimentTemplate.metricSpecs.map((metric) => `${seed}\u0000${metric.id}`));
    if (pack.scope !== 'development' || pack.primaryMetricId !== plan.experimentTemplate.primaryMetricId ||
        !same(pack.metricDenominator.map((item) => `${item.seed}\u0000${item.metricId}`), denominator) ||
        pack.explorationPolicy.id !== plan.limits.explorationPolicy.id || pack.explorationPolicy.topK !== plan.limits.topK ||
        pack.explorationPolicy.continueAfterNonImprovingValidNode !== plan.limits.explorationPolicy.continueAfterNonImprovingValidNode) {
      throw new SearchError('POLICY_DENIED', 'feedback pack changes the frozen metric, denominator, or exploration policy');
    }
    const eligible = state.nodes.filter((node) => node.status === 'eligible');
    if (pack.eligibleParents.length !== eligible.length) throw new SearchError('SOURCE_MISMATCH', 'feedback pack must include every currently eligible parent');
    const expectedPrefixes = eligible.filter((parent) => parent.depth < plan.limits.maxDepth).flatMap((parent) => {
      const modules = parent.candidate?.orderedModuleIds ?? [];
      return plan.candidateSpace.legalPrefixes.filter((prefix) => !state.nodes.some((node) => node.candidate?.candidateId === prefix.variantId) &&
        prefix.moduleIds.length === modules.length + 1 && prefix.moduleIds.slice(0, -1).every((id, index) => id === modules[index]))
        .map((prefix) => ({ parentNodeId: parent.nodeId, candidateId: prefix.variantId, orderedModuleIds: prefix.moduleIds, addedModuleId: prefix.moduleIds[prefix.moduleIds.length - 1] }));
    });
    if (!same(pack.legalNextPrefixes, expectedPrefixes)) throw new SearchError('SOURCE_MISMATCH', 'feedback pack legal next prefixes do not match the current candidate tree');
    for (const evidence of pack.eligibleParents) {
      const node = eligible.find((entry) => entry.nodeId === evidence.nodeId);
      if (!node || evidence.depth !== node.depth || evidence.round !== node.round || !same(evidence.resultRefs, node.resultRefs) ||
          !same(evidence.costRef, node.costRef ?? plan.baseline.costRef) || !same(evidence.verifierRef, node.verifierRef)) {
        throw new SearchError('SOURCE_MISMATCH', `feedback parent evidence does not match eligible node ${evidence.nodeId}`);
      }
      for (const metric of evidence.metricEvidence) {
        const expected = node.kind === 'baseline'
          ? plan.baseline.observations.find((item) => item.seed === metric.seed && item.metricId === metric.metricId)
          : node.metricValues.find((item) => item.seed === metric.seed && item.metricId === metric.metricId);
        if (!expected || expected.value !== metric.value || expected.unit !== metric.unit || metric.split !== 'validation') throw new SearchError('SOURCE_MISMATCH', `feedback metric differs from verified state for ${node.nodeId}`);
        if (node.kind === 'baseline') {
          const baseline = plan.baseline.observations.find((item) => item.seed === metric.seed && item.metricId === metric.metricId)!;
          if (!same(metric.verifiedRef, baseline.verifiedRef)) throw new SearchError('SOURCE_MISMATCH', 'baseline feedback metric ref differs from the frozen SearchPlan');
        } else if (!node.resultRefs.some((ref) => same(ref, metric.verifiedRef)) && !node.candidate?.evidenceRefs.some((ref) => same(ref, metric.verifiedRef))) {
          throw new SearchError('SOURCE_MISMATCH', `candidate ${node.nodeId} does not carry the feedback metric artifact ref`);
        }
      }
    }
    const used = state.nodes.filter((node) => node.kind !== 'baseline').length;
    const receipts = priorRecords.filter((entry): entry is StoredSearchFeedbackRecord & { record: SearchProposalReceipt } => entry.record.kind === 'proposal_receipt').map((entry) => entry.record);
    const priorModelCalls = receipts.reduce((sum, receipt) => sum + receipt.actualModelCalls, 0);
    const priorTokens = receipts.reduce((sum, receipt) => sum + receipt.inputTokens + receipt.outputTokens, 0);
    if (pack.usage.proposalAttempts !== used || pack.usage.maxProposalAttempts !== plan.limits.maxProposalAttempts ||
        pack.usage.modelCalls !== priorModelCalls || pack.usage.totalTokens !== priorTokens ||
        pack.usage.maxModelCalls !== plan.proposalProfile.maxModelCalls || pack.usage.maxTotalTokens !== plan.proposalProfile.maxTotalTokens) {
      throw new SearchError('SOURCE_MISMATCH', 'feedback pack proposal or model usage does not match the persisted search state');
    }
  }

  private static validateCandidateFeedbackLineage(state: SearchState, records: StoredSearchFeedbackRecord[], payload: Record<string, unknown>): void {
    let candidate: CandidateDraft | null = null;
    if (isRecord(payload.candidate)) candidate = validateCandidateDraft(payload.candidate);
    else if (typeof payload.nodeId === 'string') candidate = state.nodes.find((node) => node.nodeId === payload.nodeId)?.candidate ?? null;
    if (!candidate) throw new SearchError('RECONCILIATION_REQUIRED', 'candidate registration event has no draft for feedback lineage validation');
    const receiptEntry = records.find((entry) => entry.record.kind === 'proposal_receipt' && same(entry.ref, candidate!.proposalRef));
    if (!receiptEntry || receiptEntry.record.kind !== 'proposal_receipt' || receiptEntry.record.result.kind !== 'candidate') throw new SearchError('DEPENDENCY_NOT_READY', 'candidate registration requires a prior candidate proposal receipt');
    const receipt = receiptEntry.record;
    if (receipt.result.kind !== 'candidate') throw new SearchError('DEPENDENCY_NOT_READY', 'candidate registration receipt is a model rejection');
    const proposed = receipt.result.candidate;
    const inputEntry = records.find((entry) => entry.record.kind === 'proposal_input' && same(entry.ref, receipt.proposalInputRef));
    const selectionEntry = records.find((entry) => entry.record.kind === 'selection_decision' && inputEntry?.record.kind === 'proposal_input' && same(entry.ref, inputEntry.record.selectionDecisionRef));
    const packEntry = records.find((entry) => entry.record.kind === 'feedback_pack' && inputEntry?.record.kind === 'proposal_input' && same(entry.ref, inputEntry.record.feedbackPackRef));
    if (!inputEntry || inputEntry.record.kind !== 'proposal_input' || !selectionEntry || selectionEntry.record.kind !== 'selection_decision' || !packEntry || packEntry.record.kind !== 'feedback_pack') {
      throw new SearchError('DEPENDENCY_NOT_READY', 'candidate proposal receipt is missing its complete feedback and selection chain');
    }
    const selected = selectionEntry.record.selected;
    if (!selected || receipt.round !== candidate.orderedModuleIds.length || candidate.parentNodeId !== proposed.parentNodeId ||
        candidate.candidateId !== proposed.candidateId || candidate.slotId !== proposed.slotId ||
        !same(candidate.orderedModuleIds, proposed.orderedModuleIds) || !same(candidate.addedModuleIds, proposed.addedModuleIds) ||
        selected.parentNodeId !== candidate.parentNodeId || selected.candidateId !== candidate.candidateId ||
        !same(candidate.proposalRef, receiptEntry.ref)) throw new SearchError('SOURCE_MISMATCH', 'registered candidate differs from its deterministic selection and proposal receipt');
    const parent = state.nodes.find((node) => node.nodeId === candidate!.parentNodeId);
    const parentEvidence = packEntry.record.eligibleParents.find((item) => item.nodeId === candidate!.parentNodeId);
    if (!parent || parent.status !== 'eligible' || !parentEvidence) throw new SearchError('DEPENDENCY_NOT_READY', 'candidate parent is not represented by verified feedback evidence');
    const requiredRefs = [packEntry.ref, selectionEntry.ref, inputEntry.ref, receiptEntry.ref, ...parentEvidence.resultRefs, parentEvidence.costRef,
      ...(parentEvidence.verifierRef ? [parentEvidence.verifierRef] : []), ...parentEvidence.metricEvidence.map((metric) => metric.verifiedRef)];
    for (const required of requiredRefs) if (!candidate.evidenceRefs.some((actual) => same(actual, required))) throw new SearchError('SOURCE_MISMATCH', `candidate evidence is missing ${required.id}`);
  }

  private ensureReadable(): void {
    if (this.closed) throw new SearchError('RECONCILIATION_REQUIRED', 'search state store is closed');
    if (this.poisoned) throw new SearchError('RECONCILIATION_REQUIRED', 'search state store is poisoned after an incomplete durable commit');
  }

  private ensureWritable(): void { this.ensureReadable(); }

  private releaseLock(): void { SearchStateStore.releaseLockFile(this.directory, this.lockToken); }

  private static acquireLock(directory: string): string {
    fs.mkdirSync(directory, { recursive: true });
    const lockPath = path.join(directory, '.writer.lock');
    const token = crypto.randomUUID();
    let fd: number;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SearchError('HOST_BUSY', 'another search-state writer owns this search root');
      throw error;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return token;
  }

  private static releaseLockFile(directory: string, token: string): void {
    const lockPath = path.join(directory, '.writer.lock');
    if (!fs.existsSync(lockPath)) return;
    const lock = parseJsonStrictV1(fs.readFileSync(lockPath, 'utf8'));
    if (!isRecord(lock) || lock.token !== token) throw new SearchError('RECONCILIATION_REQUIRED', 'search-state writer lock token changed unexpectedly');
    fs.unlinkSync(lockPath);
  }
}
