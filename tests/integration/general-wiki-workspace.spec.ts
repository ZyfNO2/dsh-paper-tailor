import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { applyGeneralWikiTools } from '../../packages/evolver/src/adapters/dsh/general-wiki-tools.ts';
import type { Context } from '@deepseek-ai/cordis';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { GeneralWikiService } from '../../packages/evolver/src/application/general-wiki-service.ts';
import { GeneralKnowledgeService } from '../../packages/evolver/src/application/general-knowledge-service.ts';
import { ResearchBootstrapStore } from '../../packages/evolver/src/application/research-bootstrap-store.ts';
import { GeneralResearchService } from '../../packages/evolver/src/application/general-research-service.ts';
import { GeneralDataService } from '../../packages/evolver/src/application/general-data-service.ts';
import { GeneralEvidenceService } from '../../packages/evolver/src/application/general-evidence-service.ts';
import type { GeneralKnowledgeEntry } from '../../packages/evolver/src/contracts/general-knowledge.ts';
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wiki-workspace-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ResearchBootstrapStore(root), researchId = new GeneralResearchService(store).create({ operationId: 'create', baseRevision: 0, title: '知识验证', question: '不同条件下的材料观测', domains: [], methods: ['observation'], entryMode: 'existing_data' }).result.researchId;
  let counter = 0; const write = () => ({ researchId, operationId: `write-${counter++}`, baseRevision: store.readStateOrEmpty().revision });
  const data = new GeneralDataService(store), knowledge = new GeneralKnowledgeService(store), wiki = new GeneralWikiService(store);
  const text = '温度为20°C时，样本读数为5。不同条件不得直接比较。';
  const sourceId = data.importMaterial({ ...write(), filename: 'observation.txt', mediaType: 'text/plain', contentBase64: Buffer.from(text).toString('base64'), nature: 'simulation', description: '测试用模拟记录', purpose: '验证引用' }).result.sourceId;
  const entry: Omit<GeneralKnowledgeEntry, 'entryId' | 'version' | 'createdAt'> = { kind: 'wiki', title: '温度条件', category: '条件', content: '# 温度条件\n温度为20°C。', nature: 'source_reported', sourceRefs: [sourceId], calculationIds: [], nodeIds: [], input: '', output: '', conditions: ['同温度'], counterEvidence: ['异温度可能不同'], limitations: ['模拟资料，不代表真实实验'], parameters: [], operation: 'manual', archived: false };
  const entryId = knowledge.save({ ...write(), entry }).result.entryId;
  return { root, store, write, data, knowledge, wiki, sourceId, entryId, entry, text };
}
test('whiteboards persist card references across restarts; removing a card never deletes shared knowledge', t => {
  const f = fixture(t), board = { boardId: 'board-a', title: '条件比较', cards: [{ instanceId: 'card-1', entryId: f.entryId, x: 30, y: 40, width: 300, height: 330, group: '条件' }], links: [], view: { x: 0, y: 0, scale: 1 } };
  f.wiki.saveBoard({ ...f.write(), board }); f.wiki.saveBoard({ ...f.write(), board: { ...board, boardId: 'board-b' } });
  f.wiki.saveBoard({ ...f.write(), board: { ...board, cards: [] } });
  const g = new ResearchBootstrapStore(f.root).readStateOrEmpty().researches[0].general!;
  assert.equal(g.knowledge.length, 1); assert.equal(g.wiki!.boards[0].cards.length, 0); assert.equal(g.wiki!.boards[1].cards[0].entryId, f.entryId);
  const before = f.store.readStateOrEmpty().revision;
  assert.throws(() => f.wiki.saveBoard({ ...f.write(), board: { ...board, cards: [{ ...board.cards[0], entryId: 'foreign' }] } }), /不存在/);
  assert.equal(f.store.readStateOrEmpty().revision, before);
});
test('image bytes and references survive OKF export/import; old permissions and verification do not', t => {
  const f = fixture(t), image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XxioAAAAASUVORK5CYII=', 'base64');
  const imageId = f.data.importMaterial({ ...f.write(), filename: 'sample.png', mediaType: 'image/png', contentBase64: image.toString('base64'), nature: 'simulation', description: '模拟图片', purpose: '图文卡片' }).result.sourceId;
  f.knowledge.save({ ...f.write(), entryId: f.entryId, entry: { ...f.entry, images: [{ sourceId: imageId, caption: '观测示意' }] } });
  f.wiki.saveBoard({ ...f.write(), board: { boardId: 'board', title: '白板', cards: [{ instanceId: 'card', entryId: f.entryId, x: 60, y: 80, width: 320, height: 380, group: '资料' }], links: [], view: { x: 10, y: 20, scale: 1 } } });
  const archive = f.wiki.exportOkf(f.write().researchId), files = unzipSync(Buffer.from(archive.contentBase64, 'base64'));
  assert.ok(new TextDecoder().decode(files['index.md']).includes('okf_version: "0.2"'));
  assert.deepEqual(Buffer.from(files[`assets/${imageId}`]), image);
  f.wiki.importOkf({ ...f.write(), contentBase64: archive.contentBase64 });
  const g = f.store.readStateOrEmpty().researches[0].general!, imported = g.knowledge.find(e => e.entryId !== f.entryId)!;
  assert.equal(imported.content, f.entry.content); assert.equal(imported.images![0].caption, '观测示意'); assert.notEqual(imported.images![0].sourceId, imageId);
  assert.deepEqual(imported.counterEvidence, ['异温度可能不同']); assert.equal(imported.nature, 'unknown'); assert.equal(g.wiki!.boards.length, 2);
  assert.throws(() => f.wiki.source(f.write().researchId, imported.images![0].sourceId), /revoked/);
});
test('Wiki tasks pin inputs, require located claims, reject stale knowledge and record explicit model failure', t => {
  const f = fixture(t), researchId = f.write().researchId;
  const task = f.wiki.prepare({ ...f.write(), taskKind: 'ingest', sourceIds: [f.sourceId], goal: '温度条件' });
  const context = f.wiki.taskContext(researchId, task.result.taskId); assert.equal(context.sourceTexts[0].text, f.text);
  assert.throws(() => f.wiki.publish({ ...f.write(), taskId: task.result.taskId, result: '完成', entries: [] }), /没有有效产物/);
  const source = f.store.readStateOrEmpty().researches[0].general!.sources[0];
  const draft = { ...f.entry, entryId: f.entryId, claims: [{ claimId: 'claim', text: '温度条件', nature: 'source_reported' as const, limitation: '模拟记录，条件受限', locators: [{ kind: 'text' as const, sourceId: source.sourceId, sourceSha256: source.sha256, startByte: 0, endByte: Buffer.byteLength(f.text), quote: f.text }] }] };
  f.wiki.publish({ ...f.write(), taskId: task.result.taskId, result: '已整理，反证并列保留。', entries: [draft] });
  assert.equal(f.store.readStateOrEmpty().researches[0].general!.knowledge.length, 2);
  const next = f.wiki.prepare({ ...f.write(), taskKind: 'query', sourceIds: [f.sourceId], goal: '哪些未知？' });
  f.knowledge.save({ ...f.write(), entryId: f.entryId, entry: { ...f.entry, content: '用户补充了新条件' } });
  assert.throws(() => f.wiki.publish({ ...f.write(), taskId: next.result.taskId, result: '答案', entries: [] }), /发生变化/);
  f.wiki.publish({ ...f.write(), taskId: next.result.taskId, result: '', entries: [], error: '模型超时首错' });
  assert.equal(f.store.readStateOrEmpty().researches[0].general!.wiki!.tasks.at(-1)!.error, '模型超时首错');
});
test('ordinary OKF accepts unknown types and retains broken links; malicious paths are refused', t => {
  const f = fixture(t), contentBase64 = Buffer.from(zipSync({ 'index.md': strToU8('---\nokf_version: "0.2"\n---\n# Index'), 'topic.md': strToU8('---\ntype: Unknown Future Type\ntitle: 新类型\n---\n保留 [未完成](missing.md)') })).toString('base64');
  f.wiki.importOkf({ ...f.write(), contentBase64 }); assert.ok(f.store.readStateOrEmpty().researches[0].general!.knowledge.some(e => e.content.includes('missing.md')));
  const bad = Buffer.from(zipSync({ '../outside.md': strToU8('---\ntype: x\n---\nx') })).toString('base64'); assert.throws(() => f.wiki.importOkf({ ...f.write(), contentBase64: bad }), /路径非法/);
});

test('ordinary OKF resolves relative pages and images, including a workspace without previous materials', t => {
  const f = fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XxioAAAAASUVORK5CYII=', 'base64');
  const contentBase64 = Buffer.from(zipSync({ 'pages/a.md': strToU8('---\ntype: concept\ntitle: A\n---\n[下一页](b.md) ![图示](../images/p.png)'), 'pages/b.md': strToU8('---\ntype: concept\ntitle: B\n---\nB'), 'images/p.png': png })).toString('base64');
  const r = f.wiki.importOkf({ ...f.write(), contentBase64 });
  const g = f.store.readStateOrEmpty().researches[0].general!, a = g.knowledge.find(e => e.entryId === r.result.entryIds[0])!, b = g.knowledge.find(e => e.entryId === r.result.entryIds[1])!;
  assert.ok(a.content.includes('wiki:' + b.entryId)); assert.equal(a.images!.length, 1); assert.equal(a.images![0].caption, '图示');
  assert.throws(() => f.wiki.source(f.write().researchId, a.images![0].sourceId), /revoked/);
});

test('query publishing requires exact assigned citations and rejects fabricated quotes', t => {
  const f = fixture(t), task = f.wiki.prepare({ ...f.write(), taskKind: 'query', sourceIds: [f.sourceId], goal: '温度是多少？' }).result.taskId;
  assert.throws(() => f.wiki.publish({ ...f.write(), taskId: task, result: '20°C', entries: [] }), /引用定位/);
  const source = f.store.readStateOrEmpty().researches[0].general!.sources[0];
  const locator = { kind: 'text' as const, sourceId: f.sourceId, sourceSha256: source.sha256, startByte: 0, endByte: Buffer.byteLength(f.text), quote: f.text };
  assert.throws(() => f.wiki.publish({ ...f.write(), taskId: task, result: '20°C', entries: [], citations: [{ ...locator, quote: '编造的引文' }] }));
  f.wiki.publish({ ...f.write(), taskId: task, result: '模拟记录中的温度是20°C，不能推广到其他条件。', entries: [], citations: [locator] });
  const saved = new ResearchBootstrapStore(f.root).readStateOrEmpty().researches[0].general!.wiki!.tasks.at(-1)!;
  assert.equal(saved.status, 'completed'); assert.deepEqual(saved.citations, [locator]);
});

test('image and precise-claim dependencies enforce revocation and task scope even outside sourceRefs', t => {
  const f = fixture(t), bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XxioAAAAASUVORK5CYII=', 'base64');
  const imageId = f.data.importMaterial({ ...f.write(), filename: 'image.png', mediaType: 'image/png', contentBase64: bytes.toString('base64'), nature: 'simulation', description: '', purpose: '测试图片依赖' }).result.sourceId;
  f.knowledge.save({ ...f.write(), entryId: f.entryId, entry: { ...f.entry, images: [{ sourceId: imageId, caption: '示意' }] } });
  const task = f.wiki.prepare({ ...f.write(), taskKind: 'query', sourceIds: [f.sourceId], goal: '只读文本' });
  assert.equal(f.wiki.taskContext(f.write().researchId, task.result.taskId).knowledge.some(e => e.entryId === f.entryId), false);
  new GeneralEvidenceService(f.store).setAccess({ ...f.write(), sourceId: imageId, allowed: false, reason: '本地撤回' }, 'test');
  assert.throws(() => f.wiki.exportOkf(f.write().researchId), /revoked/);
});

test('OKF exports standard page links and remaps internal identities on roundtrip', t => {
 const f = fixture(t), researchId = f.write().researchId;
 f.knowledge.save({ ...f.write(), entry: { ...f.entry, title: '引用页', content: '[条件](wiki:' + f.entryId + ')' } });
 const archive = f.wiki.exportOkf(researchId), files = unzipSync(Buffer.from(archive.contentBase64, 'base64'));
 const linked = Object.entries(files).filter(([name]) => name.startsWith('pages/')).map(([,value]) => new TextDecoder().decode(value)).find(s => s.includes('[条件]'))!;
 assert.ok(linked.includes('](/pages/' + f.entryId + '.md)')); assert.ok(!linked.includes('](wiki:'));
 const result = f.wiki.importOkf({ ...f.write(), contentBase64: archive.contentBase64 });
 const imported = f.store.readStateOrEmpty().researches[0].general!.knowledge.filter(e => result.result.entryIds.includes(e.entryId));
 assert.ok(imported.find(e => e.title === '引用页')!.content.includes('wiki:' + imported.find(e => e.title === f.entry.title)!.entryId));
});

test('Agent Wiki publication resolves same-batch links and preserves research bindings across revisions', t => {
 const f = fixture(t), researchId = f.write().researchId;
 const g0 = f.store.readStateOrEmpty().researches[0].general!, nodeId = g0.graph.nodes[0].nodeId;
 f.knowledge.save({ ...f.write(), entryId: f.entryId, entry: { ...f.entry, nodeIds: [nodeId] } });
 const pinned = f.store.readStateOrEmpty().researches[0].general!.knowledge.at(-1)!;
 const graph = JSON.stringify(f.store.readStateOrEmpty().researches[0].general!.graph);
 const source = f.store.readStateOrEmpty().researches[0].general!.sources[0];
 const claims = [{ claimId: 'located', text: '模拟读数', nature: 'source_reported' as const, limitation: '模拟', locators: [{ kind: 'text' as const, sourceId: f.sourceId, sourceSha256: source.sha256, startByte: 0, endByte: Buffer.byteLength(f.text), quote: f.text }] }];
 const taskId = f.wiki.prepare({ ...f.write(), taskKind: 'ingest', sourceIds: [f.sourceId], goal: '生成相互关联条目' }).result.taskId;
 const result = f.wiki.publish({ ...f.write(), taskId, result: '已整理模拟条目', entries: [
  { ...f.entry, entryId: f.entryId, nodeIds: [], claims, relatedTitles: ['同批反例'] },
  { ...f.entry, title: '同批反例', claims, relatedTitles: [f.entry.title] },
 ] });
 const g = f.store.readStateOrEmpty().researches[0].general!, page = g.knowledge.filter(e => e.entryId === f.entryId).at(-1)!, other = g.knowledge.find(e => e.entryId === result.result.entryIds[1])!;
 assert.deepEqual(page.nodeIds, [nodeId]); assert.equal(page.nodeContextHash, pinned.nodeContextHash);
 assert.ok(page.content.includes('](wiki:' + other.entryId + ')')); assert.ok(other.content.includes('](wiki:' + page.entryId + ')'));
 assert.equal(g.knowledgeRelations.length, 2); assert.equal(JSON.stringify(g.graph), graph);
 assert.ok(!('relatedTitles' in page));
 const next = f.wiki.prepare({ ...f.write(), taskKind: 'ingest', sourceIds: [f.sourceId], goal: '改写摘要仍保留已登记导航与节点' }).result.taskId;
 f.wiki.publish({ ...f.write(), taskId: next, result: '更新完成', entries: [{ ...f.entry, entryId: f.entryId, content: '重新写过的摘要', claims, relatedTitles: [] }] });
 const updated = f.store.readStateOrEmpty().researches[0].general!.knowledge.at(-1)!;
 assert.deepEqual(updated.nodeIds, [nodeId]); assert.equal(updated.nodeContextHash, pinned.nodeContextHash);
 assert.ok(updated.content.includes('](wiki:' + other.entryId + ')'));
 assert.equal(f.store.readStateOrEmpty().researches[0].general!.knowledgeRelations.length, 2);
});

test('Agent Wiki relations reject missing, ambiguous and unassigned targets without partial writes', t => {
 const f = fixture(t), source = f.store.readStateOrEmpty().researches[0].general!.sources[0];
 const claims = [{ claimId: 'located', text: '模拟', nature: 'source_reported' as const, limitation: '模拟', locators: [{ kind: 'text' as const, sourceId: f.sourceId, sourceSha256: source.sha256, startByte: 0, endByte: Buffer.byteLength(f.text), quote: f.text }] }];
 const otherSource = f.data.importMaterial({ ...f.write(), filename: 'other.txt', mediaType: 'text/plain', contentBase64: Buffer.from('未分配来源').toString('base64'), nature: 'simulation', description: '', purpose: '' }).result.sourceId;
 f.knowledge.save({ ...f.write(), entry: { ...f.entry, title: '未分配页面', sourceRefs: [otherSource] } });
 const taskId = f.wiki.prepare({ ...f.write(), taskKind: 'ingest', sourceIds: [f.sourceId], goal: '检验关系边界' }).result.taskId;
 const revision = f.store.readStateOrEmpty().revision;
 for (const [title, error] of [['不存在', /不存在或不唯一/], ['未分配页面', /未分配/], [f.entry.title, /自身/]] as const) {
  assert.throws(() => f.wiki.publish({ ...f.write(), taskId, result: '不得保存', entries: [{ ...f.entry, entryId: f.entryId, claims, relatedTitles: [title] }] }), error);
  assert.equal(f.store.readStateOrEmpty().revision, revision);
 }
 assert.throws(() => f.wiki.publish({ ...f.write(), taskId, result: '不得保存', entries: [
  { ...f.entry, entryId: f.entryId, claims, relatedTitles: ['重名'] },
  { ...f.entry, title: '重名', claims }, { ...f.entry, title: '重名', claims },
 ] }), /不存在或不唯一/);
 assert.equal(f.store.readStateOrEmpty().revision, revision);
 // An Agent cannot add a binding by sending nodeIds; only existing host bindings survive.
 assert.throws(() => f.wiki.publish({ ...f.write(), taskId, result: '不得保存', entries: [{ ...f.entry, title: '非法绑定新页面', claims, nodeIds: [f.store.readStateOrEmpty().researches[0].general!.graph.nodes[0].nodeId] }] }), /不能改写|Agent 页面/);
 assert.equal(f.store.readStateOrEmpty().revision, revision);
});

test('Agent can prepare a scoped Wiki task, while foreign sources and stale writes remain rejected', async t => {
 const f = fixture(t), definitions = new Map<string, any>();
 applyGeneralWikiTools({ tools: { register: (tool: any) => definitions.set(tool.name, tool) } } as unknown as Context, sessionId => {
  if (sessionId !== 'owned-session') throw new Error('Wiki session has no workspace');
  return f.store;
 });
 const prepare = definitions.get('evolver_prepare_general_wiki_task');
 assert.ok(prepare);
 const input = { ...f.write(), taskKind: 'ingest', goal: '整理已授权来源', sourceIds: [f.sourceId] };
 await assert.rejects(() => prepare.execute(input, { agent: { id: 'other-session' } }), /no workspace/);
 await assert.rejects(() => prepare.execute({ ...input, sourceIds: ['foreign-source'] }, { agent: { id: 'owned-session' } }));
 const saved = await prepare.execute(input, { agent: { id: 'owned-session' } });
 assert.equal(saved.result.reused, false);
 const context = await definitions.get('evolver_read_general_wiki_task').execute({ researchId: input.researchId, taskId: saved.result.taskId }, { agent: { id: 'owned-session' } });
 assert.equal(context.task.status, 'pending'); assert.equal(context.task.sources[0].sourceId, f.sourceId);
 await assert.rejects(() => prepare.execute({ ...input, operationId: 'stale-write' }, { agent: { id: 'owned-session' } }), /REVISION|版本|revision/i);
});
