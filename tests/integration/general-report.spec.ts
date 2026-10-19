import { confirmGeneralPrerequisites } from '../helpers/general-prerequisites.ts';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { test } from 'node:test';
import { ResearchBootstrapStore } from '../../packages/evolver/src/application/research-bootstrap-store.ts';
import { GeneralResearchService } from '../../packages/evolver/src/application/general-research-service.ts';
import { GeneralDataService } from '../../packages/evolver/src/application/general-data-service.ts';
import { GeneralAnalysisService } from '../../packages/evolver/src/application/general-analysis-service.ts';
import { GeneralMetricService } from '../../packages/evolver/src/application/general-metric-service.ts';
import { GeneralKnowledgeService } from '../../packages/evolver/src/application/general-knowledge-service.ts';
import { GeneralEvidenceService } from '../../packages/evolver/src/application/general-evidence-service.ts';
import { GeneralReportService } from '../../packages/evolver/src/application/general-report-service.ts';
import { GeneralInferenceService } from '../../packages/evolver/src/application/general-inference-service.ts';
import { ResearchCycleStore } from '../../packages/evolver/src/application/research-cycle-store.ts';
import { validateGeneralResearch } from '../../packages/evolver/src/contracts/general-research.ts';
import { validateGeneralFactPackRead, type GeneralReportSelection } from '../../packages/evolver/src/contracts/general-report.ts';
import { renderGeneralFactPackHTML } from '../../packages/evolver/src/contracts/general-report-html.ts';

function fixture(t: { after(fn: () => void): void }, nature: 'user_observation' | 'simulation' = 'user_observation') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-report-facts-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ResearchBootstrapStore(root), research = new GeneralResearchService(store), data = new GeneralDataService(store), analysis = new GeneralAnalysisService(store), metrics = new GeneralMetricService(store), knowledge = new GeneralKnowledgeService(store), access = new GeneralEvidenceService(store), reports = new GeneralReportService(store);
  const researchId = research.create({ operationId: 'create', baseRevision: 0, title: '科研事实包测试', question: '已有强度记录意味着什么？', domains: [], methods: ['engineering'], entryMode: 'existing_data' }).result.researchId;
  let n = 0;
  const write = () => ({ operationId: `report-${++n}`, baseRevision: store.readStateOrEmpty().revision, researchId });
  const g = () => store.readStateOrEmpty().researches.find(r => r.researchId === researchId)!.general!;
  const add = (csv = 'value\n1\n3\n', sourceNature = nature) => {
    const source = data.importMaterial({ ...write(), filename: `data-${n}.csv`, mediaType: 'text/csv', contentBase64: Buffer.from(csv).toString('base64'), nature: sourceNature, description: '专用测试 fixture，非科研收益', purpose: '核验' }).result;
    const datasetId = source.datasetIds[0], preview = data.preview({ researchId, datasetId });
    const fields = preview.dataset!.fields.map(f => ({ ...f, type: 'number' as const, role: 'outcome' as const, unit: 'MPa' }));
    data.saveDictionary({ ...write(), datasetId, fields, conditions: [{ name: '工况', value: '同一工况', unit: '1' }], excludedRows: [], processingReason: '测试确认字段' });
    confirmGeneralPrerequisites(store, researchId);
    return { sourceId: source.sourceId, datasetId, rows: preview.table!.totalRows };
  };
  const freezeMetrics = () => metrics.save({ ...write(), protocolId: g().metricProtocols[0].protocolId, protocol: { status: 'frozen', goal: '描述已有数据', metrics: [{ metricId: 'mean', name: '均值', definition: 'value 字段均值', role: 'primary', priority: 1, direction: 'observe', unit: 'MPa', required: true, target: { min: null, max: null }, rationale: '不做显著性判断', binding: { fieldLabel: 'value', statistic: 'mean' } }], requiredConditions: ['工况'], variedConditions: [], comparisonScope: '同工况已有记录', reason: '明确测试协议' } }).result;
  const run = (d: ReturnType<typeof add>, ref?: ReturnType<typeof freezeMetrics>, role: 'baseline' | 'candidate' = 'candidate', rowEnd = d.rows) => {
    const plan = analysis.savePlan({ ...write(), nodeId: g().graph.nodes.find(n => n.kind === 'analysis')!.nodeId, title: role, goal: '已有数据描述', datasetId: d.datasetId, datasetVersion: 2, method: 'descriptive', numericColumns: [0], groupBy: [], sampleColumns: [], rowRange: { start: 0, end: rowEnd }, missingPolicy: 'available_cases', missingGroupPolicy: 'separate', requiredConditions: [], comparisonScope: '同工况已有记录', limitations: ['无独立验证'], ...(ref ? { metricContext: { ...ref, variantKey: role, label: role, role, parentKey: null } } : {}) }).result;
    return analysis.calculate({ ...write(), planId: plan.planId, planVersion: plan.version, authorize: true }).result;
  };
  const selection = (patch: Partial<GeneralReportSelection> = {}): GeneralReportSelection => ({ sourceIds: [], calculationIds: [], knowledgeRefs: [], reviewIds: [], ...patch });
  const create = (selected = selection(), packId?: string) => reports.create({ ...write(), title: '报告事实', selection: selected, packId }).result;
  return { root, store, research, data, analysis, metrics, knowledge, access, reports, researchId, write, g, add, freezeMetrics, run, selection, create };
}

test('idea-only fact packs persist unknowns and metric drafts without fabricating observations or running models', t => {
  const f = fixture(t), saved = f.create(), result = f.reports.read(f.researchId, saved.packId);
  assert.equal(result.pack.kind, 'general_report_fact_pack'); assert.equal(result.freshness.status, 'current');
  assert.deepEqual(result.pack.sources, []); assert.deepEqual(result.pack.calculations, []); assert.deepEqual(result.pack.metrics.rows, []);
  assert.equal(result.pack.questions[0].nature, 'hypothesis'); assert.equal(result.pack.metrics.protocols[0].status, 'draft');
  assert.ok(result.pack.unknowns.some(s => s.includes('no empirical'))); assert.equal(f.g().calculations.length, 0); assert.equal(f.g().reviews.length, 0);
  const reopened = new GeneralReportService(new ResearchBootstrapStore(f.root)).read(f.researchId, saved.packId);
  assert.deepEqual(reopened.pack, result.pack); assert.equal(reopened.record.artifact.sha256, saved.artifact.sha256);
});

test('freeze uses explicit scope with real calculation IDs, preserved natures, units and original artifacts', t => {
  const f = fixture(t), selected = f.add(), outside = f.add('value\n999\n1000\n'), ref = f.freezeMetrics(), c = f.run(selected, ref);
  f.run(outside, ref);
  const saved = f.create(f.selection({ calculationIds: [c.calculationId] })), result = f.reports.read(f.researchId, saved.packId);
  assert.deepEqual(result.record.sourceIds, [selected.sourceId]); assert.equal(result.pack.calculations.length, 1);
  assert.equal(result.pack.calculations[0].summaries[0].statistics.mean, 2); assert.equal(result.pack.calculations[0].calculation.inputNature, 'user_observation');
  assert.equal(result.pack.calculations[0].check, 'provenance_checked'); assert.equal(result.pack.metrics.rows[0].cells[0].value, 2);
  assert.ok(!result.pack.sources.some(s => s.sourceId === outside.sourceId)); assert.ok(result.pack.calculations.every(x => x.calculation.input.sourceId === selected.sourceId));
});

test('simulation is still simulation despite actual mathematical calculation and report freezing', t => {
  const f = fixture(t, 'simulation'), d = f.add(), ref = f.freezeMetrics(), c = f.run(d, ref);
  const saved = f.create(f.selection({ calculationIds: [c.calculationId] })), pack = f.reports.read(f.researchId, saved.packId).pack;
  assert.equal(pack.sources[0].nature, 'simulation'); assert.equal(pack.calculations[0].calculation.inputNature, 'simulation');
  assert.equal(pack.metrics.rows[0].selectionStatus, 'not_eligible'); assert.ok(pack.boundary.includes('never a generated scientific verdict'));
});

test('fact packs integrate registered inference runs as an explicit independent reference type with closure and real recompute', t => {
  const f = fixture(t);
  const inference = new GeneralInferenceService(f.store);
  const source = f.data.importMaterial({ ...f.write(), filename: 'samples-inf.csv', mediaType: 'text/csv', contentBase64: Buffer.from('sample,value\nA,1\nB,3\nC,2\n').toString('base64'), nature: 'user_observation', description: '推断整合fixture，非科研收益', purpose: '核验' }).result;
  const datasetId = source.datasetIds[0], preview = f.data.preview({ researchId: f.researchId, datasetId });
  const fields = preview.dataset!.fields.map(field => ({ ...field }));
  fields[0].role = 'sample'; fields[1].type = 'number'; fields[1].role = 'outcome'; fields[1].unit = 'MPa';
  f.data.saveDictionary({ ...f.write(), datasetId, fields, conditions: [], excludedRows: [], processingReason: '样本与结果角色（推断整合）' });
  confirmGeneralPrerequisites(f.store, f.researchId);
  const nodeId = f.g().graph.nodes.find(n => n.kind === 'analysis')!.nodeId;
  const plan = inference.savePlan({ ...f.write(), nodeId, title: 't推断整合', datasetId, datasetVersion: 2, valueColumn: 1, sampleColumn: 0, groups: null, rowRange: { start: 0, end: preview.table!.totalRows }, spec: { method: 'one_sample_t', confidence: 0.95, referenceMean: 0, missingPolicy: 'complete_cases', assumptions: { independenceConfirmed: true, samplingRationale: '测试独立试件身份', normalityRationale: '测试数值，实际研究需重审' } }, requiredConditions: [], limitations: ['不作因果或科学支持判定'] }, 'trusted-user').result;
  const done = inference.execute({ ...f.write(), planId: plan.planId, planVersion: plan.version, authorize: true });
  assert.equal(done.result.status, 'completed', JSON.stringify(done.result.firstError));
  const runId = done.result.runId;

  const saved = f.create(f.selection({ inferenceRunIds: [runId] })), result = f.reports.read(f.researchId, saved.packId);
  assert.equal(result.pack.inferences.length, 1);
  assert.equal(result.pack.inferences[0].check, 'provenance_checked');
  assert.equal(result.pack.inferences[0].result!.estimate, 2);
  assert.equal(result.pack.inferences[0].result!.unit, 'MPa');
  assert.equal(result.pack.inferences[0].result!.standardizedEffect.name, 'cohen_d');
  assert.deepEqual(result.record.inferenceRunIds, [runId]);
  assert.ok(result.pack.sources.some(s => s.sourceId === source.sourceId), '推断闭包自动带来源');
  assert.equal(result.freshness.status, 'current');
  assert.ok(!result.pack.unknowns.some(s => s.includes('No inferential statistics')), '含推断的事实包不再宣称无推断统计');

  const legacy = f.create(f.selection());
  assert.deepEqual(f.reports.read(f.researchId, legacy.packId).pack.inferences, []);

  assert.throws(() => f.create(f.selection({ inferenceRunIds: ['foreign-run'] })), /does not belong to this research|NOT_FOUND/);

  const reviewNodeId = f.g().graph.nodes.find(n => n.kind === 'review')!.nodeId;
  const reviewResult = f.analysis.review({ ...f.write(), nodeId: reviewNodeId, calculationIds: [], sourceRefs: [], inferenceRunIds: [runId], judgment: 'insufficient', reason: '推断为数学执行；科学判断待定', support: [], counterEvidence: [], gaps: ['缺独立验证'], applicability: '仅数值层面', nextActions: [] }, 'trusted-user');
  assert.ok((f.g().reviews[0].inferenceRunIds ?? []).includes(runId));
  const withReview = f.create(f.selection({ reviewIds: [reviewResult.result.reviewId] }));
  const withReviewRead = f.reports.read(f.researchId, withReview.packId);
  assert.ok(withReviewRead.pack.sources.some(s => s.sourceId === source.sourceId), '评审引用的推断运行把其来源拉入事实包闭包');
  assert.deepEqual(withReviewRead.pack.reviews[0].review.inferenceRunIds, [runId]);
  assert.equal(withReviewRead.freshness.status, 'current');
});

test('inference references keep freshness, blocked-run and tamper honesty in fact pack reads', t => {
  const f = fixture(t);
  const inference = new GeneralInferenceService(f.store);
  const source = f.data.importMaterial({ ...f.write(), filename: 'samples-inf2.csv', mediaType: 'text/csv', contentBase64: Buffer.from('sample,value\nA,1\nB,3\nC,2\n').toString('base64'), nature: 'user_observation', description: '推断整合fixture，非科研收益', purpose: '核验' }).result;
  const datasetId = source.datasetIds[0], preview = f.data.preview({ researchId: f.researchId, datasetId });
  const fields = preview.dataset!.fields.map(field => ({ ...field }));
  fields[0].role = 'sample'; fields[1].type = 'number'; fields[1].role = 'outcome'; fields[1].unit = 'MPa';
  f.data.saveDictionary({ ...f.write(), datasetId, fields, conditions: [], excludedRows: [], processingReason: '样本与结果角色（推断整合2）' });
  confirmGeneralPrerequisites(f.store, f.researchId);
  const nodeId = f.g().graph.nodes.find(n => n.kind === 'analysis')!.nodeId;
  const planInput = { ...f.write(), nodeId, title: 't推断漂移', datasetId, datasetVersion: 2, valueColumn: 1, sampleColumn: 0, groups: null, rowRange: { start: 0, end: preview.table!.totalRows }, spec: { method: 'one_sample_t' as const, confidence: 0.95 as const, referenceMean: 0, missingPolicy: 'complete_cases' as const, assumptions: { independenceConfirmed: true, samplingRationale: '测试独立试件身份', normalityRationale: '测试数值，实际研究需重审' } }, requiredConditions: [], limitations: ['不作因果或科学支持判定'] };
  const plan = inference.savePlan(planInput, 'trusted-user').result;
  const done = inference.execute({ ...f.write(), planId: plan.planId, planVersion: plan.version, authorize: true });
  assert.equal(done.result.status, 'completed');
  const saved = f.create(f.selection({ inferenceRunIds: [done.result.runId] }));

  const drifted = structuredClone(f.g().datasets.find(d => d.datasetId === datasetId)!.fields); drifted[1].unit = 'Pa';
  f.data.saveDictionary({ ...f.write(), datasetId, fields: drifted, conditions: [], excludedRows: [], processingReason: '单位漂移需重审' });
  const driftedRead = f.reports.read(f.researchId, saved.packId);
  assert.equal(driftedRead.freshness.status, 'needs_review');
  assert.ok(driftedRead.freshness.reasons.some(s => s.includes('数据字典') || s.includes('原始来源') || s.includes('unavailable') || s.includes('Stale') || s.includes('drift') || s.length > 0));

  const cycle = new ResearchCycleStore(f.root, f.researchId);
  const original = inference.read(f.researchId, done.result.runId).content!;
  const tampered = structuredClone(original); tampered.result.pValueTwoSided = 0;
  const artifact = cycle.publishArtifact(tampered);
  f.store.mutate({ ...f.write(), kind: 'test-rehashed-inference-pack', requestPayload: { artifact }, apply: context => { context.state.researches.find(r => r.researchId === f.researchId)!.general!.inferenceRuns[0].artifact = artifact; return { changed: true, result: {} }; } });
  assert.throws(() => f.reports.read(f.researchId, saved.packId), /does not match|SOURCE_STALE/);

  const zero = fixture(t), zeroInference = new GeneralInferenceService(zero.store);
  const zeroSource = zero.data.importMaterial({ ...zero.write(), filename: 'flat.csv', mediaType: 'text/csv', contentBase64: Buffer.from('sample,value\nA,5\nB,5\n').toString('base64'), nature: 'user_observation', description: '零方差fixture', purpose: '核验' }).result;
  const zeroDatasetId = zeroSource.datasetIds[0], zeroPreview = zero.data.preview({ researchId: zero.researchId, datasetId: zeroDatasetId });
  const zeroFields = zeroPreview.dataset!.fields.map(field => ({ ...field }));
  zeroFields[0].role = 'sample'; zeroFields[1].type = 'number'; zeroFields[1].role = 'outcome'; zeroFields[1].unit = 'MPa';
  zero.data.saveDictionary({ ...zero.write(), datasetId: zeroDatasetId, fields: zeroFields, conditions: [], excludedRows: [], processingReason: '零方差fixture' });
  confirmGeneralPrerequisites(zero.store, zero.researchId);
  const zeroNode = zero.g().graph.nodes.find(n => n.kind === 'analysis')!.nodeId;
  const zeroPlan = zeroInference.savePlan({ ...zero.write(), nodeId: zeroNode, title: '零方差', datasetId: zeroDatasetId, datasetVersion: 2, valueColumn: 1, sampleColumn: 0, groups: null, rowRange: { start: 0, end: zeroPreview.table!.totalRows }, spec: { method: 'one_sample_t', confidence: 0.95, referenceMean: 0, missingPolicy: 'complete_cases', assumptions: { independenceConfirmed: true, samplingRationale: '测试', normalityRationale: '测试' } }, requiredConditions: [], limitations: ['不作因果判定'] }, 'trusted-user').result;
  const blocked = zeroInference.execute({ ...zero.write(), planId: zeroPlan.planId, planVersion: zeroPlan.version, authorize: true });
  assert.equal(blocked.result.status, 'blocked');
  const blockedPack = zero.create(zero.selection({ inferenceRunIds: [blocked.result.runId] }));
  const blockedRead = zero.reports.read(zero.researchId, blockedPack.packId);
  assert.equal(blockedRead.pack.inferences[0].check, 'unavailable'); assert.equal(blockedRead.pack.inferences[0].result, null);
  assert.ok((blockedRead.pack.inferences[0].error ?? '').includes('零标准误'));
});

test('report versions append, exact operations replay before CAS and foreign selections fail without half-written facts', t => {
  const f = fixture(t), d = f.add(), input = { ...f.write(), title: '冻结报告', selection: f.selection({ sourceIds: [d.sourceId] }) };
  const first = f.reports.create(input); assert.equal(f.reports.create(input).replayed, true); assert.equal(f.g().factPacks.length, 1);
  assert.throws(() => f.reports.create({ ...input, title: '另一个标题' }), /different request/);
  assert.throws(() => f.reports.create({ ...input, operationId: 'stale-write' }), /revision/);
  const second = f.create(input.selection, first.result.packId); assert.equal(second.version, 2);
  assert.equal(f.reports.read(f.researchId, second.packId, 1).pack.title, '冻结报告');
  for (const selection of [f.selection({ sourceIds: ['foreign'] }), f.selection({ calculationIds: ['foreign'] }), f.selection({ knowledgeRefs: [{ entryId: 'foreign', version: 1 }] }), f.selection({ reviewIds: ['foreign'] })]) assert.throws(() => f.create(selection), /belong|NOT_FOUND/);
  assert.equal(f.g().factPacks.length, 2);
});

test('cross-research IDs and caller-forged facts never become a report artifact', t => {
  const f = fixture(t), saved = f.create();
  const other = f.research.create({ ...f.write(), title: '另一研究', question: '另一问题', domains: [], methods: [], entryMode: 'idea_only' }).result.researchId;
  assert.throws(() => f.reports.read(other, saved.packId), /belong/);
  assert.throws(() => f.reports.create({ ...f.write(), researchId: other, packId: saved.packId, title: '错误绑定', selection: f.selection() }), /belong/);
  assert.throws(() => f.create({ ...f.selection(), observations: [999] } as GeneralReportSelection), /unexpected/);
  assert.throws(() => f.reports.create({ ...f.write(), title: 'NaN 输入', selection: f.selection({ knowledgeRefs: [{ entryId: 'x', version: NaN }] }) }), /version/);
});

test('new research facts make frozen reports stale without rewriting their content; layout and unrelated pack creation do not', t => {
  const f = fixture(t), d = f.add(), c = f.run(d), saved = f.create(f.selection({ calculationIds: [c.calculationId] }));
  const first = f.reports.read(f.researchId, saved.packId).pack;
  f.create(); assert.equal(f.reports.read(f.researchId, saved.packId).freshness.status, 'current');
  const nodeId = f.g().graph.nodes[0].nodeId;
  f.research.saveLayout({ ...f.write(), positions: { [nodeId]: { x: 123, y: 234 } } }); assert.equal(f.reports.read(f.researchId, saved.packId).freshness.status, 'current');
  const idea = f.g().ideas[0]; f.research.saveIdea({ ...f.write(), ideaId: idea.ideaId, question: '新的问题', rationale: '', verificationPlan: '', sourceRefs: [] });
  const stale = f.reports.read(f.researchId, saved.packId); assert.equal(stale.freshness.status, 'needs_review'); assert.deepEqual(stale.pack, first);
});

test('revoked source access denies frozen report reads, even after a receipt replay, while historical metadata is retained', t => {
  const f = fixture(t), d = f.add(), c = f.run(d), input = { ...f.write(), title: '可撤销来源', selection: f.selection({ calculationIds: [c.calculationId] }) };
  const saved = f.reports.create(input).result;
  f.access.setAccess({ ...f.write(), sourceId: d.sourceId, allowed: false, reason: '测试撤销' }, 'web-ui:test-user');
  assert.throws(() => f.reports.read(f.researchId, saved.packId), /revoked/);
  assert.equal(f.reports.create(input).replayed, true, 'replay returns historical IDs, not previously frozen content or restored authority');
  assert.equal(f.reports.projection(f.researchId)!.packs[0].access, 'revoked'); assert.equal(f.g().factPacks.length, 1);
  f.access.setAccess({ ...f.write(), sourceId: d.sourceId, allowed: true, reason: '用户明确恢复' }, 'web-ui:test-user');
  assert.equal(f.reports.read(f.researchId, saved.packId).pack.calculations[0].summaries[0].statistics.mean, 2);
});

test('source/artifact corruption is visible; report artifact hash corruption cannot fall back to fabricated data', t => {
  const f = fixture(t), d = f.add(), c = f.run(d), saved = f.create(f.selection({ calculationIds: [c.calculationId] }));
  const source = f.g().sources.find(s => s.sourceId === d.sourceId)!;
  fs.writeFileSync(path.join(f.root, '.dsh', 'research', 'materials', 'raw', source.sha256), 'tampered');
  const read = f.reports.read(f.researchId, saved.packId); assert.equal(read.freshness.status, 'needs_review'); assert.ok(read.freshness.reasons.some(s => s.includes('unavailable')));
  fs.writeFileSync(path.join(f.root, '.dsh', 'research', 'cycles', f.researchId, saved.artifact.id), '{}');
  assert.throws(() => f.reports.read(f.researchId, saved.packId), /match their ref/);
});

test('missing reference attempts never create report deltas; selected sources preserve baseline attempt ambiguity', t => {
  const f = fixture(t), a = f.add(), b = f.add('value\n3\n5\n'), ref = f.freezeMetrics();
  const baseline = f.run(a, ref, 'baseline'), candidate = f.run(b, ref);
  const selected = f.create(f.selection({ sourceIds: [a.sourceId], calculationIds: [candidate.calculationId] }));
  const row = f.reports.read(f.researchId, selected.packId).pack.metrics.rows.find(r => r.calculationId === candidate.calculationId)!;
  assert.equal(row.comparedTo, null); assert.equal(row.cells[0].delta, null); assert.ok(row.comparisonReasons.some(s => s.includes('未选入')));
  const baselinePlan = f.g().calculations.find(c => c.calculationId === baseline.calculationId)!;
  f.analysis.calculate({ ...f.write(), planId: baselinePlan.planId, planVersion: baselinePlan.planVersion, authorize: true });
  const paired = f.create(f.selection({ calculationIds: [baseline.calculationId, candidate.calculationId] }));
  const second = f.reports.read(f.researchId, paired.packId).pack.metrics.rows.find(r => r.calculationId === candidate.calculationId)!;
  assert.equal(second.cells[0].delta, null); assert.ok(second.comparisonReasons.some(s => s.includes('多个')));
});

test('unlocated Wiki and human review provenance are frozen separately from scientific support', t => {
  const f = fixture(t), d = f.add(), c = f.run(d);
  const entry = f.knowledge.save({ ...f.write(), entry: { kind: 'wiki', title: '人工整理', category: '资料', content: '仅来源级说明，无逐项 locator', nature: 'source_reported', sourceRefs: [d.sourceId], calculationIds: [], nodeIds: [], input: '', output: '', conditions: [], parameters: [], operation: 'manual', archived: false } }).result;
  const review = f.analysis.review({ ...f.write(), nodeId: f.g().graph.nodes.find(n => n.kind === 'review')!.nodeId, calculationIds: [c.calculationId], sourceRefs: [], judgment: 'insufficient', reason: '缺少对照', support: [], counterEvidence: [], gaps: ['没有独立对照'], applicability: '仅当前材料', nextActions: ['采集对照材料'] }, 'web-ui:reviewer').result;
  const saved = f.create(f.selection({ knowledgeRefs: [entry], reviewIds: [review.reviewId] })), pack = f.reports.read(f.researchId, saved.packId).pack;
  assert.equal(pack.knowledge[0].evidence.status, 'unlocated'); assert.equal(pack.reviews[0].review.judgment, 'insufficient');
  assert.equal(pack.reviews[0].review.reviewer.identity, 'web-ui:reviewer'); assert.equal(pack.calculations.length, 1); assert.ok(pack.unknowns.some(s => s.includes('Wiki')));
});

test('fact packs read one Bootstrap snapshot and strict root compatibility supplies missing report fields', t => {
  const f = fixture(t), saved = f.create(); const snapshot = f.store.readStateOrEmpty();
  const read = f.store.readStateOrEmpty.bind(f.store); let count = 0; f.store.readStateOrEmpty = () => { count++; return read(); };
  f.reports.read(f.researchId, saved.packId); assert.equal(count, 1);
  f.reports.read(f.researchId, saved.packId, 1, snapshot); assert.equal(count, 1);
  const old = { ...f.g() } as Partial<ReturnType<typeof f.g>>; delete old.factPacks; delete old.sourceAccess;
  assert.deepEqual(validateGeneralResearch(old).factPacks, []);
});

test('registered artifact substitution cannot change report research/identity/scope', t => {
  const f = fixture(t), saved = f.create(), content = f.reports.read(f.researchId, saved.packId).pack;
  const forged = new ResearchCycleStore(f.root, f.researchId).publishArtifact({ ...content, researchId: 'foreign-research' });
  f.store.mutate({ ...f.write(), kind: 'test-only-forge', requestPayload: { hash: forged.sha256 }, apply: context => { context.state.researches.find(r => r.researchId === f.researchId)!.general!.factPacks[0].artifact = forged; return { changed: true, result: {} }; } });
  assert.throws(() => f.reports.read(f.researchId, saved.packId), /identity/);
});

test('nested report schema and dependency closure reject forged fields, omissions and foreign facts', t => {
  const f = fixture(t), d = f.add(), c = f.run(d), saved = f.create(f.selection({ calculationIds: [c.calculationId] }));
  const original = f.reports.read(f.researchId, saved.packId);
  assert.deepEqual(validateGeneralFactPackRead(original), original);
  for (const change of [
    (p: typeof original.pack) => { p.sources = []; },
    (p: typeof original.pack) => { p.sources.push(p.sources[0]); },
    (p: typeof original.pack) => { p.calculations[0].calculation.input.sourceId = 'foreign'; },
    (p: typeof original.pack) => { p.sources[0].nature = 'simulation'; },
    (p: typeof original.pack) => { p.calculations[0].summaries[0].statistics.mean = Infinity; },
    (p: typeof original.pack) => { (p.calculations[0].summaries[0] as unknown as Record<string, unknown>).script = '<script>'; },
    (p: typeof original.pack) => { p.plans = []; },
    (p: typeof original.pack) => { p.datasets = []; },
    (p: typeof original.pack) => { p.questions[0].nature = 'verified' as 'hypothesis'; },
  ]) { const copy = structuredClone(original); change(copy.pack); assert.throws(() => validateGeneralFactPackRead(copy)); }
  const forged = structuredClone(original.pack); forged.sources[0].description = '替换历史来源说明';
  const ref = new ResearchCycleStore(f.root, f.researchId).publishArtifact(forged);
  f.store.mutate({ ...f.write(), kind: 'test-substitute-nested', requestPayload: ref, apply: context => { context.state.researches.find(r => r.researchId === f.researchId)!.general!.factPacks[0].artifact = ref; return { changed: true, result: {} }; } });
  assert.throws(() => f.reports.read(f.researchId, saved.packId), /nested fact/);
});

test('oversized and missing report artifacts fail closed without adding a frozen version', t => {
  const f = fixture(t), saved = f.create();
  const file = path.join(f.root, '.dsh', 'research', 'cycles', f.researchId, saved.artifact.id);
  fs.writeFileSync(file, ' '.repeat(4 * 1024 * 1024 + 1));
  assert.throws(() => f.reports.read(f.researchId, saved.packId), /exceeds 4 MiB/);
  fs.unlinkSync(file); assert.throws(() => f.reports.read(f.researchId, saved.packId), /missing/);
  assert.equal(f.g().factPacks.length, 1);
});

test('HTML export preserves zero/null, simulation, stale reasons and escapes untrusted evidence without scripts or network', t => {
  const f = fixture(t, 'simulation'), d = f.add('value\n0\n'), ref = f.freezeMetrics(), c = f.run(d, ref), saved = f.create(f.selection({ calculationIds: [c.calculationId] }));
  const read = f.reports.read(f.researchId, saved.packId), before = structuredClone(read);
  read.pack.title = read.record.title = '<img src="https://attacker.invalid" onerror="alert(1)">';
  read.pack.unknowns.push('</pre><script>fetch("https://attacker.invalid")</script>');
  read.freshness = { status: 'needs_review', reasons: ['test stale source'] };
  const html = renderGeneralFactPackHTML(read);
  assert.ok(html.includes('mean: 0')); assert.ok(html.includes('simulation')); assert.ok(html.includes('needs_review')); assert.ok(html.includes('test stale source')); assert.ok(html.includes('未知（null）') || html.includes('&quot;sampleSD&quot;: null'));
  assert.ok(html.includes('script-src \'none\'')); assert.ok(html.includes('connect-src \'none\''));
  assert.ok(!html.includes('<script')); assert.ok(!html.includes('<img')); assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('离线冻结快照')); assert.ok(html.includes(before.record.artifact.sha256));
  const input = structuredClone(read); renderGeneralFactPackHTML(read); assert.deepEqual(read, input);
  const out = path.resolve('artifacts/eval/flagship-batch2-2026-10-13/report-example.html');
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, html);
});

test('creation rejects a full fact pack above 4 MiB before publishing or registering a version', t => {
  const f = fixture(t);
  // Valid legacy unlocated claims with explicit limitations, bulk-seeded only to exercise the size boundary.
  f.store.mutate({ ...f.write(), kind: 'test-bulk-knowledge', requestPayload: {}, apply: context => {
    const g = context.state.researches.find(r => r.researchId === f.researchId)!.general!;
    g.knowledge = Array.from({ length: 12 }, (_, i) => ({ entryId: `size-${i}`, version: 1, kind: 'wiki' as const, title: '尺寸测试', category: '测试', content: '测试内容', nature: 'unknown' as const, sourceRefs: [], calculationIds: [], nodeIds: [], input: '', output: '', conditions: Array.from({ length: 100 }, () => 'x'.repeat(4000)), parameters: [], operation: 'manual' as const, archived: false, createdAt: new Date().toISOString() }));
    return { changed: true, result: {} };
  } });
  const revision = f.store.readStateOrEmpty().revision;
  assert.throws(() => f.create(f.selection({ knowledgeRefs: f.g().knowledge.map(k => ({ entryId: k.entryId, version: k.version })) })), /exceeds 4 MiB/);
  assert.equal(f.store.readStateOrEmpty().revision, revision); assert.equal(f.g().factPacks.length, 0);
  const artifacts = path.join(f.root, '.dsh', 'research', 'cycles', f.researchId, 'artifacts');
  assert.equal(fs.existsSync(artifacts), false);
});

test('report artifact directory junctions cannot escape the registered publication namespace', t => {
  const f = fixture(t), saved = f.create();
  const directory = path.join(f.root, '.dsh', 'research', 'cycles', f.researchId, 'artifacts');
  const moved = path.join(f.root, 'artifact-junction-target');
  fs.renameSync(directory, moved); fs.symlinkSync(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.reports.read(f.researchId, saved.packId), /link or a non-directory/);
  assert.equal(f.g().factPacks.length, 1);
});

