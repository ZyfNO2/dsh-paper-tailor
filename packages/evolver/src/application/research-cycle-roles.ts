/**
 * Research Cycle role registry and the scripted first-version executors.
 *
 * Architecture §3: business roles (Hypothesis/Planner/Evidence/Reviewer) map onto
 * the EXISTING team role vocabulary (knowledge_analyst / engineer / reviewer);
 * the closed roleId enum is never extended. The same underlying roleId may back
 * different business roles with different prompts and tools.
 *
 * The scripted executors are the Phase2 first-version role implementations: they
 * derive their content from the REAL workspace inputs (selected idea, paper
 * evidence snapshots) and mark synthesized support as `simulation`. They never
 * fabricate experiment observations and never register anything as verified
 * science. A live DSH Team replaces them through the same CycleRoleExecutor
 * seam without touching the service or the store.
 */

import type { ArtifactRef } from '../contracts/experiments.ts';
import type { ResearchRole } from '../contracts/team-research.ts';
import {
  validateProposalPayload,
  validateExperimentPlanPayload,
  validateEvidenceReportPayload,
  validateDecisionPayload,
  type CycleArtifactKind,
  type CycleInputRef,
  type CycleRole,
  type CycleStepExecution,
  type CycleStepInputSnapshot,
} from '../contracts/research-cycle.ts';

export interface CycleRoleDefinition {
  role: CycleRole;
  /** The one deliverable kind this role produces. */
  outputKind: CycleArtifactKind;
  /** Existing team runtime role this business role maps onto. */
  underlyingRoleId: ResearchRole;
  instruction: string;
}

/** Role registry: the single source of role → output/tool vocabulary mapping. */
export const CYCLE_ROLE_REGISTRY: Record<CycleRole, CycleRoleDefinition> = Object.freeze({
  hypothesis: {
    role: 'hypothesis',
    outputKind: 'proposal',
    underlyingRoleId: 'knowledge_analyst',
    instruction: [
      '你是研究循环中的 Hypothesis 角色。',
      '基于输入快照中的选定 Idea、研究目标与证据引用，产出一份结构化 proposal：',
      'hypothesis（研究假设）、motivation（动机与依据）、baseline（对照基线）、variable（本假设改变的核心变量）、',
      'expectedResult（预期结果——这是预期，不是任何已观察到的实验结果）、sourceRefs（支撑引用）。',
      '只引用分配给你的输入；不要编造未在证据中出现的指标或结论。',
    ].join('\n'),
  },
  planner: {
    role: 'planner',
    outputKind: 'experiment_plan',
    underlyingRoleId: 'engineer',
    instruction: [
      '你是研究循环中的 Experiment Planner 角色。',
      '把输入中的 proposal 变成一份实验设计 experiment_plan：baseline、change（相对基线改什么）、',
      'fixedConditions（固定条件）、dataset、metrics（看什么指标）、ablations（消融）、completionCriteria（完成标准）、openQuestions。',
      '本阶段只做实验设计，不启动真实训练，也不生成可执行代码；设计必须能在 Phase3 转换为可执行计划。',
    ].join('\n'),
  },
  evidence: {
    role: 'evidence',
    outputKind: 'evidence_report',
    underlyingRoleId: 'knowledge_analyst',
    instruction: [
      '你是研究循环中的 Evidence Analyst 角色。',
      '汇总已有证据：每条 finding 必须给出 claim、support、sourceRefs 与 sourceNature。',
      'sourceNature 只能是 literature（论文原文证据）/ existing_experiment（已登记的既有实验结果）/ simulation（明确标识的模拟分析）。',
      '缺少证据的方面写入 gaps，不要把推断写成观察。',
    ].join('\n'),
  },
  reviewer: {
    role: 'reviewer',
    outputKind: 'decision',
    underlyingRoleId: 'reviewer',
    instruction: [
      '你是研究循环中的 Reviewer / Judge 角色。',
      '基于 proposal、experiment plan 与 evidence report 给出 decision（keep / pause / reject / needs_validation）与 reason，',
      '理由必须定位到具体证据。给出 nextActions（下一步建议）与 graphPatch（研究图增量建议）。',
      '新增节点只描述未来工作（如待验证分支），执行依赖只能指向已存在的产出，不得把新节点连回旧步骤形成环。',
      '不要为了通过演示而固定正向结论；证据不足就如实给出 needs_validation 或 pause。',
    ].join('\n'),
  },
});

export interface CycleRoleExecutor {
  role: CycleRole;
  /** Member identity this executor acts as; stamped onto the step at assignment. */
  memberIdentity: string;
  /** Native adapters admit a member before the service stamps its assignment. */
  prepare?(step: import('../contracts/research-cycle.ts').CycleStep, signal: AbortSignal): Promise<void>;
  nativeTask?: { teamId: string; taskId: string };
  completed?(): Promise<void>;
  dispose?(): Promise<void>;
  /** Publishes deliverables through the service boundary; must not throw on success. */
  execute(execution: CycleStepExecution, signal: AbortSignal): Promise<void>;
}

// Re-export the seam types so adapters can implement executors without touching
// the contracts module directly.
export type { CycleStepExecution, CycleStepInputSnapshot };

export interface ScriptedCycleExecutorOptions {
  /** Prefix for member identities; defaults to `scripted`. */
  identityPrefix?: string;
}

/**
 * Deterministic in-process role executors. Their content is derived from the
 * round's real inputs; any synthesized support is explicitly `simulation`.
 * Used by tests and the Trial 001 demo; the host may mount different executors.
 */
export function createScriptedCycleExecutors(options: ScriptedCycleExecutorOptions = {}): ReadonlyMap<CycleRole, CycleRoleExecutor> {
  const prefix = options.identityPrefix ?? 'scripted';
  const executors: Array<CycleRoleExecutor> = [
    { role: 'hypothesis', memberIdentity: `${prefix}:hypothesis`, execute: executeHypothesis },
    { role: 'planner', memberIdentity: `${prefix}:planner`, execute: executePlanner },
    { role: 'evidence', memberIdentity: `${prefix}:evidence`, execute: executeEvidence },
    { role: 'reviewer', memberIdentity: `${prefix}:reviewer`, execute: executeReviewer },
  ];
  return new Map(executors.map((executor) => [executor.role, executor]));
}

type ArtifactInput = Extract<CycleInputRef, { kind: 'artifact' }>;

/** Finds the assigned artifact input whose published payload has this deliverable kind. */
function findKindInput(execution: CycleStepExecution, kind: string): ArtifactInput {
  for (const input of execution.snapshot.roundInputs) {
    if (input.kind !== 'artifact') continue;
    const payload = execution.readInput(input) as { kind?: unknown } | null;
    if (payload !== null && typeof payload === 'object' && payload.kind === kind) return input;
  }
  throw new Error(`no assigned input of kind "${kind}"`);
}

async function executeHypothesis(execution: CycleStepExecution): Promise<void> {
  const idea = execution.snapshot.selectedIdea;
  if (idea === null) throw new Error('hypothesis step received no selected idea');
  const proposal = validateProposalPayload({
    schemaVersion: 1,
    kind: 'proposal',
    ideaRef: { ideaId: idea.ideaId, contentRevision: idea.revision, contentHash: idea.contentHash },
    hypothesis: idea.hypothesis,
    motivation: [idea.rationale, idea.atomicChange ? `核心改动：${idea.atomicChange}` : null].filter(Boolean).join('\n') ||
      `来自选定 Idea「${idea.title}」的研究假设。`,
    baseline: execution.snapshot.research.baselineName ?? '基线未定（以 Contract 基线为准）',
    variable: idea.proposedSlot ?? idea.atomicChange,
    expectedResult: [idea.validationPlan, idea.targetMetrics.length > 0 ? `关注指标：${idea.targetMetrics.join('、')}` : null]
      .filter(Boolean).join('\n') || '预期：按验证计划观察目标指标变化（预期，非观察结果）。',
    sourceRefs: execution.snapshot.roundInputs.filter((input) => input.kind === 'paper_evidence'),
    notes: `由脚本化 Hypothesis 角色基于选定 Idea「${idea.title}」生成；内容来自工作区真实 Idea 与证据引用。`,
  });
  execution.publish(proposal as unknown as Record<string, unknown>);
}

async function executePlanner(execution: CycleStepExecution): Promise<void> {
  const proposalInput = findKindInput(execution, 'proposal');
  const proposal = validateProposalPayload(execution.readInput(proposalInput));
  const metrics = execution.snapshot.selectedIdea?.targetMetrics ?? execution.snapshot.research.metrics;
  const plan = validateExperimentPlanPayload({
    schemaVersion: 1,
    kind: 'experiment_plan',
    proposalRef: proposalInput.ref,
    baseline: proposal.baseline,
    change: proposal.variable,
    fixedConditions: [
      `遵循 Contract 修订 ${execution.snapshot.research.contractRevision}`,
      'Phase2 不启动真实训练；实验计划仅供设计与评审，Phase3 才转换为可执行计划。',
    ],
    dataset: execution.snapshot.research.dataDescription ?? '未在 Contract 中描述；Phase3 执行前需确认',
    metrics: metrics.length > 0 ? metrics : ['待定指标'],
    ablations: proposal.variable ? [`消融 1：仅去掉「${proposal.variable}」，其余保持与基线一致`] : [],
    completionCriteria: '本阶段完成标准：实验设计通过 Reviewer 评审。Phase3 完成标准：在约定数据与指标下与基线比较得到可复现的差异方向。',
    openQuestions: proposal.notes ? [`proposal 备注：${proposal.notes}`] : [],
  });
  execution.publish(plan as unknown as Record<string, unknown>);
}

async function executeEvidence(execution: CycleStepExecution): Promise<void> {
  const proposalInput = findKindInput(execution, 'proposal');
  const planInput = findKindInput(execution, 'experiment_plan');
  const proposal = validateProposalPayload(execution.readInput(proposalInput));
  validateExperimentPlanPayload(execution.readInput(planInput));

  const findings: Array<Record<string, unknown>> = [];
  const gaps: string[] = [];
  const paperInputs = execution.snapshot.roundInputs.filter((input): input is Extract<CycleInputRef, { kind: 'paper_evidence' }> =>
    input.kind === 'paper_evidence');
  for (const evidence of paperInputs.map((input) => input.ref)) {
    findings.push({
      claim: `文献证据：${evidence.snapshot.label}${evidence.snapshot.kind ? `（${evidence.snapshot.kind}）` : ''}`,
      support: [evidence.snapshot.quote, evidence.snapshot.description].filter(Boolean).join(' —— ') || evidence.snapshot.label,
      sourceNature: 'literature',
      sourceRefs: [{ kind: 'paper_evidence', ref: evidence }],
    });
  }
  if (paperInputs.length === 0) gaps.push('选定 Idea 没有论文证据引用；假设只有设计动机，没有文献支撑。');
  // The synthesis below is an analysis the script performs on the round inputs —
  // explicitly marked simulation, never an observed experiment.
  findings.push({
    claim: `组合可行性分析：${proposal.variable}`,
    support: '基于 proposal 与实验计划的文本推演（脚本化分析；未运行任何实验，不构成实验观察）。',
    sourceNature: 'simulation',
    sourceRefs: [{ kind: 'artifact', ref: proposalInput.ref }, { kind: 'artifact', ref: planInput.ref }],
  });
  gaps.push('Phase2 未启动真实训练：本报告没有实验观察，所有支持仅来自文献与明确标识的模拟分析。');

  const report = validateEvidenceReportPayload({
    schemaVersion: 1,
    kind: 'evidence_report',
    proposalRef: proposalInput.ref,
    planRef: planInput.ref,
    findings,
    gaps,
    summary: `共整理 ${paperInputs.length} 条文献证据与 1 条明确标识的模拟分析；缺口 ${gaps.length} 项。证据支持程度以文献原文为准，未做任何实验验证。`,
  });
  execution.publish(report as unknown as Record<string, unknown>);
}

async function executeReviewer(execution: CycleStepExecution): Promise<void> {
  const proposalInput = findKindInput(execution, 'proposal');
  const planInput = findKindInput(execution, 'experiment_plan');
  const evidenceInput = findKindInput(execution, 'evidence_report');
  const proposal = validateProposalPayload(execution.readInput(proposalInput));
  const report = validateEvidenceReportPayload(execution.readInput(evidenceInput));
  validateExperimentPlanPayload(execution.readInput(planInput));

  const literatureFindings = report.findings.filter((finding) => finding.sourceNature === 'literature');
  // No fixed positive verdict for the demo: with literature support the direction is
  // kept (its next step is a planned validation); without support the honest verdict
  // is needs_validation. Nothing is claimed as experimentally proven either way.
  const decision = literatureFindings.length > 0 ? 'keep' as const : 'needs_validation' as const;
  const reason = literatureFindings.length > 0
    ? `证据报告包含 ${literatureFindings.length} 条文献证据支持该方向（见 evidence report findings）；同时存在 ${report.gaps.length} 项缺口，保留该分支并给出下一步验证建议。`
    : '证据报告没有文献支持；按“证据不足不推进”的原则，本分支标记为需补充验证。';

  const runId = execution.run.runId;
  const baseNodeId = execution.step.nodeId;
  const nextActions: Array<Record<string, unknown>> = [];
  const addNodes: Array<Record<string, unknown>> = [];
  const addEdges: Array<Record<string, unknown>> = [];
  const branchDecisions: Array<Record<string, unknown>> = [];
  if (literatureFindings.length > 0) {
    const actionId = `${runId}-validate-combination`;
    nextActions.push({
      actionId,
      kind: 'validation',
      title: `验证「${proposal.variable}」组合效果`,
      detail: `在 Phase3 用真实训练验证：${proposal.baseline} 基线上叠加 ${proposal.variable}，按实验计划指标对比。依据：evidence report ${literatureFindings.length} 条文献证据。`,
    });
    const nextNodeId = `cycle-${runId}-next-validate`;
    addNodes.push({ nodeId: nextNodeId, kind: 'next_action', title: `待验证：${proposal.variable}`, sourceNodeId: baseNodeId, artifactRef: null,
      note: `计划中（未执行）；来源：decision nextActions（${actionId}）。` });
    if (baseNodeId !== null) {
      // Execution/source relations point back at EXISTING outputs only — never forward.
      addEdges.push({ edgeId: `cycle-${runId}-next-validate-src`, from: nextNodeId, to: baseNodeId, relation: 'derived_from' });
    }
  }
  nextActions.push({
    actionId: `${runId}-fill-gaps`,
    kind: 'analysis',
    title: '补齐证据缺口',
    detail: `处理 evidence report 中的 ${report.gaps.length} 项缺口：${report.gaps.slice(0, 3).join('；')}`,
  });
  if (baseNodeId !== null) {
    branchDecisions.push({ targetNodeId: baseNodeId, decision, reason: reason.slice(0, 2000) });
  }

  const payload = validateDecisionPayload({
    schemaVersion: 1,
    kind: 'decision',
    proposalRef: proposalInput.ref,
    planRef: planInput.ref,
    evidenceRef: evidenceInput.ref,
    decision,
    reason,
    nextActions,
    // The payload validator re-validates the full patch shape (unknown fields refused).
    graphPatch: { addNodes, addEdges, branchDecisions },
  });
  execution.publish(payload as unknown as Record<string, unknown>);
}
