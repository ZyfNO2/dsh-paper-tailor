import { emptyWikiWorkspace } from '../contracts/general-wiki.ts';
import { BootstrapError } from '../contracts/research-bootstrap.ts';
import { validateGeneralResearch } from '../contracts/general-research.ts';
import { validateGeneralKnowledge, validateGeneralKnowledgeRelation, type GeneralKnowledgeEntry, type GeneralKnowledgeRelation } from '../contracts/general-knowledge.ts';
import { ResearchBootstrapStore, requireResearch } from './research-bootstrap-store.ts';
import { GeneralMaterialStore } from './general-material-store.ts';
import { GeneralAnalysisService, generalContextHash } from './general-analysis-service.ts';
import { GeneralEvidenceReader, knowledgeNodeContextHash } from './general-evidence-service.ts';
import { assertGeneralSourceAccess } from './general-source-access.ts';
import { ResearchCycleStore } from './research-cycle-store.ts';
export class GeneralKnowledgeService {
  readonly store: ResearchBootstrapStore;
  constructor(store: ResearchBootstrapStore) { this.store = store; }
  save(input: { operationId: string; baseRevision: number; researchId: string; entryId?: string | null; entry: Omit<GeneralKnowledgeEntry, 'entryId' | 'version' | 'createdAt'>; initialRelation?: { toEntryId: string; kind: 'related' | 'evidence_for'; note: string } | null }) {
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, researchId: input.researchId, kind: 'save_general_knowledge', requestPayload: { researchId: input.researchId, entryId: input.entryId ?? null, entry: input.entry, initialRelation: input.initialRelation ?? null }, apply: context => {
      const r = requireResearch(context.state, input.researchId), g = r.general; if (!g) throw new BootstrapError('INVALID_INPUT', '没有通用研究');
      const previous = input.entryId ? g.knowledge.filter(e => e.entryId === input.entryId).sort((a, b) => a.version - b.version).at(-1) : undefined;
      if (input.entryId && !previous) throw new BootstrapError('NOT_FOUND', '资产不属于此研究');
      const entry = validateGeneralKnowledge({ ...input.entry, claims: input.entry.claims ?? [], contextHash: generalContextHash(g), entryId: previous?.entryId ?? context.mint('knowledge'), version: (previous?.version ?? 0) + 1, createdAt: context.now() });
      if (previous && previous.kind !== entry.kind) throw new BootstrapError('INVALID_INPUT', '不能改变资产类型');
      const materials = new GeneralMaterialStore(this.store.workspaceRoot);
      for (const id of entry.sourceRefs) { assertGeneralSourceAccess(g, id); const source = g.sources.find(s => s.sourceId === id); if (!source) throw new BootstrapError('SOURCE_MISSING', '来源不属于此研究'); materials.readRaw(source); }
      const reader = new GeneralEvidenceReader(this.store, input.researchId, context.state);
      reader.assertEntryAccess(entry);
      for (const id of entry.calculationIds) new GeneralAnalysisService(this.store).readCalculation(input.researchId, id, context.state);
      for (const claim of entry.claims ?? []) for (const locator of claim.locators) reader.assertLocator(locator);
      if (entry.nodeIds.some(id => !g.graph.nodes.some(n => n.nodeId === id))) throw new BootstrapError('NOT_FOUND', '关联节点不属于此研究');
      entry.nodeContextHash = knowledgeNodeContextHash(g, entry.nodeIds);
      if (entry.nature === 'source_reported' && !entry.sourceRefs.length && !entry.calculationIds.length) throw new BootstrapError('SOURCE_MISSING', '来源报告需要真实依据');
      for (const image of entry.images ?? []) {
        assertGeneralSourceAccess(g, image.sourceId); const source = g.sources.find(s => s.sourceId === image.sourceId)!;
        const bytes = materials.readRaw(source);
        const valid = source.mediaType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || source.mediaType === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 || source.mediaType === 'image/gif' && bytes.subarray(0, 3).toString() === 'GIF' || source.mediaType === 'image/webp' && bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
        if (!valid) throw new BootstrapError('INVALID_INPUT', '图片类型与原始内容不符；仅支持 PNG/JPEG/GIF/WebP');
      }
      entry.sourcePins = [...new Set([...entry.sourceRefs, ...(entry.images ?? []).map(i => i.sourceId)])].map(id => ({ sourceId: id, sha256: g.sources.find(s => s.sourceId === id)!.sha256 }));
      g.knowledge.push(entry);
      (g.wiki ??= emptyWikiWorkspace()).events.push({ at: context.now(), kind: previous ? 'revision' : 'creation', text: entry.title + ' v' + entry.version + '；人工保存，未授予科学验证。' });
      // F08：新建实体与初始人工关系在同一可信事务；evidence_for 由关系保存校验定位。
      if (input.initialRelation) {
        const relation = this.buildRelation(g, context.mint('relation'), entry.entryId, input.initialRelation, context.now());
        g.knowledgeRelations.push(relation);
      }
      g.revision++; r.general = validateGeneralResearch(g);
      if (!previous && g.knowledge.some(e => e.entryId !== entry.entryId && !e.archived && e.title.trim().toLocaleLowerCase() === entry.title.trim().toLocaleLowerCase())) throw new BootstrapError('INVALID_INPUT', '已存在同名知识，请编辑已有条目');
      r.updatedAt = context.now();
      return { changed: true, result: { entryId: entry.entryId, version: entry.version, ...(input.initialRelation ? { relationId: g.knowledgeRelations.at(-1)!.relationId } : {}) } };
    } });
  }
  /** F08：保存人工关系（related / evidence_for+locator）；端点必须为现存知识条目，来源/计算定位逐一断言。 */
  saveRelation(input: { operationId: string; baseRevision: number; researchId: string; relationId?: string | null; relation: { fromEntryId: string; toEntryId: string; kind: 'related' | 'evidence_for'; note: string; locator?: GeneralKnowledgeRelation['locator'] } }) {
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, researchId: input.researchId, kind: 'save_general_knowledge_relation', requestPayload: { researchId: input.researchId, relationId: input.relationId ?? null, relation: input.relation }, apply: context => {
      const r = requireResearch(context.state, input.researchId), g = r.general; if (!g) throw new BootstrapError('INVALID_INPUT', '没有通用研究');
      const previous = input.relationId ? g.knowledgeRelations.find(x => x.relationId === input.relationId) : undefined;
      if (input.relationId && !previous) throw new BootstrapError('NOT_FOUND', '知识关系不属于此研究');
      const relation = this.buildRelation(g, previous?.relationId ?? context.mint('relation'), input.relation.fromEntryId, input.relation, context.now(), previous?.version ?? 0);
      if (previous) g.knowledgeRelations[g.knowledgeRelations.indexOf(previous)] = relation; else g.knowledgeRelations.push(relation);
      g.revision++; r.general = validateGeneralResearch(g); r.updatedAt = context.now();
      return { changed: true, result: { relationId: relation.relationId, relationVersion: relation.version } };
    } });
  }
  /** F08：图谱布局保存（仅坐标，不改语义关系；部分合并）。 */
  saveLayout(input: { operationId: string; baseRevision: number; researchId: string; positions: Record<string, { x: number; y: number }> }) {
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, researchId: input.researchId, kind: 'save_general_knowledge_layout', requestPayload: { researchId: input.researchId, positions: input.positions }, apply: context => {
      const r = requireResearch(context.state, input.researchId), g = r.general; if (!g) throw new BootstrapError('INVALID_INPUT', '没有通用研究');
      const entryIds = new Set([...g.knowledge.map(k => k.entryId), ...g.sources.map(s => 'source:' + s.sourceId)]);
      for (const id of Object.keys(input.positions)) if (!entryIds.has(id)) throw new BootstrapError('NOT_FOUND', '布局引用的知识条目不存在');
      g.knowledgeLayout = { ...g.knowledgeLayout, ...input.positions };
      g.revision++; r.general = validateGeneralResearch(g); r.updatedAt = context.now();
      return { changed: true, result: { layoutRevision: g.revision } };
    } });
  }
  private buildRelation(g: NonNullable<ReturnType<typeof requireResearch>['general']>, relationId: string, fromEntryId: string, relation: { toEntryId: string; kind: 'related' | 'evidence_for'; note: string; locator?: GeneralKnowledgeRelation['locator'] }, now: string, previousVersion = 0): GeneralKnowledgeRelation {
    const entryIds = new Set(g.knowledge.map(k => k.entryId));
    if (!entryIds.has(fromEntryId) || !entryIds.has(relation.toEntryId)) throw new BootstrapError('NOT_FOUND', '知识关系的条目不属于此研究');
    if (fromEntryId === relation.toEntryId) throw new BootstrapError('INVALID_INPUT', '知识关系两端不能相同');
    const locator = relation.locator ?? null;
    if (locator?.kind === 'text') {
      const source = g.sources.find(s => s.sourceId === locator.sourceId);
      if (!source) throw new BootstrapError('SOURCE_MISSING', '关系定位的来源不属于此研究');
      assertGeneralSourceAccess(g, locator.sourceId);
      const bytes = new GeneralMaterialStore(this.store.workspaceRoot).readRaw(source);
      if (!/^(text\/|application\/json)/.test(source.mediaType) || !new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes(locator.quote)) throw new BootstrapError('INVALID_INPUT', '关系引用原文不匹配；文件关联不能冒充精确证据');
    }
    if (locator?.kind === 'calculation' && !g.calculations.some(c => c.calculationId === locator.calculationId)) throw new BootstrapError('NOT_FOUND', '关系定位的计算不存在');
    return validateGeneralKnowledgeRelation({ relationId, version: previousVersion + 1, fromEntryId, toEntryId: relation.toEntryId, kind: relation.kind, note: relation.note, locator, createdAt: now, updatedAt: now });
  }
  export(researchId: string, includeRaw: boolean) {
    const state = this.store.readStateOrEmpty(), r = requireResearch(state, researchId), g = r.general; if (!g) throw new BootstrapError('INVALID_INPUT', '历史研究请使用原导出入口');
    if (includeRaw && g.sources.reduce((total, s) => total + s.bytes, 0) > 24 * 1024 * 1024) throw new BootstrapError('INVALID_INPUT', '原始文件合计超过 24 MiB，请导出不含原始文件的研究包');
    const materials = new GeneralMaterialStore(this.store.workspaceRoot), cycles = new ResearchCycleStore(this.store.workspaceRoot, researchId);
    const sources = g.sources.map(s => { assertGeneralSourceAccess(g, s.sourceId); const raw = materials.readRaw(s); return { source: s, ...(includeRaw ? { contentBase64: raw.toString('base64') } : {}) }; });
    const calculations = g.calculations.map(c => new GeneralAnalysisService(this.store).readCalculation(researchId, c.calculationId, state));
    const cycleState = cycles.readStateOrEmpty();
    const teamArtifacts = cycleState.artifacts.map(a => ({ registration: a, content: cycles.readArtifactJson(a.ref) }));
    const markdown = `# ${r.title}\n\n研究问题：${g.ideas.map(i => i.question).join('；')}\n\n## 来源\n${g.sources.map(s => `- ${s.filename} v${s.revision} · ${s.nature} · ${s.sha256}`).join('\n')}\n\n## 分析与审查\n${g.calculations.map(c => `- ${c.calculationId} · ${c.status} · ${c.inputNature}`).join('\n')}\n${g.reviews.map(v => `- ${v.judgment}：${v.reason}；边界：${v.applicability}`).join('\n')}\n\n## 未知与下一步\n${g.pendingQuestions.map(q => `- ${q}`).join('\n')}\n${g.reviews.flatMap(v => v.nextActions).map(q => `- ${q}`).join('\n')}\n\n任务完成和来源检查不代表科研假设成立。\n`;
    const knowledgeMarkdown = g.knowledge.filter(e => !e.archived && !g.knowledge.some(n => n.entryId === e.entryId && n.version > e.version)).map(e => `### ${e.title} v${e.version} · ${e.kind} · ${e.nature}\n${e.content}\n输入：${e.input}；输出：${e.output}；条件：${e.conditions.join('；')}\n来源：${e.sourceRefs.join('、')}；计算：${e.calculationIds.join('、')}`).join('\n\n');
    const teamMarkdown = teamArtifacts.map(a => `### Team ${a.registration.kind} · ${a.registration.producer}\n引用：${a.registration.ref.id} / ${a.registration.ref.sha256}\n\n` + '```json\n' + JSON.stringify(a.content, null, 2) + '\n```').join('\n\n');
    const summaryMarkdown = calculations.map(c => `### ${c.calculation.calculationId} · ${c.calculation.status}\n` + (c.content ? `真实统计 ${c.content.summaries.length} 项，报告预览前 200 项；完整数据保留于 JSON 包。\n\n` + '```json\n' + JSON.stringify(c.content.summaries.slice(0, 200), null, 2) + '\n```' : `未完成：${c.calculation.firstError?.message ?? '没有已登记产物'}`)).join('\n\n');
    const bundle = { schemaVersion: 1, kind: 'general_research_export', exportedAt: new Date().toISOString(), researchId, includeRaw, research: r, sources, calculations, cycleState, teamArtifacts, markdown: `${markdown}\n## 实际统计与限制\n${summaryMarkdown}\n\n## 知识与方法\n${knowledgeMarkdown}\n\n## 实际 Team 产物\n${teamMarkdown}` };
    if (Buffer.byteLength(JSON.stringify(bundle)) > 40 * 1024 * 1024) throw new BootstrapError('INVALID_INPUT', '研究包超过 40 MiB，请先导出不含原始文件的版本');
    return bundle;
  }
}
