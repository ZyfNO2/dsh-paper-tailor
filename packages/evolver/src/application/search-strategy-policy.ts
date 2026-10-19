export const SEARCH_STRATEGY_IDS = ['feedback', 'no_feedback', 'random'] as const;
export type SearchStrategyId = (typeof SEARCH_STRATEGY_IDS)[number];

const FAILURE_CODES = ['IMPORT_ERROR', 'TYPE_ERROR', 'SHAPE_ERROR', 'EXECUTION_EXCEPTION', 'RESOURCE_LIMIT'] as const;
export type SanitizedTechnicalFailureCode = (typeof FAILURE_CODES)[number];

export interface NoFeedbackProposalContext {
  schemaVersion: 1;
  strategy: 'no_feedback';
  searchSeed: number;
  allowedCandidateIds: string[];
  scheduledParentIds: string[];
  technicalFailureCodes: SanitizedTechnicalFailureCode[];
}

export interface StrategyRunRow {
  runId: string;
  strategy: SearchStrategyId;
  searchSeed: number;
  order: number;
}

export interface StrategyComparisonPlan {
  schemaVersion: 1;
  planId: string;
  status: 'frozen-local-plan-not-executed';
  scope: 'development';
  claimStatus: 'not-evaluated';
  sourcePins: {
    searchPlan: { path: string; sha256: string };
    baselineCampaign: { path: string; sha256: string };
  };
  task: {
    taskId: string;
    profileRef: string;
    dataSubsetSha256: string;
    primaryMetric: { id: string; direction: 'minimize' | 'maximize'; unit: string };
    pairedTrialSeeds: number[];
    testAccess: 'forbidden';
    candidateSpace: string[];
    searchPlanLimits: {
      maxNodes: number;
      maxDepth: number;
      maxProposalAttempts: number;
      maxRepairsPerNode: number;
      maxExecutionSeconds: number;
      maxTrials: number;
    };
  };
  comparison: {
    searchSeeds: number[];
    scheduleBySeed: Array<{ searchSeed: number; order: SearchStrategyId[] }>;
    strategies: Array<{
      id: SearchStrategyId;
      proposalMode: string;
      proposalModel: { providerRoute: string; modelId: string } | null;
      proposalCallsPerRun: number;
      contextPolicy: string;
      proposalTemplateId?: string;
      proposalTemplateSha256?: string;
      prng?: string;
    }>;
    commonRules: {
      sameTaskProfileDataProtocolAndPairedSeeds: true;
      sameCandidateSpaceAndHardBudget: true;
      sameRepairEligibilityAndLimit: true;
      testSplitAccess: 'forbidden';
      candidateResultCache: 'disabled';
      proposalTemplateId: string;
      proposalTemplateSha256: string;
      baselineEvidence: string;
      preparationCost: string;
      stopRule: string;
    };
    runGrid: StrategyRunRow[];
    statisticalPolicy: {
      minimumSearchSeeds: number;
      reportEveryPlannedRunIncludingFailures: true;
      primarySummary: string;
      nullBestMetric: string;
      gainStatus: string;
    };
  };
  budget: {
    modelBudgetEvidence: string;
    perRun: {
      maxExecutionSeconds: number;
      maxTrials: number;
      maxRepairAttempts: number;
      maxModelCalls: number;
      maxInputTokensPerCall: number;
      maxOutputTokensPerCall: number;
      maxTotalTokens: number;
      maxMemoryBytes: number;
      maxDiskBytes: number;
      device: 'cpu';
    };
    total: {
      maxRuns: number;
      maxExecutionSeconds: number;
      maxTrials: number;
      maxModelCalls: number;
      plannedModelCalls: number;
      maxTotalTokens: number;
      plannedTokenCeiling: number;
      wallClockDeadlineSeconds: number;
    };
  };
  executionState: { b0: string; b1: string; b2: string; b3: string; b4: string };
}

function recordAt(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${field} contains forbidden fields: ${unexpected.join(', ')}`);
}

function safeIdList(value: unknown, field: string, maxCount: number): string[] {
  if (!Array.isArray(value) || value.length > maxCount || value.some((item) => typeof item !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(item))) {
    throw new Error(`${field} must be a bounded list of safe lowercase identifiers`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${field} contains duplicate identifiers`);
  return [...value];
}

function positiveUint32(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 0xffff_ffff) {
    throw new Error(`${field} must be an integer in [1, 2^32-1]`);
  }
  return value as number;
}

export function validateNoFeedbackProposalContext(raw: unknown): NoFeedbackProposalContext {
  const context = recordAt(raw, 'no-feedback context');
  exactKeys(context, [
    'schemaVersion', 'strategy', 'searchSeed', 'allowedCandidateIds', 'scheduledParentIds', 'technicalFailureCodes',
  ], 'no-feedback context');
  if (context.schemaVersion !== 1 || context.strategy !== 'no_feedback') {
    throw new Error('no-feedback context must use schemaVersion 1 and strategy no_feedback');
  }
  const searchSeed = positiveUint32(context.searchSeed, 'no-feedback context.searchSeed');
  const allowedCandidateIds = safeIdList(context.allowedCandidateIds, 'no-feedback context.allowedCandidateIds', 32);
  const scheduledParentIds = safeIdList(context.scheduledParentIds, 'no-feedback context.scheduledParentIds', 32);
  if (!Array.isArray(context.technicalFailureCodes) || context.technicalFailureCodes.length > 16 ||
      context.technicalFailureCodes.some((code) => !FAILURE_CODES.includes(code as SanitizedTechnicalFailureCode))) {
    throw new Error('no-feedback context.technicalFailureCodes contains an unapproved or unsanitized value');
  }
  const technicalFailureCodes = [...new Set(context.technicalFailureCodes as SanitizedTechnicalFailureCode[])];
  return { schemaVersion: 1, strategy: 'no_feedback', searchSeed, allowedCandidateIds, scheduledParentIds, technicalFailureCodes };
}

/** Produces the entire no-feedback payload from the narrow, score-free whitelist. */
export function buildNoFeedbackProposalInput(raw: unknown): string {
  return JSON.stringify(validateNoFeedbackProposalContext(raw));
}

export function selectRandomCandidates(candidateIds: readonly string[], seed: number, count: number): string[] {
  const pool = safeIdList(candidateIds, 'random candidate pool', 128).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  positiveUint32(seed, 'random search seed');
  if (!Number.isInteger(count) || count < 0 || count > pool.length) {
    throw new Error('random selection count must be between zero and the candidate pool size');
  }
  let state = seed >>> 0;
  const nextUint32 = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const nextBounded = (bound: number): number => {
    const range = 0x1_0000_0000;
    const limit = Math.floor(range / bound) * bound;
    let value = nextUint32();
    while (value >= limit) value = nextUint32();
    return value % bound;
  };
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = nextBounded(index + 1);
    [pool[index], pool[swapIndex]] = [pool[swapIndex]!, pool[index]!];
  }
  return pool.slice(0, count);
}

export function validateStrategyComparisonPlan(raw: unknown): StrategyComparisonPlan {
  const plan = recordAt(raw, 'comparison plan');
  exactKeys(plan, ['schemaVersion', 'planId', 'status', 'scope', 'claimStatus', 'sourcePins', 'task', 'comparison', 'budget', 'executionState'], 'comparison plan');
  if (plan.schemaVersion !== 1 || plan.status !== 'frozen-local-plan-not-executed' || plan.scope !== 'development' || plan.claimStatus !== 'not-evaluated') {
    throw new Error('comparison plan must be a frozen, development-only, unexecuted plan');
  }
  if (typeof plan.planId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(plan.planId)) throw new Error('comparison plan id is invalid');

  const sourcePins = recordAt(plan.sourcePins, 'comparison plan.sourcePins');
  exactKeys(sourcePins, ['searchPlan', 'baselineCampaign'], 'comparison plan.sourcePins');
  for (const [name, value] of Object.entries(sourcePins)) {
    const pin = recordAt(value, `comparison plan.sourcePins.${name}`);
    exactKeys(pin, ['path', 'sha256'], `comparison plan.sourcePins.${name}`);
    if (typeof pin.path !== 'string' || !/^[0-9a-f]{64}$/.test(String(pin.sha256))) throw new Error(`source pin ${name} is invalid`);
  }

  const task = recordAt(plan.task, 'comparison plan.task');
  exactKeys(task, ['taskId', 'profileRef', 'dataSubsetSha256', 'primaryMetric', 'pairedTrialSeeds', 'testAccess', 'candidateSpace', 'searchPlanLimits'], 'comparison plan.task');
  if (task.testAccess !== 'forbidden' || typeof task.taskId !== 'string' || typeof task.profileRef !== 'string' ||
      !/^[0-9a-f]{64}$/.test(String(task.dataSubsetSha256))) throw new Error('comparison task identity or test-access policy is invalid');
  const primaryMetric = recordAt(task.primaryMetric, 'comparison plan.task.primaryMetric');
  exactKeys(primaryMetric, ['id', 'direction', 'unit'], 'comparison plan.task.primaryMetric');
  if (primaryMetric.id !== 'validation_loss' || primaryMetric.direction !== 'minimize' || primaryMetric.unit !== 'cross_entropy') {
    throw new Error('comparison primary metric differs from the frozen validation objective');
  }
  const pairedTrialSeeds = task.pairedTrialSeeds;
  if (!Array.isArray(pairedTrialSeeds) || pairedTrialSeeds.length < 2 || pairedTrialSeeds.some((seed) => !Number.isSafeInteger(seed) || (seed as number) < 0) || new Set(pairedTrialSeeds).size !== pairedTrialSeeds.length) {
    throw new Error('paired trial seeds must be unique nonnegative safe integers');
  }
  const candidateSpace = safeIdList(task.candidateSpace, 'comparison plan.task.candidateSpace', 128);
  if (candidateSpace.length === 0) throw new Error('comparison candidate space cannot be empty');

  const comparison = recordAt(plan.comparison, 'comparison plan.comparison');
  exactKeys(comparison, ['searchSeeds', 'searchSeedRole', 'scheduleBySeed', 'strategies', 'commonRules', 'runGrid', 'statisticalPolicy'], 'comparison plan.comparison');
  if (comparison.searchSeedRole !== 'strategy-randomization-seed; distinct from paired trial seeds') throw new Error('search seed role is not frozen');
  const searchSeeds = comparison.searchSeeds;
  if (!Array.isArray(searchSeeds) || searchSeeds.length < 3 || searchSeeds.some((seed) => !Number.isSafeInteger(seed) || (seed as number) < 1) || new Set(searchSeeds).size !== searchSeeds.length) {
    throw new Error('at least three unique positive search seeds are required');
  }
  if (searchSeeds.some((seed) => pairedTrialSeeds.includes(seed))) throw new Error('search seeds must be distinct from paired trial seeds');

  const strategies = comparison.strategies;
  if (!Array.isArray(strategies) || strategies.length !== 3) throw new Error('comparison requires exactly three strategy definitions');
  const strategyById = new Map<string, Record<string, unknown>>();
  for (const [index, strategyValue] of strategies.entries()) {
    const strategy = recordAt(strategyValue, `comparison strategies[${index}]`);
    const id = strategy.id;
    if (typeof id !== 'string' || !SEARCH_STRATEGY_IDS.includes(id as SearchStrategyId) || strategyById.has(id)) throw new Error('strategy ids must be unique feedback/no_feedback/random');
    exactKeys(strategy, id === 'random'
      ? ['id', 'proposalMode', 'proposalModel', 'proposalCallsPerRun', 'contextPolicy', 'prng']
      : ['id', 'proposalMode', 'proposalModel', 'proposalCallsPerRun', 'contextPolicy', 'proposalTemplateId', 'proposalTemplateSha256'],
    `comparison strategies[${index}]`);
    strategyById.set(id, strategy);
  }
  if (SEARCH_STRATEGY_IDS.some((id) => !strategyById.has(id))) throw new Error('feedback, no_feedback, and random strategies are all required');
  const feedback = strategyById.get('feedback')!;
  const noFeedback = strategyById.get('no_feedback')!;
  const random = strategyById.get('random')!;
  const feedbackModel = recordAt(feedback.proposalModel, 'feedback proposal model');
  const noFeedbackModel = recordAt(noFeedback.proposalModel, 'no_feedback proposal model');
  exactKeys(feedbackModel, ['providerRoute', 'modelId'], 'feedback proposal model');
  exactKeys(noFeedbackModel, ['providerRoute', 'modelId'], 'no_feedback proposal model');
  if (feedback.proposalMode !== 'verified-development-feedback' || noFeedback.proposalMode !== 'same-model-and-template-with-feedback-context-excluded' || random.proposalMode !== 'finite-space-prng' ||
      feedback.proposalCallsPerRun !== 2 || noFeedback.proposalCallsPerRun !== 2 || random.proposalCallsPerRun !== 0 ||
      feedback.proposalModel === null || JSON.stringify(feedback.proposalModel) !== JSON.stringify(noFeedback.proposalModel) ||
      feedback.proposalTemplateId !== noFeedback.proposalTemplateId || feedback.proposalTemplateSha256 !== noFeedback.proposalTemplateSha256 ||
      typeof feedback.proposalTemplateId !== 'string' || !/^[0-9a-f]{64}$/.test(String(feedback.proposalTemplateSha256)) ||
      random.proposalModel !== null || random.prng !== 'xorshift32-rejection-fisher-yates-v1') {
    throw new Error('strategy generation costs, shared model, or random algorithm differ from the preregistered policy');
  }

  const scheduleBySeed = comparison.scheduleBySeed;
  const runGrid = comparison.runGrid;
  if (!Array.isArray(scheduleBySeed) || !Array.isArray(runGrid) || scheduleBySeed.length !== searchSeeds.length || runGrid.length !== searchSeeds.length * SEARCH_STRATEGY_IDS.length) {
    throw new Error('schedule and run grid must include every strategy for every search seed');
  }
  const rotations: SearchStrategyId[][] = [
    ['feedback', 'no_feedback', 'random'],
    ['no_feedback', 'random', 'feedback'],
    ['random', 'feedback', 'no_feedback'],
  ];
  const expectedRows: StrategyRunRow[] = [];
  searchSeeds.forEach((seedValue, seedIndex) => {
    const seed = seedValue as number;
    const expectedOrder = rotations[seedIndex % rotations.length]!;
    const schedule = recordAt(scheduleBySeed[seedIndex], `scheduleBySeed[${seedIndex}]`);
    exactKeys(schedule, ['searchSeed', 'order'], `scheduleBySeed[${seedIndex}]`);
    if (schedule.searchSeed !== seed || JSON.stringify(schedule.order) !== JSON.stringify(expectedOrder)) throw new Error(`schedule rotation is invalid for seed ${seed}`);
    expectedOrder.forEach((strategy, index) => expectedRows.push({ runId: `${strategy}-s${seed}`, strategy, searchSeed: seed, order: index + 1 }));
  });
  const actualRows = runGrid.map((rowValue, index) => {
    const row = recordAt(rowValue, `runGrid[${index}]`);
    exactKeys(row, ['runId', 'strategy', 'searchSeed', 'order'], `runGrid[${index}]`);
    return row;
  });
  if (JSON.stringify(actualRows) !== JSON.stringify(expectedRows)) throw new Error('run grid does not match the frozen rotated schedule');

  const commonRules = recordAt(comparison.commonRules, 'comparison plan.comparison.commonRules');
  exactKeys(commonRules, ['sameTaskProfileDataProtocolAndPairedSeeds', 'sameCandidateSpaceAndHardBudget', 'sameRepairEligibilityAndLimit', 'testSplitAccess', 'candidateResultCache', 'proposalTemplateId', 'proposalTemplateSha256', 'baselineEvidence', 'preparationCost', 'stopRule'], 'comparison commonRules');
  if (commonRules.sameTaskProfileDataProtocolAndPairedSeeds !== true || commonRules.sameCandidateSpaceAndHardBudget !== true ||
      commonRules.sameRepairEligibilityAndLimit !== true || commonRules.testSplitAccess !== 'forbidden' || commonRules.candidateResultCache !== 'disabled' ||
      commonRules.proposalTemplateId !== feedback.proposalTemplateId || commonRules.proposalTemplateSha256 !== feedback.proposalTemplateSha256) {
    throw new Error('comparison parity, test-split, or cache policy is not frozen consistently');
  }

  const limits = recordAt(task.searchPlanLimits, 'comparison plan.task.searchPlanLimits');
  exactKeys(limits, ['maxNodes', 'maxDepth', 'maxProposalAttempts', 'maxRepairsPerNode', 'maxExecutionSeconds', 'maxTrials'], 'searchPlanLimits');
  if (limits.maxNodes !== 3 || limits.maxDepth !== 2 || limits.maxProposalAttempts !== 2 || limits.maxRepairsPerNode !== 0 || limits.maxExecutionSeconds !== 500 || limits.maxTrials !== 6) {
    throw new Error('comparison hard limits differ from the pinned RG-S v2 plan');
  }
  const budget = recordAt(plan.budget, 'comparison plan.budget');
  exactKeys(budget, ['perRun', 'total', 'modelBudgetEvidence'], 'comparison plan.budget');
  const perRun = recordAt(budget.perRun, 'comparison plan.budget.perRun');
  exactKeys(perRun, ['maxExecutionSeconds', 'maxTrials', 'maxRepairAttempts', 'maxModelCalls', 'maxInputTokensPerCall', 'maxOutputTokensPerCall', 'maxTotalTokens', 'maxMemoryBytes', 'maxDiskBytes', 'device'], 'comparison plan.budget.perRun');
  const total = recordAt(budget.total, 'comparison plan.budget.total');
  exactKeys(total, ['maxRuns', 'maxExecutionSeconds', 'maxTrials', 'maxModelCalls', 'plannedModelCalls', 'maxTotalTokens', 'plannedTokenCeiling', 'wallClockDeadlineSeconds'], 'comparison plan.budget.total');
  const perRunNumbers = ['maxExecutionSeconds', 'maxTrials', 'maxRepairAttempts', 'maxModelCalls', 'maxInputTokensPerCall', 'maxOutputTokensPerCall', 'maxTotalTokens', 'maxMemoryBytes', 'maxDiskBytes'];
  const totalNumbers = ['maxRuns', 'maxExecutionSeconds', 'maxTrials', 'maxModelCalls', 'plannedModelCalls', 'maxTotalTokens', 'plannedTokenCeiling', 'wallClockDeadlineSeconds'];
  if (perRunNumbers.some((key) => !Number.isSafeInteger(perRun[key]) || (perRun[key] as number) < 0) || totalNumbers.some((key) => !Number.isSafeInteger(total[key]) || (total[key] as number) < 0)) {
    throw new Error('comparison budget values must be nonnegative safe integers');
  }
  const runCount = searchSeeds.length * SEARCH_STRATEGY_IDS.length;
  const maxCalls = runCount * (perRun.maxModelCalls as number);
  const plannedCalls = searchSeeds.length * (feedback.proposalCallsPerRun as number + noFeedback.proposalCallsPerRun as number);
  const perCallTokens = (perRun.maxInputTokensPerCall as number) + (perRun.maxOutputTokensPerCall as number);
  if (perRun.maxExecutionSeconds !== limits.maxExecutionSeconds || perRun.maxTrials !== limits.maxTrials ||
      perRun.maxRepairAttempts !== limits.maxRepairsPerNode || (perRun.maxModelCalls as number) < Math.max(feedback.proposalCallsPerRun as number, noFeedback.proposalCallsPerRun as number) || perRun.device !== 'cpu' ||
      perRun.maxTotalTokens !== (perRun.maxModelCalls as number) * perCallTokens || total.maxRuns !== runCount ||
      total.maxExecutionSeconds !== runCount * (perRun.maxExecutionSeconds as number) || total.maxTrials !== runCount * (perRun.maxTrials as number) ||
      total.maxModelCalls !== maxCalls || total.plannedModelCalls !== plannedCalls || total.maxTotalTokens !== maxCalls * perCallTokens ||
      total.plannedTokenCeiling !== plannedCalls * perCallTokens) {
    throw new Error('per-run or total hard budgets do not reconcile to the frozen run grid');
  }
  const statisticalPolicy = recordAt(comparison.statisticalPolicy, 'comparison plan.comparison.statisticalPolicy');
  exactKeys(statisticalPolicy, ['minimumSearchSeeds', 'reportEveryPlannedRunIncludingFailures', 'primarySummary', 'nullBestMetric', 'gainStatus'], 'statisticalPolicy');
  if (statisticalPolicy.minimumSearchSeeds !== 3 || statisticalPolicy.reportEveryPlannedRunIncludingFailures !== true) throw new Error('comparison statistical denominator policy is not frozen');
  const state = recordAt(plan.executionState, 'comparison plan.executionState');
  exactKeys(state, ['b0', 'b1', 'b2', 'b3', 'b4'], 'comparison plan.executionState');
  if (state.b0 !== 'frozen' || state.b1 !== 'engineering-contract-to-verify' || state.b2 !== 'deferred-unverified-requires-dsh-runner-and-live-authorization' || state.b3 !== 'deferred-unverified-requires-all-sealed-runs' || state.b4 !== 'deferred-unverified-requires-b3-and-claim-evidence') {
    throw new Error('comparison stage statuses must distinguish local plan from deferred live execution');
  }
  return raw as StrategyComparisonPlan;
}
