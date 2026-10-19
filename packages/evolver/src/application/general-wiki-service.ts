import { validateGeneralEvidenceLocator, type GeneralEvidenceLocator } from '../contracts/general-evidence.ts';
import { createHash } from 'node:crypto';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
const { parse, stringify } = createRequire(import.meta.url)('yaml') as { parse(text: string, options?: { maxAliasCount: number }): Record<string, unknown> | null; stringify(value: unknown): string };
import { BootstrapError } from '../contracts/research-bootstrap.ts';
import { validateGeneralResearch, type GeneralResearch } from '../contracts/general-research.ts';
import { validateGeneralKnowledge, validateGeneralKnowledgeRelation, type GeneralKnowledgeEntry } from '../contracts/general-knowledge.ts';
import { emptyWikiWorkspace, validateWikiWorkspace, type WikiBoard } from '../contracts/general-wiki.ts';
import { validateSource, type MaterialSource } from '../contracts/general-data.ts';
import { ResearchBootstrapStore, requireResearch } from './research-bootstrap-store.ts';
import { GeneralMaterialStore, sha256 } from './general-material-store.ts';
import { GeneralEvidenceReader } from './general-evidence-service.ts';
import { assertGeneralSourceAccess, generalSourceAllowed } from './general-source-access.ts';
import { generalContextHash } from './general-analysis-service.ts';

type Write = { researchId: string; operationId: string; baseRevision: number };
type Draft = Omit<GeneralKnowledgeEntry, 'entryId' | 'version' | 'createdAt'> & { entryId?: string; relatedTitles?: string[] };
const latest = (g: GeneralResearch) => g.knowledge.filter(e => !g.knowledge.some(n => n.entryId === e.entryId && n.version > e.version));
const knowledgeHash = (g: GeneralResearch) => sha256(JSON.stringify(latest(g)));
const fail = (message: string): never => { throw new BootstrapError('INVALID_INPUT', message); };
export class GeneralWikiService {
  readonly store: ResearchBootstrapStore;
  constructor(store: ResearchBootstrapStore) { this.store = store; }
  private read(researchId: string) { const state = this.store.readStateOrEmpty(), r = requireResearch(state, researchId); if (!r.general) fail('需要通用研究'); return { state, r, g: r.general! }; }
  private mutate<T>(input: Write, kind: string, payload: Record<string, unknown>, apply: (g: GeneralResearch, mint: (s: string) => string, now: string) => T) {
    return this.store.mutate({ ...input, kind, requestPayload: payload, apply: ctx => {
      const r = requireResearch(ctx.state, input.researchId); if (!r.general) fail('需要通用研究');
      const result = apply(r.general!, ctx.mint, ctx.now()); r.general!.revision++; r.general = validateGeneralResearch(r.general); r.updatedAt = ctx.now();
      return { changed: true, result };
    } });
  }
  saveBoard(input: Write & { board: WikiBoard }) {
    return this.mutate(input, 'save_general_wiki_board', { board: input.board }, (g, _mint, now) => {
      const b = validateWikiWorkspace({ boards: [input.board], tasks: [], events: [] }).boards[0];
      if (b.cards.some(c => !latest(g).some(e => e.entryId === c.entryId && !e.archived))) fail('白板引用了不存在或已归档的知识');
      const w = g.wiki ??= emptyWikiWorkspace(), index = w.boards.findIndex(x => x.boardId === b.boardId);
      if (index < 0) w.boards.push(b); else w.boards[index] = b;
      w.events.push({ at: now, kind: 'board', text: `保存白板「${b.title}」；${b.cards.length} 张卡片，知识正文未复制。` });
      return { boardId: b.boardId };
    });
  }
  source(researchId: string, sourceId: string) {
    const { g } = this.read(researchId); assertGeneralSourceAccess(g, sourceId);
    const s = g.sources.find(s => s.sourceId === sourceId)!; const bytes = new GeneralMaterialStore(this.store.workspaceRoot).readRaw(s);
    if (/^image\/(png|jpeg|webp|gif)$/.test(s.mediaType)) return { source: s, text: null, image: true, coverage: '原始图片；未声明模型理解' };
    if (!/^(text\/|application\/json)/.test(s.mediaType) && !/\.(md|markdown|txt|csv|json|tsv)$/i.test(s.filename)) return { source: s, text: null, image: false, coverage: '附件原文预览尚不可用；可下载原文件' };
    if (bytes.length > 256 * 1024) fail('文本超过 256 KiB 预览上限，请下载或缩小材料范围；未静默截断');
    return { source: s, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), image: false, coverage: `UTF-8 原文，0–${bytes.length} bytes` };
  }
  lint(researchId: string) {
    const { g, state } = this.read(researchId), reader = new GeneralEvidenceReader(this.store, researchId, state);
    return { entries: latest(g).filter(e => !e.archived).map(e => ({ entryId: e.entryId, title: e.title, ...reader.check(e), issues: [
      ...(!e.sourceRefs.length && !e.calculationIds.length ? ['缺来源：人工知识或尚待补据'] : []),
      ...((e.sourcePins ?? []).some(p => g.sources.some(s => s.previousSourceId === p.sourceId) || g.sources.find(s => s.sourceId === p.sourceId)?.sha256 !== p.sha256) ? ['来源已变更，需重核'] : []),
      ...(!g.knowledgeRelations.some(r => r.fromEntryId === e.entryId || r.toEntryId === e.entryId) ? ['孤立知识：暂无人工关系'] : []),
      ...(e.counterEvidence ?? []).map(t => `反证 / 分歧：${t}`),
    ] })), boundary: '定位与结构检查不证明科学主张成立；模型提出的矛盾仍待核对。' };
  }
  prepare(input: Write & { taskKind: 'ingest' | 'query'; goal: string; sourceIds: string[] }) {
    if (!['ingest', 'query'].includes(input.taskKind) || !input.goal?.trim() || input.goal.length > 4000 || !Array.isArray(input.sourceIds) || !input.sourceIds.length || input.sourceIds.length > 10 || new Set(input.sourceIds).size !== input.sourceIds.length) fail('请选择 1–10 个来源并填写整理目标或问题');
    return this.mutate(input, 'prepare_general_wiki_task', { kind: input.taskKind, goal: input.goal, sources: input.sourceIds }, (g, mint, now) => {
      const w = g.wiki ??= emptyWikiWorkspace(); if (w.tasks.some(t => t.status === 'pending')) fail('已有知识任务尚未结束；请等待或标记本次失败后重试');
      const sources = input.sourceIds.map(id => { assertGeneralSourceAccess(g, id); const s = g.sources.find(s => s.sourceId === id)!; new GeneralMaterialStore(this.store.workspaceRoot).readRaw(s); return { sourceId: id, sha256: s.sha256 }; });
      const signature = knowledgeHash(g);
      const reused = input.taskKind === 'ingest' && w.tasks.find(t => t.status === 'completed' && t.kind === 'ingest' && t.goal === input.goal && JSON.stringify(t.sources) === JSON.stringify(sources) && t.knowledgeHash === signature);
      if (reused) return { taskId: reused.taskId, reused: true };
      const taskId = mint('wiki-task'); w.tasks.push({ taskId, kind: input.taskKind, goal: input.goal, status: 'pending', sources, knowledgeHash: signature, result: '', error: '', createdAt: now });
      w.events.push({ at: now, kind: input.taskKind, text: `已登记知识任务：${input.goal}；尚未发布。` }); return { taskId, reused: false };
    });
  }
  taskContext(researchId: string, taskId: string) {
    const { g, state } = this.read(researchId), t = g.wiki?.tasks.find(t => t.taskId === taskId); if (!t || t.status !== 'pending') fail('没有待执行的知识任务');
    for (const p of t!.sources) { assertGeneralSourceAccess(g, p.sourceId); if (g.sources.find(s => s.sourceId === p.sourceId)?.sha256 !== p.sha256) fail('任务来源已变化'); }
    const pack = new GeneralEvidenceReader(this.store, researchId, state).retrieve(t!.goal, t!.sources.map(s => s.sourceId), 12, 6000);
    return { task: t!, revision: state.revision, publishGuide: { taskKind: t!.kind, query: { entries: [], citations: pack.hits.flatMap(h => h.locators).slice(0, 3) }, textLocatorFields: ['kind', 'sourceId', 'sourceSha256', 'startByte', 'endByte', 'quote'], relatedTitlesFormat: 'Exact titles of related pages (existing or in this publish batch). Host resolves them to stable wiki: links and related edges; [] means no new links. Never use prose-only related-page mentions as links.', sourceRefsFormat: 'unique source ID strings; never locator objects', preservedOnUpdate: ['nodeIds', 'nodeContextHash', 'existing related links'], nodeIds: [], calculationIds: [], parameters: [], instruction: 'For query publish entries=[] and the answer in result. Copy canonical locators exactly without extra fields; do not load an unrelated legacy Wiki workflow.' }, researchQuestion: g.ideas[0]?.question, evidence: pack, knowledge: latest(g).filter(e => !e.archived && new GeneralEvidenceReader(this.store, researchId, state).sourceIds(e).every(id => generalSourceAllowed(g, id) && t!.sources.some(s => s.sourceId === id))).map(e => ({ ...e, content: e.content })), sourceTexts: t!.sources.map(p => this.source(researchId, p.sourceId)) };
  }
  publish(input: Write & { taskId: string; result: string; entries: Draft[]; citations?: GeneralEvidenceLocator[]; error?: string }) {
    if (typeof input.result !== 'string' || input.result.length > 24000 || !Array.isArray(input.entries) || input.entries.length > 15) fail('知识产物超限或格式错误');
    return this.mutate(input, 'publish_general_wiki_task', { taskId: input.taskId, result: input.result, entries: input.entries, citations: input.citations ?? [], error: input.error ?? '' }, (g, mint, now) => {
      const w = g.wiki ??= emptyWikiWorkspace(), t = w.tasks.find(t => t.taskId === input.taskId); if (!t || t.status !== 'pending') fail('任务不存在或已经结束');
      if (input.error) { t!.status = 'failed'; t!.error = input.error.slice(0, 4000); w.events.push({ at: now, kind: 'failed', text: t!.error }); return { taskId: t!.taskId, status: 'failed' }; }
      if (!input.result.trim() || t!.kind === 'ingest' && !input.entries.length) fail('没有有效产物；不把空回复登记为完成');
      if (knowledgeHash(g) !== t!.knowledgeHash) fail('知识在生成期间发生变化，请重新整理；旧版本未覆盖');
      for (const p of t!.sources) { assertGeneralSourceAccess(g, p.sourceId); if (g.sources.find(s => s.sourceId === p.sourceId)?.sha256 !== p.sha256 || g.sources.some(s => s.previousSourceId === p.sourceId)) fail('来源已变更，请重新生成'); }
      const reader = new GeneralEvidenceReader(this.store, input.researchId, this.store.readStateOrEmpty());
      const citations = (input.citations ?? []).map(validateGeneralEvidenceLocator);
      if (citations.length > 20 || t!.kind === 'query' && !citations.length) fail('问答必须提供 1–20 条可核对的引用定位');
      for (const locator of citations) reader.assertLocator(locator, t!.sources.map(s => s.sourceId));
      const entries = input.entries.map(d => {
        const previous = d.entryId ? latest(g).find(e => e.entryId === d.entryId) : undefined;
        if (d.entryId && !previous) fail('修改的知识不属于本研究');
        if (!previous && latest(g).some(e => !e.archived && e.title.trim().toLocaleLowerCase() === d.title.trim().toLocaleLowerCase())) fail('已有同名主题，请携带原 entryId 更新版本，不能重复建页');
        const { relatedTitles, ...draft } = d;
        if (relatedTitles !== undefined && (!Array.isArray(relatedTitles) || relatedTitles.length > 30 || relatedTitles.some(title => typeof title !== 'string' || !title.trim() || title.length > 300) || new Set(relatedTitles).size !== relatedTitles.length)) fail('relatedTitles 必须是最多30个不重复的页面完整标题');
        const e = validateGeneralKnowledge({ ...draft, entryId: previous?.entryId ?? mint('knowledge'), version: (previous?.version ?? 0) + 1, createdAt: now, contextHash: generalContextHash(g), sourcePins: t!.sources });
        if (e.kind !== 'wiki' || e.archived || !e.claims?.length || e.nodeIds.length || e.calculationIds.length || e.parameters.length || e.operation !== 'manual' || e.input !== '' || e.output !== '' || (e.images ?? []).length || e.sourceRefs.some(id => !t!.sources.some(s => s.sourceId === id))) fail('Agent 页面须为有定位主张的 Wiki，且仅使用分配的来源；不能改写实验、归档或图片权限');
        for (const c of e.claims!) { if (!c.locators.length) fail('每条模型主张必须带定位；推断也需引用其依据'); for (const l of c.locators) reader.assertLocator(l, t!.sources.map(s => s.sourceId)); }
        // Research bindings are host-owned; an Agent may neither erase nor invent them.
        if (previous) {
          e.nodeIds = [...previous.nodeIds];
          if (previous.nodeContextHash !== undefined) e.nodeContextHash = previous.nodeContextHash;
        }
        return e;
      });
      if (new Set(entries.map(e => e.entryId)).size !== entries.length) fail('重复修改同一知识身份');
      const pages = [...latest(g).filter(old => !entries.some(e => e.entryId === old.entryId)), ...entries];
      const safeLabel = (title: string) => title.replace(/[\[\]\r\n]/g, '');
      for (const [index, entry] of entries.entries()) {
        const related = (input.entries[index].relatedTitles ?? []).map(title => {
          const matches = pages.filter(page => !page.archived && page.title === title);
          if (matches.length !== 1) fail('关联标题不存在或不唯一：' + title + '；请使用当前页面的完整标题');
          const target = matches[0];
          if (target.entryId === entry.entryId) fail('关联页面不能引用自身：' + title);
          // New batch pages were validated above. Existing targets must be within task scope.
          if (!entries.includes(target)) {
            reader.assertEntryAccess(target);
            if (!reader.sourceIds(target).every(id => t!.sources.some(source => source.sourceId === id))) fail('关联页面来源未分配给当前任务：' + title);
          }
          return target;
        });
        // Retain already registered navigational links when an Agent rewrites the body.
        const old = latest(g).find(page => page.entryId === entry.entryId);
        for (const relation of g.knowledgeRelations.filter(r => r.fromEntryId === entry.entryId && r.kind === 'related')) {
          const target = pages.find(p => p.entryId === relation.toEntryId && !p.archived);
          if (target && !related.some(p => p.entryId === target.entryId) && reader.sourceIds(target).every(id => generalSourceAllowed(g, id) && t!.sources.some(s => s.sourceId === id))) related.push(target);
        }
        for (const match of old?.content.matchAll(/\]\(wiki:([^\s)]+)\)/g) ?? []) {
          const target = pages.find(p => p.entryId === match[1] && !p.archived);
          if (target && !related.some(p => p.entryId === target.entryId) && reader.sourceIds(target).every(id => generalSourceAllowed(g, id) && t!.sources.some(s => s.sourceId === id))) related.push(target);
        }
        const missing = related.filter(target => !entry.content.includes('](wiki:' + target.entryId + ')'));
        if (missing.length) entry.content += '\n\n## 关联条目\n' + missing.map(target => '- [' + safeLabel(target.title) + '](wiki:' + target.entryId + ')').join('\n');
        validateGeneralKnowledge(entry); // Enforce limits after adding host-resolved links.
      }
      g.knowledge.push(...entries);
      for (const entry of entries) for (const m of entry.content.matchAll(/\]\(wiki:([^)]+)\)/g)) {
        if (!latest(g).some(e => e.entryId === m[1]) || m[1] === entry.entryId) continue;
        if (!g.knowledgeRelations.some(r => r.fromEntryId === entry.entryId && r.toEntryId === m[1])) g.knowledgeRelations.push({ relationId: mint('relation'), version: 1, fromEntryId: entry.entryId, toEntryId: m[1], kind: 'related', note: '模型页面交叉引用，非科学支持', locator: null, createdAt: now, updatedAt: now });
      }
      t!.status = 'completed'; t!.result = input.result; t!.citations = citations; t!.knowledgeHash = knowledgeHash(g);
      w.events.push({ at: now, kind: t!.kind, text: `${input.result.slice(0, 3500)}；发布 ${entries.length} 个知识版本。` });
      return { taskId: t!.taskId, status: t!.status, entryIds: entries.map(e => e.entryId) };
    });
  }
  exportOkf(researchId: string) {
    const { g } = this.read(researchId), reader = new GeneralEvidenceReader(this.store, researchId, this.store.readStateOrEmpty());
    const entries = latest(g).filter(e => !e.archived); for (const e of entries) reader.assertEntryAccess(e);
    const files: Record<string, Uint8Array> = {}, sourceIds = [...new Set(entries.flatMap(e => [...e.sourceRefs, ...(e.images ?? []).map(i => i.sourceId)]))];
    const materials = new GeneralMaterialStore(this.store.workspaceRoot);
    const sources = sourceIds.map(id => { assertGeneralSourceAccess(g, id); const s = g.sources.find(s => s.sourceId === id)!; const bytes = materials.readRaw(s); files[`assets/${s.sourceId}`] = bytes; return s; });
    for (const e of entries) {
      const body = e.content.replace(/\]\(wiki:([^)]+)\)/g, (all, id: string) => entries.some(e => e.entryId === id) ? '](/pages/' + id + '.md)' : all) + (e.images ?? []).map(i => `\n\n![${i.caption.replaceAll(']', '')}](/assets/${i.sourceId})`).join('') + '\n\n## 关联\n' + g.knowledgeRelations.filter(r => r.fromEntryId === e.entryId).map(r => `- [${entries.find(e => e.entryId === r.toEntryId)?.title ?? r.toEntryId}](/pages/${r.toEntryId}.md) — ${r.note}`).join('\n');
      files[`pages/${e.entryId}.md`] = strToU8(`---\n${stringify({ ...(e.okfMetadata ?? {}), type: e.okfMetadata?.type ?? e.entityType ?? 'concept', title: e.title, description: e.category, tags: [e.category], status: 'draft', sources: e.sourceRefs.map(id => ({ resource: `/assets/${id}` })), generated: { by: 'process:dsh-wiki-export', at: e.createdAt } })}---\n\n${body}`);
    }
    files['index.md'] = strToU8(`---\nokf_version: "0.2"\n---\n# Knowledge\n${entries.map(e => `- [${e.title.replaceAll(']', '')}](/pages/${e.entryId}.md) - ${e.category}`).join('\n')}`);
    files['log.md'] = strToU8('# Wiki update log\n' + [...(g.wiki?.events ?? [])].reverse().map(e => `\n## ${e.at.slice(0, 10)}\n- ${e.kind}: ${e.text}`).join('\n'));
    files['dsh/manifest.json'] = strToU8(JSON.stringify({ schemaVersion: 1, entries, sources, relations: g.knowledgeRelations, layout: g.knowledgeLayout, boards: g.wiki?.boards ?? [] }));
    if (Object.values(files).reduce((n, b) => n + b.length, 0) > 24 * 1024 * 1024) fail('Wiki 包超过 24 MiB');
    return { filename: `wiki-${researchId}.okf.zip`, contentBase64: Buffer.from(zipSync(files)).toString('base64'), pages: entries.length };
  }
  importOkf(input: Write & { contentBase64: string }) {
    if (typeof input.contentBase64 !== 'string' || input.contentBase64.length > 36 * 1024 * 1024) fail('OKF 压缩包超限');
    let total = 0, count = 0;
    const files = unzipSync(Buffer.from(input.contentBase64, 'base64'), { filter: f => { total += f.originalSize; count++; if (total > 24 * 1024 * 1024 || count > 1000 || f.originalSize > 10 * 1024 * 1024 || /(^\/|\\|(^|\/)\.\.(\/|$))/.test(f.name)) fail('OKF 文件超限或路径非法'); return true; } });
    const concepts = Object.entries(files).filter(([name]) => /\.md$/i.test(name) && !/(^|\/)(index|log)\.md$/i.test(name));
    if (!concepts.length || concepts.length > 200) fail('请选择包含 1–200 个概念页面的 OKF 包');
    return this.mutate(input, 'import_general_wiki_okf', { sha256: createHash('sha256').update(input.contentBase64).digest('hex') }, (g, mint, now) => {
      const idMap = new Map<string, string>(), pathMap = new Map<string, string>();
      const imported = concepts.map(([name, bytes]) => {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/); if (!m) fail(`缺少 YAML frontmatter：${name}`);
        const meta = parse(m![1], { maxAliasCount: 30 }); if (!meta || typeof meta.type !== 'string' || !meta.type.trim()) throw new BootstrapError('INVALID_INPUT', `缺少 type：${name}`);
        const entityType = String(meta.type);
        const entryId = mint('knowledge'); pathMap.set(name, entryId); idMap.set(name.replace(/^pages\//, '').replace(/\.md$/, ''), entryId);
        return validateGeneralKnowledge({ kind: 'wiki', entryId, version: 1, createdAt: now, title: String(meta.title ?? name).slice(0, 300), okfMetadata: meta, category: String(meta.description ?? 'OKF 导入').slice(0, 100), content: m![2], nature: 'unknown', entityType: ['entity', 'concept', 'overview', 'metric', 'experiment'].includes(entityType) ? entityType : null, sourceRefs: [], calculationIds: [], nodeIds: [], input: '', output: '', conditions: [], parameters: [], operation: 'manual', archived: false });
      });
      // DSH extension restores exact content and visual references. It cannot import verification or execution grants.
      const manifestBytes = files['dsh/manifest.json'];
      const sourceMap = new Map<string, string>();
      if (manifestBytes) {
        const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
        if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries) || !Array.isArray(manifest.sources)) fail('非法 DSH Wiki 扩展');
        const materials = new GeneralMaterialStore(this.store.workspaceRoot);
        for (const raw of manifest.sources) {
          const old = validateSource(raw), bytes = files[`assets/${old.sourceId}`]; if (!bytes || sha256(Buffer.from(bytes)) !== old.sha256) fail('Wiki 图片 / 来源缺失或 hash 不符');
          const parsed = materials.parse(old.filename, Buffer.from(bytes)), persisted = materials.persist(Buffer.from(bytes), parsed), sourceId = mint('source');
          const s = validateSource({ ...old, sourceId, revision: 1, previousSourceId: null, ...persisted, acquiredAt: now, parser: parsed.parser, parseStatus: parsed.error ? 'attachment' : 'parsed', firstError: parsed.error, tables: parsed.tables.map(t => ({ tableId: t.tableId, name: t.name, rowCount: t.rows.length, columnCount: t.headers.length })) });
          sourceMap.set(old.sourceId, sourceId); g.sources.push(s); g.sourceAccess.push({ decisionId: mint('access'), sourceId, allowed: false, reason: 'OKF 导入资料待本地重新授权', actor: { identity: 'wiki-import', actionId: input.operationId }, createdAt: now });
        }
        for (const raw of manifest.entries) {
          const old = validateGeneralKnowledge(raw), e = imported.find(e => e.entryId === idMap.get(old.entryId)); if (!e) fail('扩展条目缺少对应概念文件');
          Object.assign(e!, { ...old, entryId: e!.entryId, version: 1, createdAt: now, sourceRefs: old.sourceRefs.map(id => sourceMap.get(id) ?? fail('缺少导入来源')), images: old.images?.map(i => ({ ...i, sourceId: sourceMap.get(i.sourceId) ?? fail('缺少图片') })), sourcePins: (old.sourcePins ?? []).map(p => ({ ...p, sourceId: sourceMap.get(p.sourceId) ?? fail('缺少来源版本') })), claims: (old.claims ?? []).filter(c => c.locators.every(l => l.kind === 'text')).map(c => ({ ...c, locators: c.locators.map(l => l.kind === 'text' ? { ...l, sourceId: sourceMap.get(l.sourceId) ?? fail('缺少定位来源') } : l) })), nodeIds: [], calculationIds: [], nature: 'unknown', contextHash: undefined, nodeContextHash: undefined, limitations: [...(old.limitations ?? []), '导入知识待本地核对；原计算、定位验证与授权不继承。'] });
        }
        for (const raw of manifest.relations ?? []) {
          const old = validateGeneralKnowledgeRelation(raw), from = idMap.get(old.fromEntryId), to = idMap.get(old.toEntryId); if (!from || !to || old.locator?.kind === 'calculation') continue;
          const locator = old.locator?.kind === 'text' ? { ...old.locator, sourceId: sourceMap.get(old.locator.sourceId) ?? fail('关系来源缺失') } : null;
          g.knowledgeRelations.push({ ...old, relationId: mint('relation'), version: 1, fromEntryId: from, toEntryId: to, locator, createdAt: now, updatedAt: now });
        }
        for (const [oldId, position] of Object.entries(manifest.layout ?? {})) {
          const id = idMap.get(oldId) ?? (oldId.startsWith('source:') && sourceMap.has(oldId.slice(7)) ? 'source:' + sourceMap.get(oldId.slice(7)) : null);
          if (id) g.knowledgeLayout[id] = position as { x: number; y: number };
        }
        const boards = validateWikiWorkspace({ boards: manifest.boards ?? [], tasks: [], events: [] }).boards;
        for (const b of boards) { b.boardId = mint('board'); for (const c of b.cards) c.entryId = idMap.get(c.entryId) ?? fail('白板引用缺少条目'); }
        (g.wiki ??= emptyWikiWorkspace()).boards.push(...boards);
      }
      const media = new Map<string, string>();
      const resolvePath = (page: string, target: string) => target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(posix.dirname(page), target.replace(/^\.\//, '')));
      for (const [i, [name]] of concepts.entries()) {
        const e = imported[i];
        if (!manifestBytes) e.content = e.content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (all, caption: string, target: string) => {
          const location = resolvePath(name, target), bytes = files[location];
          if (!bytes || !/\.(png|jpe?g|gif|webp)$/i.test(location)) return all;
          let sourceId = media.get(location);
          if (!sourceId) {
            const materials = new GeneralMaterialStore(this.store.workspaceRoot), raw = Buffer.from(bytes), parsed = materials.parse(posix.basename(location), raw), persisted = materials.persist(raw, parsed);
            sourceId = mint('source');
            const mediaType = /\.png$/i.test(location) ? 'image/png' : /\.gif$/i.test(location) ? 'image/gif' : /\.webp$/i.test(location) ? 'image/webp' : 'image/jpeg';
            const s = validateSource({ sourceId, filename: posix.basename(location), mediaType, bytes: raw.length, description: 'OKF 图片，待本地核对', purpose: '知识卡片图片', nature: 'unknown', revision: 1, previousSourceId: null, ...persisted, acquiredAt: now, parser: parsed.parser, parseStatus: parsed.error ? 'attachment' : 'parsed', firstError: parsed.error, tables: [] });
            g.sources.push(s); g.sourceAccess.push({ decisionId: mint('access'), sourceId, allowed: false, reason: 'OKF 图片待本地重新授权', actor: { identity: 'wiki-import', actionId: input.operationId }, createdAt: now }); media.set(location, sourceId);
          }
          (e.images ??= []).push({ sourceId, caption }); return '';
        });
        e.content = e.content.replace(/\]\(([^)]+)\)/g, (all, target: string) => { const next = target.startsWith('wiki:') ? idMap.get(target.slice(5)) : pathMap.get(resolvePath(name, target)); return next ? `](wiki:${next})` : all; });
        for (const match of e.content.matchAll(/\]\(wiki:([^)]+)\)/g)) {
          if (!imported.some(entry => entry.entryId === match[1]) || e.entryId === match[1] || g.knowledgeRelations.some(r => r.fromEntryId === e.entryId && r.toEntryId === match[1])) continue;
          g.knowledgeRelations.push({ relationId: mint('relation'), version: 1, fromEntryId: e.entryId, toEntryId: match[1], kind: 'related', note: `OKF 文档链接（${name}）；不代表科学支持`, locator: null, createdAt: now, updatedAt: now });
        }
      }
      g.knowledge.push(...imported); (g.wiki ??= emptyWikiWorkspace()).events.push({ at: now, kind: 'import', text: `导入 ${imported.length} 个 OKF 页面；内容保留待核对。` });
      return { entryIds: imported.map(e => e.entryId), sources: sourceMap.size + media.size, status: 'needs_review' };
    });
  }
}
