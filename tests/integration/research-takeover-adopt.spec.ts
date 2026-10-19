/**
 * Batch 2: bind a takeover snapshot into Wiki / research graph with exact citations.
 * Plan: docs/mvp/MVP-TAKEOVER-BATCH-02-WORKER-PLAN-2026-10-16.md
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ResearchBootstrapStore } from '../../packages/evolver/src/application/research-bootstrap-store.ts';
import { TakeoverService, type TakeoverSnapshotDraft } from '../../packages/evolver/src/application/takeover-service.ts';
import { TakeoverAdoptionService, type TakeoverAdoptionRequestItem } from '../../packages/evolver/src/application/takeover-adoption.ts';
import { GeneralResearchService } from '../../packages/evolver/src/application/general-research-service.ts';
import { GeneralKnowledgeService } from '../../packages/evolver/src/application/general-knowledge-service.ts';
import { GeneralWorkflowService } from '../../packages/evolver/src/application/general-workflow-service.ts';
import { GeneralEvidenceReader, GeneralEvidenceService } from '../../packages/evolver/src/application/general-evidence-service.ts';
import { BootstrapError } from '../../packages/evolver/src/contracts/research-bootstrap.ts';

const PDF_PAGE = 'Baseline is ResNet-18. The gate sits at the encoder end.';
const README = '基线为 ResNet-18，门控模块插在编码器末端。\n';
const FAILED_LOG = 'FAILED CUDA out of memory before epoch 2\n';

function workspaceFor(t: { after: (fn: () => void) => void }): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

function writeProject(workspace: string): void {
  const files: Record<string, string> = {
    'project/README.md': README,
    'project/logs/failed.log': FAILED_LOG,
    'project/paper/note.pdf': '%PDF-1.4\n',
    'project/weights/model.pt': 'PT-WEIGHTS-FAKE',
    'project/metrics/results.csv': 'epoch,miou\n1,0.41\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(workspace, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function digest(workspace: string, relative: string): string {
  return createHash('sha256').update(fs.readFileSync(path.join(workspace, ...relative.split('/')))).digest('hex');
}

async function startedTakeover(workspace: string) {
  const store = new ResearchBootstrapStore(workspace);
  const service = new TakeoverService(store, { readPdfText: async () => [PDF_PAGE] });
  const started = await service.start({ operationId: 'op-start', baseRevision: store.readStateOrEmpty().revision, roots: ['project'], title: '接管草稿' }, 'tester');
  const record = service.read(started.result.takeoverId)!;
  const entry = (suffix: string) => record.scans[0].entries.find((item) => item.relativePath.endsWith(suffix))!;
  const readme = entry('README.md');
  const log = entry('failed.log');
  const pdf = entry('note.pdf');
  const draft: TakeoverSnapshotDraft = {
    title: '接管草稿',
    currentFocus: '待确定',
    materials: [],
    groups: [],
    known: ['README 写了基线。'],
    unknown: [{ unknownId: 'unknown-focus', topic: '研究问题未确定', detail: '没有足够证据写出研究问题。', entryIds: [] }],
    relations: [],
    nextSteps: ['先核对失败日志，不重新训练。'],
    citations: [
      { citationId: 'cit-readme', entryId: readme.entryId, quote: '基线为 ResNet-18，门控模块插在编码器末端。', note: '' },
      { citationId: 'cit-log', entryId: log.entryId, quote: 'FAILED CUDA out of memory before epoch 2', note: '' },
      { citationId: 'cit-pdf', entryId: pdf.entryId, quote: PDF_PAGE, note: '' },
    ],
    watchedEntries: [],
    model: null,
  };
  service.saveSnapshot({ operationId: 'op-snapshot', baseRevision: store.readStateOrEmpty().revision, takeoverId: record.takeoverId, snapshot: draft }, 'tester');
  return { store, service, takeoverId: record.takeoverId, readme, log, pdf, weight: entry('model.pt'), csv: entry('results.csv') };
}

test('takeover material nature correction creates a source version and preserves history', async t => {
  const workspace = workspaceFor(t);
  writeProject(workspace);
  const f = await startedTakeover(workspace);
  const service = new TakeoverAdoptionService(f.store, { readPdfText: async () => [PDF_PAGE] });
  const item = { key: 'readme', entryId: f.readme.entryId, title: '来源说明', content: '仅记录材料，不构成实验观察。', quote: README.trim(), nature: 'source_reported' as const, role: 'wiki' as const };
  const first = await service.adopt({ operationId: 'nature-initial', baseRevision: f.store.readStateOrEmpty().revision, takeoverId: f.takeoverId, items: [item] }, 'tester');
  const read = () => f.store.readStateOrEmpty().researches.find(r => r.researchId === first.researchId)!.general!;
  const oldSource = read().sources[0];
  const nodes = read().graph.nodes.length;
  const corrected = await service.adopt({ operationId: 'nature-corrected', baseRevision: f.store.readStateOrEmpty().revision, takeoverId: f.takeoverId, researchId: first.researchId!, items: [{ ...item, materialNature: 'simulation' }] }, 'tester');
  assert.equal(corrected.status, 'saved');
  const current = read();
  const source = current.sources.find(s => s.nature === 'simulation');
  assert.ok(source, 'explicit simulation must survive material registration');
  assert.equal(source.previousSourceId, oldSource.sourceId);
  assert.equal(source.sha256, oldSource.sha256);
  assert.equal(current.sources.find(s => s.sourceId === oldSource.sourceId)!.nature, 'user_observation');
  const versions = current.knowledge.filter(k => k.title === item.title);
  assert.equal(versions.length, 2);
  assert.equal(versions.find(k => k.version === 2)!.sourceRefs[0], source.sourceId);
  assert.equal(current.graph.nodes.length, nodes);
  const beforeRejected = f.store.readStateOrEmpty().revision;
  await assert.rejects(service.adopt({ operationId: 'nature-invalid', baseRevision: beforeRejected, takeoverId: f.takeoverId, researchId: first.researchId!, items: [{ ...item, materialNature: 'system_calculation' as never }] }, 'tester'), /materialNature/);
  assert.equal(f.store.readStateOrEmpty().revision, beforeRejected);
});

test('B2: adoption cites original bytes, keeps old knowledge, and does not execute', async (t) => {
  const workspace = workspaceFor(t);
  writeProject(workspace);
  const before = ['project/README.md', 'project/logs/failed.log', 'project/paper/note.pdf', 'project/weights/model.pt', 'project/metrics/results.csv'].map((relative) => digest(workspace, relative));
  const boot = new ResearchBootstrapStore(workspace);
  const created = new GeneralResearchService(boot).create({
    operationId: 'op-research', baseRevision: 0, title: '已有研究', question: '用户原来的问题', domains: ['已有'], methods: ['review'], entryMode: 'existing_data',
  });
  const researchId = created.result.researchId;
  new GeneralKnowledgeService(boot).save({
    operationId: 'op-user-knowledge', baseRevision: boot.readStateOrEmpty().revision, researchId,
    entry: { kind: 'wiki', title: '用户保留的笔记', category: 'note', content: '这是用户原有内容。', nature: 'unknown', sourceRefs: [], calculationIds: [], nodeIds: [], input: '', output: '', conditions: [], parameters: [], operation: 'manual', archived: false },
  });
  const userNode = new GeneralWorkflowService(boot).saveNode({
    operationId: 'op-user-node', baseRevision: boot.readStateOrEmpty().revision, researchId,
    node: { title: '用户节点', kind: 'manual', goal: '保留', inputs: [], method: '用户手工节点', output: '未执行', completionCriterion: '人工', join: 'all' },
  });
  const beforeEdges = new Set(boot.readStateOrEmpty().researches[0].general!.graph.edges.map((edge) => edge.edgeId));
  const { store, takeoverId, readme, log, pdf, weight, csv } = await startedTakeover(workspace);
  const adopt = new TakeoverAdoptionService(store, { readPdfText: async () => [PDF_PAGE] });
  const items: TakeoverAdoptionRequestItem[] = [
    { key: 'readme', entryId: readme.entryId, title: 'README 基线', content: '材料写明基线为 ResNet-18。', quote: '基线为 ResNet-18，门控模块插在编码器末端。', nature: 'source_reported', role: 'wiki' },
    { key: 'failed', entryId: log.entryId, title: '外部失败日志', content: '日志报告 CUDA 内存不足，这不是本系统的执行结果。', quote: 'FAILED CUDA out of memory before epoch 2', nature: 'source_reported', role: 'material' },
    { key: 'paper', entryId: pdf.entryId, title: '论文摘录', content: '论文页写了 ResNet-18。', quote: PDF_PAGE, nature: 'source_reported', role: 'wiki' },
    { key: 'weights', entryId: weight.entryId, title: '权重文件', content: '只看到文件名。', quote: '', nature: 'unknown', role: 'metadata' },
    { key: 'metrics', entryId: csv.entryId, title: '指标文件身份', content: '只登记指标文件，不解释数值。', quote: 'epoch,miou', nature: 'source_reported', role: 'material' },
  ];
  const first = await adopt.adopt({
    operationId: 'op-adopt', baseRevision: store.readStateOrEmpty().revision, takeoverId, researchId, items,
    relations: [
      { key: 'same-dir', fromKey: 'readme', toKey: 'failed', basis: 'same_directory', confidence: 'unverified', note: '只是同目录' },
      { key: 'config-ref', fromKey: 'readme', toKey: 'metrics', basis: 'config_reference', confidence: 'evidenced', note: 'README 点名了指标文件' },
    ],
  }, 'tester');
  assert.deepEqual(['project/README.md', 'project/logs/failed.log', 'project/paper/note.pdf', 'project/weights/model.pt', 'project/metrics/results.csv'].map((relative) => digest(workspace, relative)), before);
  assert.equal(first.status, 'saved');
  assert.equal(first.createdResearch, false);
  assert.equal(first.researchId, researchId);

  const general = store.readStateOrEmpty().researches.find((research) => research.researchId === researchId)!.general!;
  const user = general.knowledge.find((entry) => entry.title === '用户保留的笔记')!;
  assert.equal(user.content, '这是用户原有内容。');
  assert.equal(user.version, 1);
  assert.ok(general.graph.nodes.some((node) => node.nodeId === userNode.result.nodeId && node.title === '用户节点'));
  assert.ok(general.graph.nodes.every((node) => node.execution === 'not_started'));
  assert.equal(general.calculations.length, 0);
  assert.equal(general.metricReports.length, 0);
  const addedEdges = general.graph.edges.filter((edge) => !beforeEdges.has(edge.edgeId));
  assert.ok(addedEdges.every((edge) => edge.kind === 'derived_from'));
  assert.equal(addedEdges.length, 1);
  assert.ok(general.knowledgeRelations.some((relation) => relation.note.includes('待核实') && relation.note.includes('same_directory')));
  const failed = general.graph.nodes.find((node) => node.method.includes('takeover-node:failed'))!;
  assert.equal(failed.execution, 'not_started');
  assert.match(failed.output, /不是本系统已执行任务/);
  assert.equal(general.sources.some((source) => source.filename === 'model.pt'), false);
  const weightItem = first.items.find((item) => item.key === 'weights')!;
  assert.equal(weightItem.mode, 'metadata_only');
  assert.equal(weightItem.sourceId, null);
  assert.equal(general.teamTaskDrafts.length, 1);
  assert.equal(general.teamTaskDrafts[0].status, 'draft');

  const readmeKnowledge = general.knowledge.find((entry) => entry.okfMetadata?.takeoverKey === 'readme')!;
  const reader = new GeneralEvidenceReader(store, researchId, store.readStateOrEmpty());
  const checked = reader.check(readmeKnowledge);
  assert.equal(checked.status, 'current');
  assert.equal(checked.inputNatures.includes('user_observation') || checked.inputNatures.includes('literature') || checked.inputNatures.length > 0, true);
  const pack = reader.retrieve('ResNet', [readmeKnowledge.sourceRefs[0]]);
  assert.ok(pack.hits.some((hit) => hit.knowledgeRef?.entryId === readmeKnowledge.entryId));
  const pdfKnowledge = general.knowledge.find((entry) => entry.okfMetadata?.takeoverKey === 'paper')!;
  const pdfCheck = reader.check(pdfKnowledge);
  assert.equal(pdfCheck.status, 'current');
  const pdfLocator = pdfKnowledge.claims?.[0].locators[0];
  assert.equal(pdfLocator?.kind, 'pdf');
  if (pdfLocator?.kind === 'pdf') assert.equal(pdfLocator.page, 1);

  const again = await adopt.adopt({
    operationId: 'op-adopt-again', baseRevision: store.readStateOrEmpty().revision, takeoverId, researchId, items,
    relations: [
      { key: 'same-dir', fromKey: 'readme', toKey: 'failed', basis: 'same_directory', confidence: 'unverified', note: '只是同目录' },
      { key: 'config-ref', fromKey: 'readme', toKey: 'metrics', basis: 'config_reference', confidence: 'evidenced', note: 'README 点名了指标文件' },
    ],
  }, 'tester');
  assert.equal(again.reused, true);
  assert.equal(store.readStateOrEmpty().researches.find((research) => research.researchId === researchId)!.general!.knowledge.filter((entry) => entry.okfMetadata?.takeoverKey === 'readme').length, 1);

  const conflict = await adopt.adopt({
    operationId: 'op-conflict', baseRevision: store.readStateOrEmpty().revision, takeoverId, researchId,
    items: [{ key: 'user-copy', entryId: readme.entryId, title: '用户保留的笔记', content: '试图覆盖用户笔记。', quote: '基线为 ResNet-18，门控模块插在编码器末端。', nature: 'source_reported', role: 'wiki' }],
  }, 'tester');
  assert.equal(conflict.items[0].status, 'conflict');
  assert.equal(store.readStateOrEmpty().researches.find((research) => research.researchId === researchId)!.general!.knowledge.find((entry) => entry.title === '用户保留的笔记')!.content, '这是用户原有内容。');

  const forged = await adopt.adopt({
    operationId: 'op-forged', baseRevision: store.readStateOrEmpty().revision, takeoverId, researchId,
    items: [{ key: 'forged', entryId: readme.entryId, title: '伪造引用', content: '并不存在的指标。', quote: '准确率达到 99.9%', nature: 'source_reported', role: 'wiki' }],
  }, 'tester');
  assert.equal(forged.items[0].status, 'skipped');
  assert.equal(forged.items[0].knowledgeId, null);

  new GeneralEvidenceService(store).setAccess({ operationId: 'op-revoke', baseRevision: store.readStateOrEmpty().revision, researchId, sourceId: readmeKnowledge.sourceRefs[0], allowed: false, reason: '撤权验收' }, 'tester');
  const revoked = new GeneralEvidenceReader(store, researchId, store.readStateOrEmpty()).check(readmeKnowledge);
  assert.equal(revoked.status, 'revoked');
  const afterRevoke = await adopt.adopt({
    operationId: 'op-after-revoke', baseRevision: store.readStateOrEmpty().revision, takeoverId, researchId,
    items: [{ key: 'readme', entryId: readme.entryId, title: 'README 基线', content: '撤权后改写一版。', quote: '基线为 ResNet-18，门控模块插在编码器末端。', nature: 'source_reported', role: 'wiki' }],
  }, 'tester');
  assert.notEqual(afterRevoke.status, 'saved');
  assert.equal(store.readStateOrEmpty().researches.find((research) => research.researchId === researchId)!.general!.knowledge.filter((entry) => entry.entryId === readmeKnowledge.entryId).length, 1);

  fs.appendFileSync(path.join(workspace, 'project/README.md'), '\n补充一句。\n');
  const stale = await adopt.adopt({
    operationId: 'op-stale', baseRevision: store.readStateOrEmpty().revision, takeoverId, researchId, items,
  }, 'tester');
  assert.equal(stale.status, 'blocked');
  assert.equal(stale.firstError?.code, 'STALE');

  const reopened = new TakeoverService(new ResearchBootstrapStore(workspace)).read(takeoverId)!;
  assert.ok(reopened.adoptions.some((adoption) => adoption.adoptionId === first.adoptionId && adoption.researchId === researchId));
  assert.notEqual(digest(workspace, 'project/README.md'), before[0]);
  assert.deepEqual(['project/logs/failed.log', 'project/paper/note.pdf', 'project/weights/model.pt', 'project/metrics/results.csv'].map((relative) => digest(workspace, relative)), before.slice(1));
});

test('B2: a missing research becomes a 待确定 draft instead of an invented question', async (t) => {
  const workspace = workspaceFor(t);
  writeProject(workspace);
  const { store, takeoverId, readme } = await startedTakeover(workspace);
  const adopted = await new TakeoverAdoptionService(store, { readPdfText: async () => [PDF_PAGE] }).adopt({
    operationId: 'op-draft', baseRevision: store.readStateOrEmpty().revision, takeoverId,
    items: [{ key: 'readme', entryId: readme.entryId, title: 'README 基线', content: '只记录读到的基线。', quote: '基线为 ResNet-18，门控模块插在编码器末端。', nature: 'source_reported', role: 'wiki' }],
  }, 'tester');
  assert.equal(adopted.createdResearch, true);
  assert.equal(adopted.status, 'saved');
  const research = store.readStateOrEmpty().researches.find((entry) => entry.researchId === adopted.researchId)!;
  assert.equal(research.contract.researchQuestion, '待确定');
  assert.equal(research.general!.ideas[0].question, '待确定');
  assert.equal(new TakeoverService(store).read(takeoverId)!.researchId, adopted.researchId);
});

test('B2: a bad base revision does not publish when the takeover is still fresh', async (t) => {
  const workspace = workspaceFor(t);
  writeProject(workspace);
  const { store, takeoverId, readme } = await startedTakeover(workspace);
  await assert.rejects(() => new TakeoverAdoptionService(store).adopt({
    operationId: 'op-cas-only', baseRevision: 0, takeoverId,
    items: [{ key: 'readme', entryId: readme.entryId, title: 'README 基线', content: '不应写入。', quote: '基线为 ResNet-18，门控模块插在编码器末端。', nature: 'source_reported', role: 'wiki' }],
  }, 'tester'), (error: unknown) => error instanceof BootstrapError && error.code === 'REVISION_CONFLICT');
  assert.equal(store.readStateOrEmpty().researches.length, 0);
  assert.equal(new TakeoverService(store).read(takeoverId)!.adoptions.length, 0);
});

test('B2: unread and out-of-range citations stay unpublished', async (t) => {
  const workspace = workspaceFor(t);
  writeProject(workspace);
  const { store, takeoverId, weight } = await startedTakeover(workspace);
  const adopted = await new TakeoverAdoptionService(store, { readPdfText: async () => [PDF_PAGE] }).adopt({
    operationId: 'op-weight-as-wiki', baseRevision: store.readStateOrEmpty().revision, takeoverId,
    items: [{ key: 'weights', entryId: weight.entryId, title: '假装读过权重', content: '模型结构是 ResNet。', quote: 'PT-WEIGHTS-FAKE', nature: 'source_reported', role: 'wiki' }],
  }, 'tester');
  assert.equal(adopted.items[0].status, 'metadata');
  assert.equal(adopted.items[0].knowledgeId, null);
  assert.equal(store.readStateOrEmpty().researches[0].general!.sources.some((source) => source.filename === 'model.pt'), false);
  const missing = await new TakeoverAdoptionService(store).adopt({
    operationId: 'op-missing-entry', baseRevision: store.readStateOrEmpty().revision, takeoverId,
    items: [{ key: 'missing', entryId: 'entry-not-in-scan', title: '不存在', content: '无', quote: '无', nature: 'unknown', role: 'wiki' }],
  }, 'tester');
  assert.equal(missing.status, 'blocked');
  assert.match(missing.firstError?.message ?? '', /不在当前扫描中/);
});
