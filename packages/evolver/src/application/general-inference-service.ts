import * as fs from 'node:fs';
import * as path from 'node:path';
import { BootstrapError } from '../contracts/research-bootstrap.ts';
import { validateGeneralResearch, type GeneralResearch } from '../contracts/general-research.ts';
import { validateInferencePlan, validateInferenceRun, type InferencePlan, type InferenceRun } from '../contracts/general-inference-records.ts';
import { validateInferenceInput, type InferenceInput, type InferenceResult } from '../contracts/general-inference.ts';
import { object, str, type DatasetVersion, type MaterialSource, type RawTable } from '../contracts/general-data.ts';
import { ResearchBootstrapStore, requireResearch } from './research-bootstrap-store.ts';
import { ResearchCycleStore } from './research-cycle-store.ts';
import { GeneralMaterialStore } from './general-material-store.ts';
import { interpretedCell } from './general-data-service.ts';
import { assertGeneralSourceAccess } from './general-source-access.ts';
import { generalContextHash, dictionaryHash, nodeHash } from './general-analysis-service.ts';
import { dependencySnapshotHash } from './general-graph-context.ts';
import { generalNodeStates } from './general-workflow-service.ts';
import { GeneralFollowupService } from './general-followup-service.ts';
import { CalculationBlocked } from './general-descriptive.ts';
import { inferStudentT } from './general-inference.ts';
import { cycleContentHash } from '../contracts/research-cycle.ts';
type Write = { operationId: string; baseRevision: number; researchId: string };
export interface InferenceArtifact { schemaVersion: 1; kind: 'student_t_inference'; researchId: string; plan: InferencePlan; input: InferenceInput; result: InferenceResult; selection: { rangeRows: number; excludedRows: number; unselectedRows: number }; startedAt: string; finishedAt: string }
export function inferencePlanFreshness(g: GeneralResearch, p: InferencePlan) {
  const node = g.graph.nodes.find(n => n.nodeId === p.nodeId), reasons: string[] = [];
  if (!node || nodeHash(node) !== p.nodeSnapshotHash || dependencySnapshotHash(g, p.nodeId) !== p.dependencySnapshotHash || generalContextHash(g) !== p.contextHash) reasons.push('节点、前置或研究契约已变更。');
  if (g.datasets.some(d => d.datasetId === p.dataset.datasetId && d.version > p.dataset.version)) reasons.push('数据字典已有新版本。');
  if (g.sources.some(s => s.previousSourceId === p.dataset.sourceId)) reasons.push('原始来源已有新版本。');
  return { status: reasons.length ? 'needs_review' as const : 'current' as const, reasons };
}
/** Extract complete actual table range; never accept LLM/browser-supplied numeric arrays. */
export function inferenceTableInput(plan: InferencePlan, dataset: DatasetVersion, table: RawTable) {
  const field = (column: number) => { const f = dataset.fields.find(f => f.column === column); if (!f) throw new CalculationBlocked('推断字段未映射。'); if (table.formulaColumns.includes(column)) throw new CalculationBlocked('推断字段包含未计算 Excel 公式。'); return f; };
  const outcome = field(plan.valueColumn), identity = field(plan.sampleColumn), group = plan.groups ? field(plan.groups.column) : null;
  if (outcome.type !== 'number' || identity.role !== 'sample' || group && group.role !== 'group') throw new CalculationBlocked('需明确数值结果、真实 sample 身份及 group 角色。');
  if ((outcome.conversion?.targetUnit ?? outcome.unit) !== plan.spec.unit) throw new CalculationBlocked('结果字段单位未知或与冻结单位不符。');
  for (const name of plan.requiredConditions) if (!dataset.conditions.some(c => c.name === name && c.value?.trim())) throw new CalculationBlocked(`推断前置条件「${name}」未知。`);
  const sampleA: InferenceInput['sampleA'] = [], sampleB: InferenceInput['sampleA'] = [], excluded = new Set(dataset.excludedRows);
  const selection = { rangeRows: plan.rowRange.end - plan.rowRange.start, excludedRows: 0, unselectedRows: 0 };
  const seenA = new Set<string>(), seenB = new Set<string>();
  const interpret = (column: number, row: number) => { const cell = interpretedCell(table.rows[row][column], field(column)); if (cell.error) throw new CalculationBlocked(`第 ${row} 行：${cell.error}`); return cell.value; };
  if (plan.rowRange.end > table.rows.length) throw new CalculationBlocked('推断范围超过原始表。');
  for (let row = plan.rowRange.start; row < plan.rowRange.end; row++) {
    if (excluded.has(row)) { selection.excludedRows++; continue; }
    let destination = sampleA, seen = seenA;
    if (group && plan.groups) {
      const value = interpret(group.column, row);
      if (JSON.stringify(value) === JSON.stringify(plan.groups.b)) { destination = sampleB; seen = seenB; }
      else if (JSON.stringify(value) !== JSON.stringify(plan.groups.a)) { selection.unselectedRows++; continue; }
    }
    const rawId = interpret(identity.column, row); if (rawId === null || typeof rawId === 'string' && !rawId.trim()) throw new CalculationBlocked('缺少真实样本身份，不能使用内部行 ID 代替。');
    const sampleId = JSON.stringify(rawId); if (sampleId.length > 200) throw new CalculationBlocked('样本身份超过 200 字符。');
    if (seen.has(sampleId)) throw new CalculationBlocked('同组样本身份重复；需明确聚合或重复测量方法，不把重复行当独立样本。'); seen.add(sampleId);
    const value = interpret(outcome.column, row); if (value !== null && typeof value !== 'number') throw new CalculationBlocked('结果不是可解释数值。');
    destination.push({ sampleId, value });
  }
  return { input: validateInferenceInput({ ...plan.spec, sampleA, sampleB: plan.spec.method === 'one_sample_t' ? null : sampleB }), selection };
}
/** Recompute registered inference from complete immutable input, including portable archives. */
export function validateInferenceArtifact(value: unknown, context: { researchId: string; run: InferenceRun; plan: InferencePlan; source: MaterialSource; dataset: DatasetVersion; table: RawTable }): InferenceArtifact {
  const { researchId, run, plan, source, dataset, table } = context;
  const content = object(value, ['schemaVersion', 'kind', 'researchId', 'plan', 'input', 'result', 'selection', 'startedAt', 'finishedAt'], 'inference artifact');
  if (run.status !== 'completed' || content.schemaVersion !== 1 || content.kind !== 'student_t_inference' || content.researchId !== researchId || cycleContentHash('inference-plan-v1', content.plan) !== cycleContentHash('inference-plan-v1', plan) || content.startedAt !== run.startedAt || typeof content.finishedAt !== 'string' || !Number.isFinite(Date.parse(content.finishedAt)) || Date.parse(content.finishedAt) < Date.parse(run.startedAt) || Date.parse(content.finishedAt) > Date.parse(run.finishedAt)) throw new BootstrapError('SOURCE_STALE', 'Inference artifact registration mismatch');
  if (dictionaryHash(dataset) !== plan.dataset.dictionarySha256 || source.parsedSha256 !== plan.parsedSha256) throw new BootstrapError('SOURCE_STALE', 'Inference frozen input hash mismatch');
  const rawResult = content.result as { tool?: unknown } | null, tool = object(rawResult?.tool, ['name', 'version', 'runtime'], 'inference result tool');
  if (cycleContentHash('inference-tool-v1', tool) !== cycleContentHash('inference-tool-v1', run.tool)) throw new BootstrapError('SOURCE_STALE', 'Inference artifact tool does not match registered execution');
  const selected = inferenceTableInput(plan, dataset, table), result = inferStudentT(selected.input, run.tool.runtime);
  if (source.nature !== 'user_observation') result.warnings.push(`来源性质为 ${source.nature}；本工具的实际数学执行不授予真实实测观察。`);
  if (cycleContentHash('inference-content-v1', { ...selected, result }) !== cycleContentHash('inference-content-v1', { input: content.input, selection: content.selection, result: content.result })) throw new BootstrapError('SOURCE_STALE', 'Inference artifact does not match full registered data/rules/numeric execution');
  return content as unknown as InferenceArtifact;
}
export class GeneralInferenceService {
  readonly store: ResearchBootstrapStore;
  constructor(store: ResearchBootstrapStore) { this.store = store; }
  private publications(researchId: string) {
    if (!/^[\w-]+$/.test(researchId)) throw new BootstrapError('POLICY_DENIED', 'Invalid inference namespace');
    let current = this.store.workspaceRoot;
    for (const part of ['', '.dsh', 'research', 'cycles', researchId, 'artifacts']) { if (part) current = path.join(current, part); if (fs.existsSync(current) && (fs.lstatSync(current).isSymbolicLink() || !fs.lstatSync(current).isDirectory())) throw new BootstrapError('POLICY_DENIED', 'Inference path contains link/non-directory'); }
    return new ResearchCycleStore(this.store.workspaceRoot, researchId);
  }
  savePlan(input: Write & { planId?: string; nodeId: string; title: string; datasetId: string; datasetVersion: number; valueColumn: number; sampleColumn: number; groups: InferencePlan['groups']; rowRange: InferencePlan['rowRange']; spec: Omit<InferencePlan['spec'], 'unit'>; requiredConditions: string[]; limitations: string[] }, identity: string) {
    const { operationId, baseRevision, ...payload } = input;
    return this.store.mutate({ operationId, baseRevision, researchId: input.researchId, kind: 'save_general_inference_plan', requestPayload: payload, apply: context => {
      const research = requireResearch(context.state, input.researchId), g = research.general; if (!g) throw new BootstrapError('INVALID_INPUT', 'Inference requires generic research');
      const node = g.graph.nodes.find(n => n.nodeId === input.nodeId), dataset = g.datasets.find(d => d.datasetId === input.datasetId && d.version === input.datasetVersion);
      if (!node || node.kind !== 'analysis' || !dataset) throw new BootstrapError('NOT_FOUND', 'Inference node/dictionary not found');
      if (node.task) new GeneralFollowupService(this.store).freeze(input.researchId, node, node.task.sourceIds, context.state);
      const source = g.sources.find(s => s.sourceId === dataset.sourceId)!; assertGeneralSourceAccess(g, source.sourceId);
      const materials = new GeneralMaterialStore(this.store.workspaceRoot), parsed = materials.readParsed(source), table = parsed.tables.find(t => t.tableId === dataset.tableId)!;
      const outcome = dataset.fields.find(f => f.column === input.valueColumn); if (!outcome) throw new BootstrapError('INVALID_INPUT', 'Outcome column missing');
      const previous = input.planId ? g.inferencePlans.filter(p => p.planId === input.planId).at(-1) : null;
      if (input.planId && (!previous || previous.nodeId !== node.nodeId)) throw new BootstrapError('NOT_FOUND', 'Previous inference plan belongs to another node');
      const plan = validateInferencePlan({ valueColumn: input.valueColumn, sampleColumn: input.sampleColumn, groups: input.groups, rowRange: input.rowRange, requiredConditions: input.requiredConditions, limitations: input.limitations, planId: previous?.planId ?? context.mint('inference-plan'), version: (previous?.version ?? 0) + 1, nodeId: node.nodeId, title: str(input.title, 'title', 300, true), dataset: { datasetId: dataset.datasetId, version: dataset.version, sourceId: source.sourceId, sourceSha256: source.sha256, tableId: dataset.tableId, dictionarySha256: dictionaryHash(dataset) }, parsedSha256: source.parsedSha256, nodeSnapshotHash: nodeHash(node), dependencySnapshotHash: dependencySnapshotHash(g, node.nodeId), contextHash: generalContextHash(g), sourceRefs: [...new Set([source.sourceId, ...(node.task?.sourceIds ?? [])])], spec: { ...input.spec, unit: outcome.conversion?.targetUnit ?? outcome.unit }, actor: { identity, actionId: input.operationId }, createdAt: context.now() });
      // Only interpretation validation here; execution/CI is a separate explicit action.
      inferenceTableInput(plan, dataset, table);
      g.inferencePlans.push(plan); g.revision++; research.general = validateGeneralResearch(g); research.updatedAt = context.now(); return { changed: true, result: { planId: plan.planId, version: plan.version } };
    } });
  }
  execute(input: Write & { planId: string; planVersion: number; authorize: boolean }) {
    if (input.authorize !== true) throw new BootstrapError('POLICY_DENIED', 'Inference execution needs explicit authorization');
    return this.store.mutate({ ...input, kind: 'execute_general_inference', requestPayload: { researchId: input.researchId, planId: input.planId, planVersion: input.planVersion, authorize: true }, apply: context => {
      const research = requireResearch(context.state, input.researchId), g = research.general; if (!g) throw new BootstrapError('INVALID_INPUT', 'Generic research missing');
      const plan = g.inferencePlans.find(p => p.planId === input.planId && p.version === input.planVersion); if (!plan) throw new BootstrapError('NOT_FOUND', 'Inference plan/version missing');
      const attempts = g.inferenceRuns.filter(r => r.planId === plan.planId && r.planVersion === plan.version);
      if (attempts.length >= g.limits.maxAttempts || g.limits.deadline && Date.parse(context.now()) >= Date.parse(g.limits.deadline)) throw new BootstrapError('POLICY_DENIED', 'Inference budget/deadline exhausted');
      const source = g.sources.find(s => s.sourceId === plan.dataset.sourceId)!; assertGeneralSourceAccess(g, source.sourceId);
      for (const id of plan.sourceRefs) assertGeneralSourceAccess(g, id);
      const startedAt = context.now(); let status: 'completed' | 'blocked' | 'failed' = 'completed', artifact: { id: string; sha256: string } | null = null, firstError: { code: string; message: string } | null = null;
      try {
        const state = generalNodeStates(g).find(s => s.nodeId === plan.nodeId); if (!state || ['blocked', 'skipped'].includes(state.status)) throw new CalculationBlocked(state?.reason ?? 'Inference node missing');
        const freshness = inferencePlanFreshness(g, plan); if (freshness.status !== 'current') throw new CalculationBlocked(freshness.reasons.join(' '));
        const node = g.graph.nodes.find(n => n.nodeId === plan.nodeId)!; if (node.task) new GeneralFollowupService(this.store).freeze(input.researchId, node, node.task.sourceIds, context.state);
        const dataset = g.datasets.find(d => d.datasetId === plan.dataset.datasetId && d.version === plan.dataset.version)!;
        if (dictionaryHash(dataset) !== plan.dataset.dictionarySha256 || source.parsedSha256 !== plan.parsedSha256) throw new Error('Inference frozen dictionary/parsed hash mismatch');
        const table = new GeneralMaterialStore(this.store.workspaceRoot).readParsed(source).tables.find(t => t.tableId === dataset.tableId)!;
        const selected = inferenceTableInput(plan, dataset, table), result = inferStudentT(selected.input, process.version);
        if (source.nature !== 'user_observation') result.warnings.push(`来源性质为 ${source.nature}；本工具的实际数学执行不授予真实实测观察。`);
        const content: InferenceArtifact = { schemaVersion: 1, kind: 'student_t_inference', researchId: input.researchId, plan, ...selected, result, startedAt, finishedAt: context.now() };
        if (Buffer.byteLength(JSON.stringify(content)) > 16 * 1024 * 1024) throw new CalculationBlocked('Inference artifact exceeds 16 MiB');
        artifact = this.publications(input.researchId).publishArtifact(content);
      } catch (e) { status = e instanceof CalculationBlocked ? 'blocked' : 'failed'; firstError = { code: e instanceof CalculationBlocked ? e.code : e instanceof BootstrapError ? e.code : 'INFERENCE_FAILED', message: (e instanceof Error ? e.message : String(e)).slice(0, 4000) }; }
      const run = validateInferenceRun({ runId: context.mint('inference-run'), planId: plan.planId, planVersion: plan.version, nodeId: plan.nodeId, attempt: attempts.length + 1, nature: source.nature, tool: { name: 'dsh-student-t', version: '1.0.0', runtime: process.version }, status, artifact, firstError, startedAt, finishedAt: context.now() });
      g.inferenceRuns.push(run); g.revision++; research.general = validateGeneralResearch(g); research.updatedAt = context.now(); return { changed: true, result: { runId: run.runId, status, firstError } };
    } });
  }
  read(researchId: string, runId: string) {
    const g = requireResearch(this.store.readStateOrEmpty(), researchId).general, run = g?.inferenceRuns.find(r => r.runId === runId); if (!g || !run) throw new BootstrapError('NOT_FOUND', 'Inference run missing');
    const plan = g.inferencePlans.find(p => p.planId === run.planId && p.version === run.planVersion)!; for (const id of plan.sourceRefs) assertGeneralSourceAccess(g, id);
    if (!run.artifact) return { run, freshness: inferencePlanFreshness(g, plan), content: null };
    const publications = this.publications(researchId), file = path.join(publications.artifactsDir, `${run.artifact.sha256}.json`), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new BootstrapError('SOURCE_STALE', 'Inference artifact type/size invalid');
    const source = g.sources.find(s => s.sourceId === plan.dataset.sourceId)!, dataset = g.datasets.find(d => d.datasetId === plan.dataset.datasetId && d.version === plan.dataset.version)!;
    const table = new GeneralMaterialStore(this.store.workspaceRoot).readParsed(source).tables.find(t => t.tableId === dataset.tableId)!;
    const content = validateInferenceArtifact(publications.readArtifactJson(run.artifact), { researchId, run, plan, source, dataset, table });
    return { run, freshness: inferencePlanFreshness(g, plan), content: content as unknown as InferenceArtifact };
  }
}
