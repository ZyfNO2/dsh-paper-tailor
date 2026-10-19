import { confirmGeneralPrerequisites } from '../helpers/general-prerequisites.ts';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ResearchBootstrapStore } from '../../packages/evolver/src/application/research-bootstrap-store.ts';
import { GeneralResearchService } from '../../packages/evolver/src/application/general-research-service.ts';
import { GeneralDataService } from '../../packages/evolver/src/application/general-data-service.ts';
import { GeneralAnalysisService, generalContextHash } from '../../packages/evolver/src/application/general-analysis-service.ts';
import { GeneralMetricService } from '../../packages/evolver/src/application/general-metric-service.ts';
import { ResearchCycleStore } from '../../packages/evolver/src/application/research-cycle-store.ts';
import { validateGeneralResearch } from '../../packages/evolver/src/contracts/general-research.ts';
import { validateMetricProtocol } from '../../packages/evolver/src/contracts/general-metrics.ts';
import type { GeneralMetric, GeneralMetricProtocol } from '../../packages/evolver/src/contracts/general-metrics.ts';
import type { DataField, MaterialNature, DatasetVersion } from '../../packages/evolver/src/contracts/general-data.ts';

const meanMetric = (patch: Partial<GeneralMetric> = {}): GeneralMetric => ({ metricId: 'value-mean', name: '测量值均值', definition: '冻结口径下 value 字段的均值', role: 'primary', priority: 1, direction: 'maximize', unit: 'MPa', required: true, target: { min: null, max: null }, rationale: '测试数学汇总；不是研究收益', binding: { fieldLabel: 'value', statistic: 'mean' }, ...patch });
type ProtocolInput = Parameters<GeneralMetricService['save']>[0]['protocol'];
const protocolInput = (patch: Partial<ProtocolInput> = {}): ProtocolInput => ({ status: 'frozen', goal: '已有观察可支持什么？', metrics: [meanMetric()], requiredConditions: ['工况'], variedConditions: [], comparisonScope: '仅相同工况下的描述性数值比较，不推断显著性', reason: '测试专用冻结协议', ...patch });

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-general-metrics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ResearchBootstrapStore(root), general = new GeneralResearchService(store), data = new GeneralDataService(store), analysis = new GeneralAnalysisService(store), metrics = new GeneralMetricService(store);
  const researchId = general.create({ operationId: 'create', baseRevision: 0, title: '指标可信性测试', question: '已有观察可支持什么？', domains: [], methods: ['engineering'], entryMode: 'existing_data' }).result.researchId;
  const read = () => store.readStateOrEmpty().researches.find(r => r.researchId === researchId)!.general!;
  let sequence = 0;
  const write = () => ({ operationId: `op-${++sequence}`, baseRevision: store.readStateOrEmpty().revision, researchId });
  const addDataset = (csv = 'sample,group,value\nA,X,1\nB,X,3\n', nature: MaterialNature = 'user_observation', fieldPatch: Partial<DataField> = {}, conditions: DatasetVersion['conditions'] = [{ name: '工况', value: '同一工况', unit: '1' }]) => {
    const source = data.importMaterial({ ...write(), filename: `fixture-${sequence}.csv`, mediaType: 'text/csv', contentBase64: Buffer.from(csv).toString('base64'), nature, description: '测试专用，不是用户实验数据', purpose: '验证内核', previousSourceId: null });
    const datasetId = source.result.datasetIds[0], preview = data.preview({ researchId, datasetId });
    const fields = structuredClone(preview.dataset!.fields);
    fields[0].role = 'sample'; fields[1].role = 'group'; fields[1].type = 'category';
    fields[2] = { ...fields[2], type: 'number', role: 'outcome', unit: 'MPa', ...fieldPatch };
    data.saveDictionary({ ...write(), datasetId, fields, conditions, excludedRows: [], processingReason: '测试明确字段口径' });
    confirmGeneralPrerequisites(store, researchId);
    return { datasetId, version: 2, sourceId: source.result.sourceId, rowCount: preview.table!.totalRows };
  };
  const save = (protocol = protocolInput(), protocolId = read().metricProtocols[0].protocolId) => metrics.save({ ...write(), protocolId, protocol }).result;
  const plan = (d: ReturnType<typeof addDataset>, ref: { protocolId: string; version: number }, role: 'baseline' | 'candidate' | 'ablation' = 'candidate', patch: Partial<Parameters<GeneralAnalysisService['savePlan']>[0]> = {}) => analysis.savePlan({ ...write(), nodeId: read().graph.nodes.find(n => n.kind === 'analysis')!.nodeId, title: role, goal: '仅已有材料的描述统计', datasetId: d.datasetId, datasetVersion: d.version, method: 'descriptive', numericColumns: [2], groupBy: [], sampleColumns: [], rowRange: { start: 0, end: d.rowCount }, missingPolicy: 'available_cases', missingGroupPolicy: 'separate', requiredConditions: [], comparisonScope: '明确可比的已有数据', limitations: ['不代表独立实验验证'], metricContext: { ...ref, variantKey: role, label: role, role, parentKey: null }, ...patch }).result;
  const run = (p: { planId: string; version: number }) => analysis.calculate({ ...write(), planId: p.planId, planVersion: p.version, authorize: true }).result;
  const report = (d: ReturnType<typeof addDataset>, ref: { protocolId: string; version: number }, patch: Partial<Parameters<GeneralMetricService['report']>[0]['report']> = {}) => metrics.report({ ...write(), report: { ...ref, label: '来源报告', sourceId: d.sourceId, locator: 'fixture 表格 value 列', values: [{ metricId: 'value-mean', value: 2, unit: 'MPa' }], conditions: [], note: '只登记来源报告，不冒充本地计算', ...patch } }).result;
  return { root, store, general, data, analysis, metrics, researchId, read, write, addDataset, save, plan, run, report };
}

test('new research has provisional unknown metrics; old generic records read with empty metric defaults', t => {
  const f = fixture(t), g = f.read();
  assert.equal(g.metricProtocols[0].status, 'draft'); assert.equal(g.metricProtocols[0].contextHash, null);
  assert.equal(g.metricProtocols[0].metrics[0].binding, null); assert.equal(g.metricProtocols[0].metrics[0].unit, null);
  assert.deepEqual(g.metricProtocols[0].metrics[0].target, { min: null, max: null }); assert.deepEqual(f.metrics.projection(f.researchId)!.rows, []);
  const old = structuredClone(g) as Partial<typeof g>; delete old.metricProtocols; delete old.metricReports;
  assert.deepEqual(validateGeneralResearch(old).metricProtocols, []);
  assert.throws(() => validateGeneralResearch({ ...g, forgedScientificSuccess: true }), /unexpected/);
});

test('draft/frozen updates append; replay and CAS conflicts never duplicate or overwrite history', t => {
  const f = fixture(t), original = structuredClone(f.read().metricProtocols[0]);
  const request = { ...f.write(), protocolId: original.protocolId, protocol: protocolInput({ status: 'draft' }) };
  const draft = f.metrics.save(request);
  assert.equal(draft.result.version, 2); assert.equal(f.metrics.save(request).replayed, true);
  assert.throws(() => f.metrics.save({ ...request, protocol: { ...request.protocol, reason: '不同请求' } }), /different request/);
  assert.throws(() => f.metrics.save({ ...request, operationId: 'stale-write' }), /revision/);
  const frozen = f.save(); assert.equal(frozen.version, 3);
  assert.deepEqual(f.read().metricProtocols[0], original);
  assert.equal(f.read().metricProtocols.at(-1)!.contextHash, generalContextHash(f.read()));
});

test('hard constraints need bounds/unit/required; nonfinite values and contradictory ranges fail closed', t => {
  const f = fixture(t);
  for (const patch of [{ target: { min: null, max: null } }, { unit: null }, { required: false }]) assert.throws(() => f.save(protocolInput({ metrics: [meanMetric({ role: 'constraint', target: { min: 1, max: 3 }, ...patch })] })), /constraints/);
  assert.throws(() => f.save(protocolInput({ metrics: [meanMetric({ target: { min: 4, max: 1 } })] })), /reversed/);
  assert.throws(() => f.save(protocolInput({ metrics: [meanMetric({ target: { min: NaN, max: null } })] })), /finite/);
  const d = f.addDataset(), ref = f.save();
  assert.throws(() => f.report(d, ref, { values: [{ metricId: 'value-mean', value: Infinity, unit: 'MPa' }] }), /finite/);
  assert.equal(f.read().metricReports.length, 0);
});

test('metric identity is invariant across removed intervening versions, including stored history', t => {
  const f = fixture(t), ref = f.save();
  f.save(protocolInput({ metrics: [meanMetric({ metricId: 'other-metric' })] }));
  assert.throws(() => f.save(protocolInput({ metrics: [meanMetric({ definition: '不同定义' })] })), /metricId|identity|身份/);
  const g = f.read(), old = g.metricProtocols.find(p => p.version === ref.version)!;
  const forged: GeneralMetricProtocol = { ...structuredClone(old), version: g.metricProtocols.at(-1)!.version + 1, metrics: [meanMetric({ binding: { fieldLabel: 'value', statistic: 'median' } })] };
  assert.throws(() => validateGeneralResearch({ ...g, metricProtocols: [...g.metricProtocols, forged] }), /metricId|identity|身份/);
});

test('same metricId cannot silently change physical unit, while a new identity may define a new metric', t => {
  const f = fixture(t); f.save();
  assert.throws(() => f.save(protocolInput({ metrics: [meanMetric({ unit: 'kPa' })] })), /metricId|identity|身份/);
  const ref = f.save(protocolInput({ metrics: [meanMetric({ metricId: 'value-kpa', unit: 'kPa' })] }));
  assert.equal(f.read().metricProtocols.at(-1)!.version, ref.version);
});

test('suggestions use unit-qualified identities and leave incompatible same-name outcomes unresolved', t => {
  const f = fixture(t), d = f.addDataset();
  f.metrics.suggest({ ...f.write(), protocolId: f.read().metricProtocols[0].protocolId });
  const old = structuredClone(f.read().metricProtocols.at(-1)!.metrics[0]);
  const dataset = f.read().datasets.find(x => x.datasetId === d.datasetId && x.version === 2)!;
  f.data.saveDictionary({ ...f.write(), datasetId: d.datasetId, fields: dataset.fields.map(x => x.column === 2 ? { ...x, unit: 'kPa' } : x), conditions: dataset.conditions, excludedRows: [], processingReason: '测试新单位语义' });
  f.metrics.suggest({ ...f.write(), protocolId: f.read().metricProtocols[0].protocolId });
  const next = f.read().metricProtocols.at(-1)!.metrics[0]; assert.notEqual(next.metricId, old.metricId);
  f.addDataset(undefined, 'user_observation', { unit: 'MPa' });
  f.metrics.suggest({ ...f.write(), protocolId: f.read().metricProtocols[0].protocolId });
  assert.ok(f.read().metricProtocols.at(-1)!.metrics.every(m => m.binding === null), 'ambiguous labels must not select the first unit silently');
});

test('cross-research metric protocols, reports and source IDs cannot be borrowed', t => {
  const f = fixture(t), d = f.addDataset(), ref = f.save();
  const other = f.general.create({ ...f.write(), title: '另一研究', question: '隔离问题', domains: [], methods: [], entryMode: 'idea_only' }).result.researchId;
  assert.throws(() => f.metrics.save({ ...f.write(), researchId: other, protocolId: ref.protocolId, protocol: protocolInput() }), /不属于/);
  assert.throws(() => f.metrics.suggest({ ...f.write(), researchId: other, protocolId: ref.protocolId }), /不属于/);
  assert.throws(() => f.metrics.report({ ...f.write(), researchId: other, report: { ...ref, label: '越界', sourceId: d.sourceId, locator: '测试', values: [], conditions: [], note: '不得跨研究' } }), /不属于/);
  assert.throws(() => f.report(d, { protocolId: 'missing-protocol', version: 1 }), /protocol/);
  assert.throws(() => f.report(d, ref, { values: [{ metricId: 'foreign-metric', value: 2, unit: 'MPa' }] }), /metric/);
});

test('required bound metrics must be selected numeric outputs; absent optional evaluator does not block supported metrics', t => {
  const f = fixture(t), d = f.addDataset();
  const required = f.save(protocolInput({ metrics: [meanMetric({ metricId: 'group-mean', binding: { fieldLabel: 'group', statistic: 'mean' } })] }));
  assert.throws(() => f.plan(d, required), /绑定/);
  const selected = f.save(protocolInput({ metrics: [meanMetric({ metricId: 'sample-mean', binding: { fieldLabel: 'sample', statistic: 'mean' } })] }));
  assert.throws(() => f.plan(d, selected), /绑定/);
  const optional = f.save(protocolInput({ metrics: [meanMetric(), meanMetric({ metricId: 'future-evaluator', required: false, role: 'auxiliary', binding: { fieldLabel: 'future', statistic: 'mean' } })] }));
  const run = f.run(f.plan(d, optional)); assert.equal(run.status, 'completed');
  const row = f.metrics.projection(f.researchId)!.rows[0]; assert.equal(row.cells[1].status, 'missing'); assert.equal(row.selectionStatus, 'needs_validation');
});

test('binding an unselected required numeric column is rejected, not hidden as a missing matrix value', t => {
  const f = fixture(t), d = f.addDataset('sample,group,value,extra\nA,X,1,5\nB,X,3,7\n');
  const dataset = f.read().datasets.find(x => x.datasetId === d.datasetId && x.version === 2)!;
  f.data.saveDictionary({ ...f.write(), datasetId: d.datasetId, fields: dataset.fields.map(x => x.column === 3 ? { ...x, type: 'number', role: 'outcome', unit: 'MPa' } : x), conditions: dataset.conditions, excludedRows: [], processingReason: '测试额外输出字段' });
  d.version = 3;
  const ref = f.save(protocolInput({ metrics: [meanMetric({ binding: { fieldLabel: 'extra', statistic: 'mean' } })] }));
  assert.throws(() => f.plan(d, ref), /绑定/);
});

test('unique matched baseline yields a descriptive delta with provenance, never scientific success or ranking', t => {
  const f = fixture(t), a = f.addDataset(), b = f.addDataset('sample,group,value\nA,X,3\nB,X,5\n'), ref = f.save();
  const baseline = f.run(f.plan(a, ref, 'baseline')), candidate = f.run(f.plan(b, ref));
  const p = f.metrics.projection(f.researchId)!;
  const row = p.rows.find(r => r.calculationId === candidate.calculationId)!;
  assert.equal(row.cells[0].value, 4); assert.equal(row.cells[0].delta, 2);
  assert.equal(row.comparedTo, p.rows.find(r => r.calculationId === baseline.calculationId)!.rowId);
  assert.equal(row.check, 'provenance_checked'); assert.equal(row.selectionStatus, 'needs_validation');
  assert.equal(f.read().reviews.length, 0); assert.match(p.boundary, /不证明/);
});

test('multiple baseline attempts never choose the best or latest attempt', t => {
  const f = fixture(t), d = f.addDataset(), ref = f.save(), p = f.plan(d, ref, 'baseline');
  f.run(p); f.run(p); f.run(f.plan(d, ref));
  const row = f.metrics.projection(f.researchId)!.rows.find(r => r.role === 'candidate')!;
  assert.equal(row.cells[0].delta, null); assert.equal(row.comparedTo, null); assert.ok(row.comparisonReasons.some(r => r.includes('多个')));
});

test('hard constraint failure or a required unavailable evaluator blocks selection and comparison', t => {
  const f = fixture(t), d = f.addDataset();
  const ref = f.save(protocolInput({ metrics: [meanMetric(), meanMetric({ metricId: 'hard', role: 'constraint', target: { min: 5, max: null } }), meanMetric({ metricId: 'not-integrated', role: 'auxiliary', binding: null })] }));
  f.run(f.plan(d, ref, 'baseline')); f.run(f.plan(d, ref));
  const row = f.metrics.projection(f.researchId)!.rows.find(r => r.role === 'candidate')!;
  assert.equal(row.constraintsStatus, 'failed'); assert.equal(row.selectionStatus, 'not_eligible'); assert.equal(row.cells[0].delta, null);
  assert.ok(row.blockers.some(b => b.includes('硬约束'))); assert.ok(row.blockers.some(b => b.includes('未完整测量')));
});

test('zero is a recorded observation; empty and singleton uncertainty remain unavailable rather than fabricated', t => {
  const f = fixture(t), d = f.addDataset('sample,group,value\nA,X,0\n');
  const ref = f.save(protocolInput({ metrics: [meanMetric(), meanMetric({ metricId: 'sd', role: 'auxiliary', required: false, binding: { fieldLabel: 'value', statistic: 'sampleSD' } })] }));
  f.run(f.plan(d, ref)); f.run(f.plan(d, ref, 'candidate', { rowRange: { start: 0, end: 0 } }));
  const rows = f.metrics.projection(f.researchId)!.rows;
  assert.equal(rows[0].cells[0].value, 0); assert.equal(rows[0].cells[0].status, 'recorded'); assert.equal(rows[0].cells[1].value, null);
  assert.equal(rows[1].cells[0].value, null); assert.equal(rows[1].selectionStatus, 'not_eligible');
});

test('count metrics require the explicit dimensionless unit 1', t => {
  const f = fixture(t);
  assert.throws(() => f.save(protocolInput({ metrics: [meanMetric({ binding: { fieldLabel: 'value', statistic: 'count' } })] })), /count|计数/);
  const d = f.addDataset(), ref = f.save(protocolInput({ metrics: [meanMetric({ unit: '1', binding: { fieldLabel: 'value', statistic: 'count' } })] }));
  f.run(f.plan(d, ref)); const c = f.metrics.projection(f.researchId)!.rows[0].cells[0];
  assert.equal(c.unit, '1'); assert.equal(c.value, 2); assert.equal(c.status, 'recorded');
});

test('units, protocol versions and source natures are isolated without implicit conversion', t => {
  const f = fixture(t), a = f.addDataset(), b = f.addDataset(undefined, 'user_observation', { unit: 'kPa' }), s = f.addDataset(undefined, 'simulation'), ref = f.save();
  f.run(f.plan(a, ref, 'baseline')); const mismatch = f.run(f.plan(b, ref)), sim = f.run(f.plan(s, ref));
  const newer = f.save(); const isolated = f.run(f.plan(a, newer));
  const rows = f.metrics.projection(f.researchId)!.rows;
  assert.equal(rows.find(r => r.calculationId === mismatch.calculationId)!.cells[0].status, 'unit_mismatch');
  assert.equal(rows.find(r => r.calculationId === sim.calculationId)!.selectionStatus, 'not_eligible');
  assert.equal(rows.find(r => r.calculationId === isolated.calculationId)!.comparedTo, null);
  assert.ok(rows.filter(r => r.role !== 'baseline').every(r => r.cells[0].delta === null));
});

test('processing recipes include missing markers, not just same units and method names', t => {
  const f = fixture(t), csv = 'sample,group,value\nA,X,-99\nB,X,3\n';
  const a = f.addDataset(csv), b = f.addDataset(csv, 'user_observation', { missingValues: ['-99'] }), ref = f.save();
  f.run(f.plan(a, ref, 'baseline')); f.run(f.plan(b, ref));
  const row = f.metrics.projection(f.researchId)!.rows.find(r => r.role === 'candidate')!;
  assert.equal(row.cells[0].delta, null); assert.ok(row.comparisonReasons.some(s => /处理|缺失|口径/.test(s)));
});

test('different controls, unknown controls, ranges and grouping meanings prevent comparison', t => {
  const f = fixture(t), a = f.addDataset(), b = f.addDataset(undefined, 'user_observation', {}, [{ name: '工况', value: '不同工况', unit: '1' }]), u = f.addDataset(undefined, 'user_observation', {}, [{ name: '工况', value: null, unit: '1' }]), ref = f.save();
  f.run(f.plan(a, ref, 'baseline')); f.run(f.plan(b, ref)); f.run(f.plan(u, ref)); f.run(f.plan(a, ref, 'candidate', { rowRange: { start: 0, end: 1 } }));
  assert.ok(f.metrics.projection(f.researchId)!.rows.filter(r => r.role === 'candidate').every(r => r.cells[0].delta === null));
});

test('source reports stay source_reported; missing/corrupt raw blobs revoke the availability check', t => {
  const f = fixture(t), d = f.addDataset(), ref = f.save(), report = f.report(d, ref);
  const first = f.metrics.projection(f.researchId)!.rows[0]; assert.equal(first.origin, 'source_reported'); assert.equal(first.selectionStatus, 'not_eligible'); assert.equal(first.comparedTo, null);
  const source = f.read().sources.find(s => s.sourceId === d.sourceId)!;
  fs.writeFileSync(path.join(f.root, '.dsh', 'research', 'materials', 'raw', source.sha256), 'tampered');
  const row = f.metrics.projection(f.researchId)!.rows.find(r => r.rowId === report.reportId)!;
  assert.equal(row.check, 'unavailable'); assert.ok(row.blockers.some(s => /hash|来源|资料/.test(s)));
});

test('changed research context marks frozen source reports and calculations for re-review', t => {
  const f = fixture(t), d = f.addDataset(), ref = f.save(); f.report(d, ref); f.run(f.plan(d, ref));
  const idea = f.read().ideas[0];
  f.general.saveIdea({ ...f.write(), ideaId: idea.ideaId, question: '新的研究问题', rationale: '', verificationPlan: '', sourceRefs: [] });
  const rows = f.metrics.projection(f.researchId)!.rows;
  assert.ok(rows.every(r => r.blockers.some(b => b.includes('指标协议待重审'))));
});

test('blocked/failed calculations and tampered artifacts remain visible with null metric values', t => {
  const f = fixture(t), d = f.addDataset(), ref = f.save();
  const blocked = f.run(f.plan(d, ref, 'candidate', { requiredConditions: ['缺失条件'] })); assert.equal(blocked.status, 'blocked');
  const good = f.run(f.plan(d, ref));
  const c = f.read().calculations.find(c => c.calculationId === good.calculationId)!;
  fs.writeFileSync(path.join(f.root, '.dsh', 'research', 'cycles', f.researchId, c.artifact!.id), '{}');
  const projection = f.metrics.projection(f.researchId)!;
  assert.equal(projection.rows.length, 2); assert.ok(projection.rows.every(r => r.cells[0].value === null && r.selectionStatus === 'not_eligible'));
  assert.equal(projection.errors.length, 1); assert.equal(f.read().calculations.find(c => c.calculationId === good.calculationId)!.status, 'completed');
});

test('rehashing a structurally valid artifact cannot substitute the registered plan/input snapshot', t => {
  const f = fixture(t), d = f.addDataset(), ref = f.save(), c = f.run(f.plan(d, ref));
  const content = structuredClone(f.analysis.readCalculation(f.researchId, c.calculationId).content!);
  content.plan.comparisonScope = '篡改后的范围';
  const replacement = new ResearchCycleStore(f.root, f.researchId).publishArtifact(content);
  f.store.mutate({ ...f.write(), kind: 'test-only-tamper', requestPayload: { fixture: 'different-plan' }, apply: context => { context.state.researches.find(r => r.researchId === f.researchId)!.general!.calculations.find(x => x.calculationId === c.calculationId)!.artifact = replacement; return { changed: true, result: {} }; } });
  assert.throws(() => f.analysis.readCalculation(f.researchId, c.calculationId), /快照|产物|协议/);
  const row = f.metrics.projection(f.researchId)!.rows[0]; assert.equal(row.check, 'unavailable'); assert.equal(row.cells[0].value, null);
});

test('matrix uses one Bootstrap snapshot, regardless of the number of calculations', t => {
  const f = fixture(t), d = f.addDataset(), ref = f.save(), p = f.plan(d, ref); f.run(p); f.run(p);
  const read = f.store.readStateOrEmpty.bind(f.store); let reads = 0;
  f.store.readStateOrEmpty = () => { reads++; return read(); };
  const projection = f.metrics.projection(f.researchId)!;
  assert.equal(projection.rows.length, 2); assert.equal(reads, 1, 'a projection must not re-read mutable state for every artifact');
});

test('draft metric protocols cannot be bound to analysis or used by a source report', t => {
  const f = fixture(t), d = f.addDataset(), ref = f.save(protocolInput({ status: 'draft' }));
  assert.throws(() => f.plan(d, ref), /冻结/); assert.throws(() => f.report(d, ref), /protocol/);
  const g = f.read(), frozen = { ...g.metricProtocols.at(-1)!, status: 'frozen', contextHash: null };
  assert.throws(() => validateMetricProtocol(frozen), /pinned/);
});

test('an optional unavailable metric never prevents valid primary deltas or invents its own measurement', t => {
  const f = fixture(t), a = f.addDataset(), b = f.addDataset('sample,group,value\nA,X,3\nB,X,5\n');
  const ref = f.save(protocolInput({ metrics: [meanMetric(), meanMetric({ metricId: 'optional', role: 'auxiliary', required: false, binding: { fieldLabel: 'unavailable', statistic: 'mean' } })] }));
  f.run(f.plan(a, ref, 'baseline')); f.run(f.plan(b, ref));
  const row = f.metrics.projection(f.researchId)!.rows.find(r => r.role === 'candidate')!;
  assert.equal(row.cells[0].delta, 2); assert.equal(row.cells[1].delta, null); assert.equal(row.cells[1].status, 'missing');
});

test('empty grouped calculations retain a visible registered attempt with missing metrics', t => {
  const f = fixture(t), d = f.addDataset(), ref = f.save();
  const c = f.run(f.plan(d, ref, 'candidate', { method: 'grouped_descriptive', groupBy: [1], rowRange: { start: 0, end: 0 } }));
  assert.equal(c.status, 'completed');
  const rows = f.metrics.projection(f.researchId)!.rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].calculationId, c.calculationId); assert.equal(rows[0].cells[0].value, null);
  assert.equal(rows[0].selectionStatus, 'not_eligible');
});

test('an ablation compares only its declared parent, not an unrelated baseline', t => {
  const f = fixture(t), a = f.addDataset(), b = f.addDataset('sample,group,value\nA,X,3\nB,X,5\n'), ref = f.save();
  f.run(f.plan(a, ref, 'baseline')); const parent = f.run(f.plan(b, ref));
  const ablation = f.run(f.plan(a, ref, 'ablation', { metricContext: { ...ref, variantKey: 'ablation', label: 'ablation', role: 'ablation', parentKey: 'candidate' } }));
  const rows = f.metrics.projection(f.researchId)!.rows, row = rows.find(r => r.calculationId === ablation.calculationId)!;
  assert.equal(row.comparedTo, rows.find(r => r.calculationId === parent.calculationId)!.rowId); assert.equal(row.cells[0].delta, -2);
});

test('corrupted raw or parsed material makes calculation provenance unavailable without rewriting history', t => {
  const f = fixture(t), d = f.addDataset(), ref = f.save(), c = f.run(f.plan(d, ref));
  const source = f.read().sources.find(s => s.sourceId === d.sourceId)!;
  const parsed = path.join(f.root, '.dsh', 'research', 'materials', 'parsed', source.parsedSha256);
  fs.writeFileSync(parsed, '{}');
  const p = f.metrics.projection(f.researchId)!;
  assert.equal(p.errors.length, 1); assert.equal(p.rows[0].check, 'unavailable'); assert.equal(p.rows[0].cells[0].value, null);
  assert.equal(f.read().calculations[0].status, 'completed'); assert.ok(f.analysis.readCalculation(f.researchId, c.calculationId).content, 'historical artifact remains inspectable; input availability is a distinct check');
});

test('rehashing malformed statistics or a contradictory chart does not grant a checked result', t => {
  const f = fixture(t), d = f.addDataset(), ref = f.save(), c = f.run(f.plan(d, ref));
  const original = f.analysis.readCalculation(f.researchId, c.calculationId).content!;
  for (const mutate of [(content: typeof original) => { content.summaries[0].statistics.mean = null; }, (content: typeof original) => { content.chart[0].series[0].mean = 999; }, (content: typeof original) => { content.inputSnapshot.parser = 'unregistered-parser'; }]) {
    const content = structuredClone(original); mutate(content);
    const replacement = new ResearchCycleStore(f.root, f.researchId).publishArtifact(content);
    f.store.mutate({ ...f.write(), kind: 'test-only-tamper', requestPayload: { hash: replacement.sha256 }, apply: context => { context.state.researches.find(r => r.researchId === f.researchId)!.general!.calculations.find(x => x.calculationId === c.calculationId)!.artifact = replacement; return { changed: true, result: {} }; } });
    assert.throws(() => f.analysis.readCalculation(f.researchId, c.calculationId), /产物/);
    assert.equal(f.metrics.projection(f.researchId)!.rows[0].check, 'unavailable');
  }
});

test('projection resource ceilings fail the entire matrix visibly, never compare a truncated subset', t => {
  const f = fixture(t), d = f.addDataset(), ref = f.save(); f.run(f.plan(d, ref, 'baseline')); f.run(f.plan(d, ref));
  const rowsLimited = new GeneralMetricService(f.store, { maxRows: 1 }).projection(f.researchId)!;
  assert.deepEqual(rowsLimited.rows, []); assert.ok(rowsLimited.errors.some(e => e.message.includes('行数上限'))); assert.match(rowsLimited.boundary, /没有截断/);
  const bytesLimited = new GeneralMetricService(f.store, { maxArtifactBytes: 1 }).projection(f.researchId)!;
  assert.deepEqual(bytesLimited.rows, []); assert.ok(bytesLimited.errors.some(e => e.message.includes('字节上限')));
  assert.throws(() => new GeneralMetricService(f.store, { maxRows: 10001 }), /只能收紧/);
  assert.equal(f.read().calculations.length, 2);
});

test('caller-supplied trusted snapshots prevent later metadata changes from being mixed into a matrix', t => {
  const f = fixture(t), d = f.addDataset(), ref = f.save(); f.run(f.plan(d, ref));
  const snapshot = f.store.readStateOrEmpty(), idea = f.read().ideas[0];
  f.general.saveIdea({ ...f.write(), ideaId: idea.ideaId, question: '后续问题', rationale: '', verificationPlan: '', sourceRefs: [] });
  const reads = f.store.readStateOrEmpty.bind(f.store); let count = 0; f.store.readStateOrEmpty = () => { count++; return reads(); };
  assert.equal(f.metrics.projection(f.researchId, snapshot)!.rows[0].blockers.length, 0); assert.equal(count, 0);
  assert.ok(f.metrics.projection(f.researchId)!.rows[0].blockers.length > 0);
});

test('new protocol versions use the maximum saved version, not accidental array order', t => {
  const f = fixture(t); f.save(); const latest = f.save();
  f.store.mutate({ ...f.write(), kind: 'test-only-reorder', requestPayload: { fixture: 'history-order' }, apply: context => { context.state.researches.find(r => r.researchId === f.researchId)!.general!.metricProtocols.reverse(); return { changed: true, result: {} }; } });
  assert.equal(f.save().version, latest.version + 1);
  const suggested = f.metrics.suggest({ ...f.write(), protocolId: latest.protocolId });
  assert.equal(suggested.result.version, latest.version + 2);
});

test('failed attempts retain the registered first error rather than disappearing from the matrix', t => {
  const f = fixture(t), d = f.addDataset(), ref = f.save(), plan = f.plan(d, ref);
  const source = f.read().sources.find(s => s.sourceId === d.sourceId)!;
  fs.writeFileSync(path.join(f.root, '.dsh', 'research', 'materials', 'raw', source.sha256), 'tampered');
  const run = f.run(plan); assert.equal(run.status, 'failed');
  const row = f.metrics.projection(f.researchId)!.rows[0];
  assert.equal(row.status, 'failed'); assert.equal(row.check, 'unavailable'); assert.equal(row.cells[0].value, null);
  assert.ok(row.blockers.includes(run.firstError!.message)); assert.equal(f.read().calculations[0].firstError!.message, run.firstError!.message);
});

