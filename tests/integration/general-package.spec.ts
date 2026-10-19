import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { GeneralPackageService, validateGeneralPortablePackage } from '../../packages/evolver/src/application/general-package-service.ts';
import { GeneralResearchService } from '../../packages/evolver/src/application/general-research-service.ts';
import { GeneralDataService } from '../../packages/evolver/src/application/general-data-service.ts';
import { GeneralEvidenceService } from '../../packages/evolver/src/application/general-evidence-service.ts';
import { ResearchBootstrapStore } from '../../packages/evolver/src/application/research-bootstrap-store.ts';
import { ResearchCycleStore } from '../../packages/evolver/src/application/research-cycle-store.ts';
import { ResearchCycleService } from '../../packages/evolver/src/application/research-cycle-service.ts';
import { GeneralMaterialStore } from '../../packages/evolver/src/application/general-material-store.ts';
import { GeneralAnalysisService } from '../../packages/evolver/src/application/general-analysis-service.ts';
import { GeneralReportService } from '../../packages/evolver/src/application/general-report-service.ts';
import { confirmGeneralPrerequisites } from '../helpers/general-prerequisites.ts';
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-package-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ResearchBootstrapStore(root), service = new GeneralPackageService(store);
  const id = new GeneralResearchService(store).create({ operationId: 'create', baseRevision: 0, title: '原研究', question: '研究问题', domains: [], methods: ['engineering'], entryMode: 'existing_data' }).result.researchId;
  const sourceId = new GeneralDataService(store).importMaterial({ operationId: 'source', baseRevision: 1, researchId: id, filename: 'data.csv', mediaType: 'text/csv', contentBase64: Buffer.from('x,y\n1,2\n3,4').toString('base64'), nature: 'user_observation', description: '实测资料', purpose: '分析' }).result.sourceId;
  return { root, store, service, id, sourceId };
}
test('portable package embeds raw/parsed and imports new IDs with no execution or old authorization', t => {
  const f = fixture(t), p = f.service.export(f.id), original = f.store.readStateOrEmpty().researches[0];
  assert.equal(p.materials.length, 1); assert.equal(validateGeneralPortablePackage(JSON.parse(JSON.stringify(p))).general.sources.length, 1);
  const input = { operationId: 'import', baseRevision: f.store.readStateOrEmpty().revision, title: '导入研究', package: p };
  const imported = f.service.import(input, 'trusted-user'); assert.equal(f.service.import(input, 'trusted-user').replayed, true);
  assert.notEqual(imported.result.researchId, f.id);
  const state = new ResearchBootstrapStore(f.root).readStateOrEmpty(), r = state.researches.find(r => r.researchId === imported.result.researchId)!, g = r.general!;
  assert.deepEqual(state.researches[0], original); assert.notEqual(g.sources[0].sourceId, f.sourceId);
  assert.equal(g.sourceAccess[0].allowed, false); assert.equal(g.requireHumanConfirmation, true);
  assert.deepEqual(g.limits, { maxAttempts: 1, maxRounds: 1, deadline: null }); assert.equal(g.graph.revision, 1);
  assert.deepEqual(g.calculations, []); assert.deepEqual(g.reviews, []); assert.deepEqual(g.nodeConfirmations, []);
  assert.equal(g.importedHistory[0].status, 'needs_review'); assert.equal(g.importedHistory[0].actor.identity, 'trusted-user');
  const cycle = new ResearchCycleStore(f.root, r.researchId); assert.equal(cycle.readState(), null);
  assert.deepEqual(cycle.readArtifactJson(g.importedHistory[0].packageRef), p);
  assert.equal(new GeneralMaterialStore(f.root).readRaw(g.sources[0]).toString(), 'x,y\n1,2\n3,4');
  assert.throws(() => f.service.export(r.researchId), /revoked/);
  new GeneralEvidenceService(f.store).setAccess({ operationId: 'local-allow', baseRevision: state.revision, researchId: r.researchId, sourceId: g.sources[0].sourceId, allowed: true, reason: '本地核对材料后授权' }, 'trusted-user');
  assert.equal(f.service.export(r.researchId).artifacts.length, 1);
});
test('running native jobs are archived with input artifacts, never installed or resumed on import', t => {
  const f = fixture(t), g = f.store.readStateOrEmpty().researches[0].general!;
  new ResearchCycleService({ workspaceRoot: f.root, bootstrapStore: f.store, resolver: { getPaper: () => null } }).startCycle({ kind: 'user', identity: 'user', actionId: 'start' }, { commandId: 'start', researchId: f.id, selectedIdeaId: g.ideas[0].ideaId, nodeId: g.graph.nodes[0].nodeId, sourceIds: [f.sourceId], authorize: true, expectedBootstrapRevision: f.store.readStateOrEmpty().revision, expectedCycleRevision: 0 });
  const p = f.service.export(f.id); assert.equal(p.cycleState.runs.length, 1); assert.ok(p.artifacts.length >= 3);
  const added = f.service.import({ operationId: 'import-run', baseRevision: f.store.readStateOrEmpty().revision, title: '旧任务重审', package: p }, 'user');
  const cycles = new ResearchCycleStore(f.root, added.result.researchId); assert.equal(cycles.readState(), null);
});
test('manifest/schema/base64 tampering and dangling closure reject before creating a research', t => {
  const f = fixture(t), p = f.service.export(f.id), before = f.store.readStateOrEmpty();
  const changes = [
    (p: typeof p) => { p.schemaVersion = 2 as 1; },
    (p: typeof p) => { p.materials[0].raw.contentBase64 += '\n'; },
    (p: typeof p) => { p.materials[0].raw.bytes++; },
    (p: typeof p) => { p.materials[0].parsed.sha256 = '0'.repeat(64); },
    (p: typeof p) => { p.materials = []; },
    (p: typeof p) => { p.materials.push(p.materials[0]); },
    (p: typeof p) => { p.cycleState.researchId = 'foreign'; },
    (p: typeof p) => { p.general.graph.edges[0].from = 'missing'; },
  ];
  for (const change of changes) { const changed = structuredClone(p); change(changed); assert.throws(() => f.service.import({ operationId: 'bad', baseRevision: before.revision, title: '无效包', package: changed }, 'user')); assert.deepEqual(f.store.readStateOrEmpty(), before); }
  const utf8 = structuredClone(p), bytes = Buffer.from([0xff]); utf8.materials[0].parsed = { bytes: 1, sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') }; utf8.general.sources[0].parsedSha256 = utf8.materials[0].parsed.sha256;
  assert.throws(() => validateGeneralPortablePackage(utf8), /encoded|encoding/);
});

test('actual calculation and frozen report artifacts survive in imported history without becoming local success', t => {
  const f = fixture(t), data = new GeneralDataService(f.store), analysis = new GeneralAnalysisService(f.store);
  const preview = data.preview({ researchId: f.id, sourceId: f.sourceId }), fields = structuredClone(preview.dataset!.fields);
  fields[1].type = 'number'; fields[1].role = 'outcome'; fields[1].unit = 'MPa';
  data.saveDictionary({ operationId: 'dictionary', baseRevision: f.store.readStateOrEmpty().revision, researchId: f.id, datasetId: preview.dataset!.datasetId, fields, conditions: [], excludedRows: [], processingReason: '确认单位' });
  confirmGeneralPrerequisites(f.store, f.id);
  const g = f.store.readStateOrEmpty().researches[0].general!;
  const plan = analysis.savePlan({ operationId: 'plan', baseRevision: f.store.readStateOrEmpty().revision, researchId: f.id, nodeId: g.graph.nodes.find(n => n.kind === 'analysis')!.nodeId, title: '强度汇总', goal: '描述已有材料', datasetId: preview.dataset!.datasetId, datasetVersion: 2, ideaId: g.ideas[0].ideaId, method: 'descriptive', numericColumns: [1], groupBy: [], sampleColumns: [], rowRange: { start: 0, end: 2 }, missingPolicy: 'available_cases', missingGroupPolicy: 'separate', requiredConditions: [], comparisonScope: '本表', limitations: ['不作因果判断'] });
  const calculation = analysis.calculate({ operationId: 'calculate', baseRevision: f.store.readStateOrEmpty().revision, researchId: f.id, planId: plan.result.planId, planVersion: plan.result.version, authorize: true });
  assert.equal(calculation.result.status, 'completed');
  new GeneralReportService(f.store).create({ operationId: 'report', baseRevision: f.store.readStateOrEmpty().revision, researchId: f.id, title: '冻结报告', selection: { sourceIds: [f.sourceId], calculationIds: [calculation.result.calculationId], reviewIds: [], knowledgeRefs: [] } });
  const p = f.service.export(f.id); assert.equal(p.artifacts.length, 2);
  const missing = structuredClone(p); missing.artifacts.pop(); assert.throws(() => validateGeneralPortablePackage(missing), /Missing/);
  const duplicate = structuredClone(p); duplicate.artifacts.push(duplicate.artifacts[0]); assert.throws(() => validateGeneralPortablePackage(duplicate), /duplicate/);
  const traversed = structuredClone(p); traversed.artifacts[0].ref.id = '../state.json'; assert.throws(() => validateGeneralPortablePackage(traversed), /content-addressed/);
  const forged = structuredClone(p), artifact = forged.artifacts.find(a => a.ref.id === forged.general.calculations[0].artifact!.id)!;
  const content = JSON.parse(Buffer.from(artifact.blob.contentBase64, 'base64').toString()); content.inputSnapshot.sourceHash = '0'.repeat(64);
  const bytes = Buffer.from(JSON.stringify(content)), sha256 = createHash('sha256').update(bytes).digest('hex'), oldRef = artifact.ref;
  artifact.ref = { id: `artifacts/${sha256}.json`, sha256 }; artifact.blob = { sha256, bytes: bytes.length, contentBase64: bytes.toString('base64') };
  forged.general.calculations[0].artifact = artifact.ref;
  // Remove report references so the test isolates calculation input binding.
  forged.general.factPacks = []; forged.artifacts = [artifact];
  assert.notEqual(oldRef.sha256, sha256); assert.throws(() => validateGeneralPortablePackage(forged), /input\/tool binding/);
  const saved = f.service.import({ operationId: 'import-facts', baseRevision: f.store.readStateOrEmpty().revision, title: '历史重审', package: p }, 'user');
  const imported = f.store.readStateOrEmpty().researches.find(r => r.researchId === saved.result.researchId)!.general!;
  assert.equal(imported.calculations.length, 0); assert.equal(imported.factPacks.length, 0);
  assert.throws(() => f.service.readImportedHistory(saved.result.researchId, saved.result.importId), /revoked/);
  const adopt = { operationId: 'adopt-historical', baseRevision: f.store.readStateOrEmpty().revision, researchId: saved.result.researchId, importId: saved.result.importId, originalPlanId: plan.result.planId, originalVersion: plan.result.version, reason: '已核对材料与字典，本工作区重新采用该描述分析规程' };
  assert.throws(() => f.service.adoptImportedPlan(adopt, 'trusted-user'), /revoked/);
  new GeneralEvidenceService(f.store).setAccess({ operationId: 'allow-history', baseRevision: f.store.readStateOrEmpty().revision, researchId: saved.result.researchId, sourceId: imported.sources[0].sourceId, allowed: true, reason: '本地核对' }, 'user');
  const historical = f.service.readImportedHistory(saved.result.researchId, saved.result.importId);
  assert.equal(historical.general.calculations[0].status, 'completed'); assert.equal(historical.general.factPacks.length, 1);
  const adopted = f.service.adoptImportedPlan({ ...adopt, baseRevision: f.store.readStateOrEmpty().revision }, 'trusted-user');
  assert.equal(f.service.adoptImportedPlan(adopt, 'trusted-user').replayed, true);
  assert.equal(adopted.result.status, 'plan_saved_not_executed'); assert.notEqual(adopted.result.planId, plan.result.planId);
  const current = f.store.readStateOrEmpty().researches.find(r => r.researchId === saved.result.researchId)!.general!;
  assert.equal(current.calculations.length, 0); assert.equal(current.nodeConfirmations.length, 0);
  assert.equal(current.plans[0].importedOrigin!.actor.identity, 'trusted-user'); assert.equal(current.plans[0].importedOrigin!.packageRef.sha256, current.importedHistory[0].packageRef.sha256);
  assert.equal(current.plans[0].dataset.sourceId, imported.sources[0].sourceId);
  assert.throws(() => f.service.adoptImportedPlan({ ...adopt, operationId: 'empty-reason', baseRevision: f.store.readStateOrEmpty().revision, reason: ' ' }, 'user'), /reason/);
  assert.throws(() => f.service.adoptImportedPlan({ ...adopt, operationId: 'foreign-plan', baseRevision: f.store.readStateOrEmpty().revision, originalPlanId: 'foreign' }, 'user'), /not found/);
  assert.throws(() => f.service.adoptImportedPlan({ ...adopt, operationId: 'stale-adopt' }, 'user'), /revision/);
  confirmGeneralPrerequisites(f.store, saved.result.researchId);
  const newRun = analysis.calculate({ operationId: 'local-new-calculation', baseRevision: f.store.readStateOrEmpty().revision, researchId: saved.result.researchId, planId: adopted.result.planId, planVersion: 1, authorize: true });
  assert.equal(newRun.result.status, 'completed'); assert.notEqual(newRun.result.calculationId, calculation.result.calculationId);
  assert.equal(analysis.readCalculation(saved.result.researchId, newRun.result.calculationId).content!.summaries[0].statistics.mean, 3);
  assert.equal(f.service.readImportedHistory(saved.result.researchId, saved.result.importId).general.calculations[0].calculationId, calculation.result.calculationId);
});

test('import into an empty workspace is self-contained and stale CAS leaves no new state', t => {
  const f = fixture(t), p = f.service.export(f.id), root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-package-target-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ResearchBootstrapStore(root), packages = new GeneralPackageService(store);
  assert.throws(() => packages.import({ operationId: 'stale', baseRevision: 1, title: '新研究', package: p }, 'user'), /revision/);
  assert.equal(store.readStateOrEmpty().researches.length, 0); assert.equal(fs.existsSync(path.join(root, '.dsh', 'research', 'materials')), false);
  const added = packages.import({ operationId: 'valid', baseRevision: 0, title: '新研究', package: p }, 'user');
  const g = store.readStateOrEmpty().researches[0].general!;
  assert.equal(new GeneralMaterialStore(root).readParsed(g.sources[0]).tables[0].rows.length, 2);
  assert.throws(() => packages.readImportedHistory(added.result.researchId, 'foreign'), /not found/);
});
