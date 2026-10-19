import type { ArtifactRef } from '../contracts/experiments.ts';
import { validateSearchNode, validateSearchPlan, type SearchCheckpoint, type SearchNode, type SearchPlan } from '../contracts/search.ts';
import { typedHash } from '../domain/research-canonical.ts';

export type SearchPartialStopReason = 'budget_exhausted' | 'cancelled' | 'interrupted' | 'infrastructure_failure' | 'space_exhausted' | 'max_nodes' | 'max_depth_exhausted';

export interface SearchPartialBudgetSummary {
  limits: { maxModelCalls: number; maxTotalTokens: number; maxTrials: number; maxExecutionSeconds: number; maxDiskBytes: number };
  usage: { modelCalls: number; totalTokens: number; trialCount: number; executionMs: number; diskBytes: number; unsettled: number; reservedModelCalls: number; reservedTokens: number };
  searchRootBytes: number;
  projectedFullDiskBytes: number;
  budgetExceeded: boolean;
}

export interface SearchPartialReport {
  schemaVersion: 1;
  status: 'partial';
  searchId: string;
  planRef: ArtifactRef;
  stopReason: SearchPartialStopReason;
  checkpoint: SearchCheckpoint | null;
  tree: Array<Pick<SearchNode, 'nodeId' | 'parentNodeId' | 'candidate' | 'status' | 'resultRefs' | 'costRef' | 'verifierRef' | 'metricValues' | 'error'>>;
  firstError: { nodeId: string; error: NonNullable<SearchNode['error']> } | null;
  budget: SearchPartialBudgetSummary;
  generatedAt: string;
  reportHash: string;
}

export interface BuildSearchPartialReportInput {
  plan: SearchPlan;
  nodes: SearchNode[];
  checkpoint: SearchCheckpoint | null;
  stopReason: SearchPartialStopReason;
  budget: SearchPartialBudgetSummary;
  generatedAt?: string;
}

/** Build a read-only tree/results report that retains the earliest failure and all verified refs. */
export function buildSearchPartialReport(input: BuildSearchPartialReportInput): SearchPartialReport {
  const plan = validateSearchPlan(input.plan);
  const nodes = input.nodes.map((node) => validateSearchNode(node));
  if (nodes.length === 0 || nodes.some((node) => node.searchId !== plan.searchId)) throw new Error('partial report nodes are empty or belong to another search');
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) throw new Error('partial report contains duplicate node IDs');
  if (nodes[0].nodeId !== 'baseline' || nodes[0].status !== 'eligible') throw new Error('partial report must retain the verified baseline as its first tree node');
  if (input.checkpoint) {
    const { checkpointHash, ...checkpointCore } = input.checkpoint;
    if (input.checkpoint.schemaVersion !== 1 || input.checkpoint.searchId !== plan.searchId || input.checkpoint.budgetLedgerRef.id !== plan.rootBudgetRef.id ||
        input.checkpoint.budgetLedgerRef.sha256 !== plan.rootBudgetRef.sha256 || input.checkpoint.treeHash !== typedHash('search-tree-v1', nodes) ||
        typedHash('search-checkpoint-v1', checkpointCore) !== checkpointHash) throw new Error('partial report checkpoint is stale, malformed, or belongs to another search/budget');
  }
  validateBudgetSummary(input.budget);

  const tree = nodes.map(({ nodeId, parentNodeId, candidate, status, resultRefs, costRef, verifierRef, metricValues, error }) => ({
    nodeId, parentNodeId, candidate, status, resultRefs, costRef, verifierRef, metricValues, error,
  }));
  const firstFailed = nodes.find((node) => node.error !== null);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(generatedAt)) throw new Error('partial report generatedAt must be an ISO UTC timestamp');
  const core = {
    schemaVersion: 1 as const,
    status: 'partial' as const,
    searchId: plan.searchId,
    planRef: plan.planRef,
    stopReason: input.stopReason,
    checkpoint: input.checkpoint,
    tree,
    firstError: firstFailed?.error ? { nodeId: firstFailed.nodeId, error: firstFailed.error } : null,
    budget: structuredClone(input.budget),
    generatedAt,
  };
  return { ...core, reportHash: typedHash('search-partial-report-v1', core) };
}

function validateBudgetSummary(budget: SearchPartialBudgetSummary): void {
  for (const [key, value] of Object.entries(budget.limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`partial report budget limit ${key} must be a non-negative safe integer`);
  }
  for (const [key, value] of Object.entries(budget.usage)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`partial report budget usage ${key} must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(budget.searchRootBytes) || budget.searchRootBytes < 0 ||
      !Number.isSafeInteger(budget.projectedFullDiskBytes) || budget.projectedFullDiskBytes < 0 || typeof budget.budgetExceeded !== 'boolean') {
    throw new Error('partial report disk usage or budget status is invalid');
  }
  const actualBudgetExceeded = budget.usage.trialCount > budget.limits.maxTrials || budget.usage.executionMs > budget.limits.maxExecutionSeconds * 1000 ||
    budget.usage.modelCalls > budget.limits.maxModelCalls || budget.usage.totalTokens > budget.limits.maxTotalTokens || budget.projectedFullDiskBytes > budget.limits.maxDiskBytes;
  if (actualBudgetExceeded !== budget.budgetExceeded) throw new Error('partial report budgetExceeded does not match its usage and frozen limits');
}
