import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { BootstrapError, type BootstrapState } from '../contracts/research-bootstrap.ts';
import { validateGeneralResearch, type GeneralResearch } from '../contracts/general-research.ts';
import { object, str, list, num, DATA_LIMITS, validateParsedMaterial } from '../contracts/general-data.ts';
import { timestamp, evidenceArtifactRef } from '../contracts/general-evidence.ts';
import { validateCycleState, type CycleState } from '../contracts/research-cycle.ts';
import { validateCalculationArtifact, validateAnalysisPlan } from '../contracts/general-analysis.ts';
import { validateGeneralReportFactPack } from '../contracts/general-report.ts';
import { validateGeneralCyclePayload } from '../contracts/general-cycle.ts';
import { ResearchBootstrapStore, requireResearch, createResearch } from './research-bootstrap-store.ts';
import { GeneralMaterialStore } from './general-material-store.ts';
import { ResearchCycleStore } from './research-cycle-store.ts';
import { assertGeneralSourceAccess } from './general-source-access.ts';
import { dictionaryHash, GeneralAnalysisService, nodeHash, generalContextHash } from './general-analysis-service.ts';
import { dependencySnapshotHash } from './general-graph-context.ts';
import { GeneralFollowupService } from './general-followup-service.ts';
import { cycleContentHash } from '../contracts/research-cycle.ts';
import { validateInferenceArtifact } from './general-inference-service.ts';

export const GENERAL_PACKAGE_LIMITS = Object.freeze({ maxBytes: 64 * 1024 * 1024, maxDecodedBytes: 40 * 1024 * 1024, maxArtifacts: 1000, maxBlobBytes: 16 * 1024 * 1024 });
type Ref = { id: string; sha256: string };
interface Blob { sha256: string; bytes: number; contentBase64: string }
export interface GeneralPortablePackage {
  schemaVersion: 1; kind: 'general_portable_package'; researchId: string; title: string; exportedAt: string;
  general: GeneralResearch; cycleState: CycleState;
  materials: { sourceId: string; raw: Blob; parsed: Blob }[];
  artifacts: { ref: Ref; blob: Blob }[];
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const blob = (bytes: Buffer): Blob => ({ sha256: hash(bytes), bytes: bytes.length, contentBase64: bytes.toString('base64') });
function decode(v: unknown, max: number): { value: Blob; bytes: Buffer } {
  const b = object(v, ['sha256', 'bytes', 'contentBase64'], 'package blob');
  const size = num(b.bytes, 'blob bytes', 0, max), encoded = str(b.contentBase64, 'blob base64', Math.ceil(max / 3) * 4);
  if (encoded.length !== Math.ceil(size / 3) * 4) throw new Error('Invalid canonical package base64');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== size || bytes.toString('base64') !== encoded || hash(bytes) !== b.sha256) throw new Error('Package blob hash/length mismatch');
  return { value: blob(bytes), bytes };
}
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
/** Find only content-addressed references; never interpret package IDs as filesystem paths. */
function refs(value: unknown, output = new Map<string, Ref>()): Map<string, Ref> {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) { for (const v of value) refs(v, output); return output; }
  const v = value as Record<string, unknown>;
  if (typeof v.id === 'string' && v.id.startsWith('artifacts/')) {
    const r = evidenceArtifactRef(v);
    if (r.id !== `artifacts/${r.sha256}.json`) throw new Error('Package artifact locator is not content-addressed');
    output.set(r.id, r);
  }
  for (const child of Object.values(v)) refs(child, output);
  return output;
}
export function validateGeneralPortablePackage(value: unknown, depth = 0): GeneralPortablePackage {
  if (depth > 3) throw new Error('Nested import archives exceed supported depth');
  if (Buffer.byteLength(JSON.stringify(value)) > GENERAL_PACKAGE_LIMITS.maxBytes) throw new Error('Portable package exceeds 64 MiB');
  const p = object(value, ['schemaVersion', 'kind', 'researchId', 'title', 'exportedAt', 'general', 'cycleState', 'materials', 'artifacts'], 'portable package');
  if (p.schemaVersion !== 1 || p.kind !== 'general_portable_package') throw new Error('Unsupported portable package schema');
  const researchId = str(p.researchId, 'researchId', 200, true), general = validateGeneralResearch(p.general), cycleState = validateCycleState(p.cycleState);
  if (cycleState.researchId !== researchId) throw new Error('Foreign cycle namespace');
  let decoded = 0;
  const materials = list(p.materials, 'package materials', 100).map(v => {
    const m = object(v, ['sourceId', 'raw', 'parsed'], 'package material'), sourceId = str(m.sourceId, 'sourceId', 200, true);
    const source = general.sources.find(s => s.sourceId === sourceId); if (!source) throw new Error('Foreign package source');
    const raw = decode(m.raw, DATA_LIMITS.maxFileBytes), parsed = decode(m.parsed, GENERAL_PACKAGE_LIMITS.maxBlobBytes); decoded += raw.bytes.length + parsed.bytes.length;
    if (raw.value.sha256 !== source.sha256 || raw.value.bytes !== source.bytes || parsed.value.sha256 !== source.parsedSha256) throw new Error('Material manifest binding mismatch');
    const content = validateParsedMaterial(json(parsed.bytes));
    if (content.parser !== source.parser || hash(Buffer.from(JSON.stringify(content))) !== parsed.value.sha256) throw new Error('Parsed schema/version binding mismatch');
    if (JSON.stringify(content.tables.map(t => ({ tableId: t.tableId, name: t.name, rowCount: t.rows.length, columnCount: t.headers.length }))) !== JSON.stringify(source.tables)) throw new Error('Parsed table manifest mismatch');
    return { sourceId, raw: raw.value, parsed: parsed.value };
  });
  if (new Set(materials.map(m => m.sourceId)).size !== materials.length || materials.length !== general.sources.length) throw new Error('Missing or duplicate materials');
  const allRefs = refs({ general, cycleState });
  const artifacts = list(p.artifacts, 'package artifacts', GENERAL_PACKAGE_LIMITS.maxArtifacts).map(v => {
    const a = object(v, ['ref', 'blob'], 'package artifact'), ref = evidenceArtifactRef(a.ref), b = decode(a.blob, GENERAL_PACKAGE_LIMITS.maxBytes);
    decoded += b.bytes.length;
    if (ref.id !== `artifacts/${ref.sha256}.json` || b.value.sha256 !== ref.sha256) throw new Error('Artifact manifest binding mismatch');
    const content = json(b.bytes) as Record<string, unknown>;
    if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('Artifact must be JSON object');
    if (content.kind !== 'general_portable_package' && b.bytes.length > GENERAL_PACKAGE_LIMITS.maxBlobBytes) throw new Error('Artifact exceeds 16 MiB');
    if (content.kind === 'descriptive_calculation') validateCalculationArtifact(content);
    if (content.kind === 'general_report_fact_pack') validateGeneralReportFactPack(content);
    if (content.researchMode === 'general' && ['proposal', 'experiment_plan', 'evidence_report', 'decision'].includes(content.kind as string)) validateGeneralCyclePayload(content.kind as 'proposal' | 'experiment_plan' | 'evidence_report' | 'decision', content);
    if (content.kind === 'general_portable_package') validateGeneralPortablePackage(content, depth + 1); else refs(content, allRefs);
    return { ref, blob: b.value };
  });
  if (decoded > GENERAL_PACKAGE_LIMITS.maxDecodedBytes) throw new Error('Decoded package exceeds 40 MiB');
  const indexed = new Map(artifacts.map(a => [a.ref.id, a]));
  if (indexed.size !== artifacts.length || indexed.size !== allRefs.size || [...allRefs].some(([id, r]) => indexed.get(id)?.ref.sha256 !== r.sha256)) throw new Error('Missing, duplicate or unreferenced package artifact');
  for (const c of general.calculations) if (c.artifact) {
    const content = validateCalculationArtifact(json(decode(indexed.get(c.artifact.id)!.blob, GENERAL_PACKAGE_LIMITS.maxBlobBytes).bytes));
    const plan = general.plans.find(p => p.planId === c.planId && p.version === c.planVersion);
    if (JSON.stringify(content.plan) !== JSON.stringify(plan) || content.startedAt !== c.startedAt || Date.parse(content.finishedAt) < Date.parse(content.startedAt) || Date.parse(content.finishedAt) > Date.parse(c.finishedAt)) throw new Error('Calculation artifact does not match registered plan/attempt');
    const source = general.sources.find(s => s.sourceId === c.input.sourceId)!, dataset = general.datasets.find(d => d.datasetId === c.input.datasetId && d.version === c.input.version)!;
    const expected = { sourceHash: source.sha256, parsedHash: source.parsedSha256, parser: source.parser, dictionaryHash: dictionaryHash(dataset), excludedRows: dataset.excludedRows, fields: dataset.fields, conditions: dataset.conditions };
    if (JSON.stringify(content.inputSnapshot) !== JSON.stringify(expected) || c.input.dictionarySha256 !== expected.dictionaryHash || content.sourceNature !== c.inputNature || content.tool.name !== c.tool.name || content.tool.version !== c.tool.version || content.tool.runtime !== c.tool.runtime) throw new Error('Calculation artifact input/tool binding mismatch');
  }
  for (const run of general.inferenceRuns) if (run.artifact) {
    const plan = general.inferencePlans.find(p => p.planId === run.planId && p.version === run.planVersion)!;
    const source = general.sources.find(s => s.sourceId === plan.dataset.sourceId)!, dataset = general.datasets.find(d => d.datasetId === plan.dataset.datasetId && d.version === plan.dataset.version)!;
    const material = materials.find(m => m.sourceId === source.sourceId)!;
    const table = validateParsedMaterial(json(decode(material.parsed, GENERAL_PACKAGE_LIMITS.maxBlobBytes).bytes)).tables.find(t => t.tableId === dataset.tableId)!;
    validateInferenceArtifact(json(decode(indexed.get(run.artifact.id)!.blob, GENERAL_PACKAGE_LIMITS.maxBlobBytes).bytes), { researchId, run, plan, source, dataset, table });
  }
  for (const a of cycleState.artifacts) validateGeneralCyclePayload(a.kind, json(decode(indexed.get(a.ref.id)!.blob, GENERAL_PACKAGE_LIMITS.maxBlobBytes).bytes));
  return { schemaVersion: 1, kind: 'general_portable_package', researchId, title: str(p.title, 'package title', 300, true), exportedAt: timestamp(p.exportedAt), general, cycleState, materials, artifacts };
}

export class GeneralPackageService {
  readonly store: ResearchBootstrapStore;
  constructor(store: ResearchBootstrapStore) { this.store = store; }
  private publications(researchId: string): ResearchCycleStore {
    if (!/^[\w-]+$/.test(researchId)) throw new BootstrapError('POLICY_DENIED', 'Invalid package namespace');
    let current = this.store.workspaceRoot;
    for (const part of ['', '.dsh', 'research', 'cycles', researchId, 'artifacts']) {
      if (part) current = path.join(current, part);
      if (fs.existsSync(current) && (fs.lstatSync(current).isSymbolicLink() || !fs.lstatSync(current).isDirectory())) throw new BootstrapError('POLICY_DENIED', 'Package storage path contains link/non-directory');
    }
    return new ResearchCycleStore(this.store.workspaceRoot, researchId);
  }
  export(researchId: string): GeneralPortablePackage {
    const state = this.store.readStateOrEmpty(), r = requireResearch(state, researchId), g = r.general;
    if (!g) throw new BootstrapError('INVALID_INPUT', 'Portable package requires generic research');
    const material = new GeneralMaterialStore(this.store.workspaceRoot), cycles = this.publications(researchId), cycleState = cycles.readStateOrEmpty();
    for (const c of g.calculations) new GeneralAnalysisService(this.store).readCalculation(researchId, c.calculationId, state);
    const materials = g.sources.map(source => { assertGeneralSourceAccess(g, source.sourceId); return { sourceId: source.sourceId, raw: blob(material.readRaw(source)), parsed: blob(Buffer.from(JSON.stringify(material.readParsed(source)))) }; });
    const needed = refs({ general: g, cycleState }), artifacts: GeneralPortablePackage['artifacts'] = [];
    for (const ref of needed.values()) {
      if (needed.size > GENERAL_PACKAGE_LIMITS.maxArtifacts) throw new Error('Too many package artifact references');
      const file = path.join(cycles.artifactsDir, `${ref.sha256}.json`), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > GENERAL_PACKAGE_LIMITS.maxBytes) throw new Error('Invalid artifact file or size');
      const bytes = cycles.readArtifact(ref); const content = json(bytes) as Record<string, unknown>; if (content.kind !== 'general_portable_package') refs(content, needed); artifacts.push({ ref, blob: blob(bytes) });
    }
    const result = validateGeneralPortablePackage({ schemaVersion: 1, kind: 'general_portable_package', researchId, title: r.title, exportedAt: new Date().toISOString(), general: g, cycleState, materials, artifacts });
    if (this.store.readStateOrEmpty().revision !== state.revision || cycles.readStateOrEmpty().revision !== cycleState.revision) throw new BootstrapError('REVISION_CONFLICT', 'Research changed while exporting package; retry from current state');
    return result;
  }
  import(input: { operationId: string; baseRevision: number; package: unknown; title: string }, identity: string) {
    const p = validateGeneralPortablePackage(input.package), title = str(input.title, 'import title', 300, true);
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, researchId: null, kind: 'import_general_portable_package', requestPayload: { package: p, title }, apply: context => {
      const now = context.now(), r = createResearch(context.state, { title, now, mint: context.mint }), g = structuredClone(p.general);
      const mapping: GeneralResearch['importedHistory'][number]['idMap'] = [];
      const mapped = (kind: typeof mapping[number]['kind'], original: string) => { const found = mapping.find(m => m.kind === kind && m.original === original); if (found) return found.current; const current = context.mint(kind); mapping.push({ kind, original, current }); return current; };
      for (const n of g.graph.nodes) mapped('node', n.nodeId);
      for (const e of g.graph.edges) mapped('edge', e.edgeId);
      for (const i of [...g.ideas, ...g.ideaHistory]) mapped('idea', i.ideaId);
      for (const s of g.sources) mapped('source', s.sourceId);
      for (const d of g.datasets) mapped('dataset', d.datasetId);
      g.graph = { revision: 1, nodes: g.graph.nodes.map(({ task: _, ...n }) => ({ ...n, nodeId: mapped('node', n.nodeId), inputs: n.inputs.map(id => { const m = mapping.find(m => m.kind === 'node' && m.original === id) ?? mapping.find(m => m.kind === 'source' && m.original === id); return m?.current ?? id; }), execution: 'not_started' })), edges: g.graph.edges.map(e => ({ ...e, edgeId: mapped('edge', e.edgeId), from: mapped('node', e.from), to: mapped('node', e.to) })) };
      g.layout = Object.fromEntries(Object.entries(g.layout).map(([id, position]) => [mapped('node', id), position]));
      g.sources = g.sources.map(s => ({ ...s, sourceId: mapped('source', s.sourceId), previousSourceId: s.previousSourceId ? mapped('source', s.previousSourceId) : null }));
      g.datasets = g.datasets.map(d => ({ ...d, datasetId: mapped('dataset', d.datasetId), sourceId: mapped('source', d.sourceId) }));
      g.ideas = g.ideas.map(i => ({ ...i, ideaId: mapped('idea', i.ideaId), sourceRefs: i.sourceRefs.map(id => mapped('source', id)) }));
      g.ideaHistory = g.ideaHistory.map(i => ({ ...i, ideaId: mapped('idea', i.ideaId), sourceRefs: i.sourceRefs.map(id => mapped('source', id)) }));
      g.revision = 1; g.profileRevision = 1; g.profileHistory = []; g.graphHistory = []; g.editHistory = { past: [], future: [] };
      g.inferencePlans = []; g.inferenceRuns = []; g.plans = []; g.calculations = []; g.reviews = []; g.nodeConfirmations = []; g.factPacks = [];
      g.metricReports = g.metricReports.flatMap(report => {
        const source = mapping.find(m => m.kind === 'source' && m.original === report.sourceId);
        if (!source) return [];
        const nodeId = report.nodeId ? mapping.find(m => m.kind === 'node' && m.original === report.nodeId)?.current ?? null : report.nodeId ?? null;
        return [{ ...report, sourceId: source.current, ...(report.nodeId !== undefined ? { nodeId, ...(report.match === 'evidenced' && !nodeId ? { match: 'pending' as const, matchReason: '导入后实验节点未对应，匹配改回待澄清。' } : {}) } : {}) }];
      });
      g.resultDecisions = (g.resultDecisions ?? []).map(decision => ({ ...decision, nodeId: decision.nodeId ? mapping.find(m => m.kind === 'node' && m.original === decision.nodeId)?.current ?? null : decision.nodeId }));
      // F04/F10：任务草稿引用的方案与来源版本不随包存活；清空并在导入历史中如实可见（旧授权不继承）。
      g.teamTaskDrafts = [];
      // F08/F10：知识条目版本链随包恢复并重映射身份；sourceRefs/calculationIds/nodeIds 指向新研究内的
      // 已映射来源/节点（计算不随包存活：条目若引用旧计算则导入时剥离该依据并在 note 风格的
      // content 尾部如实留痕，避免悬空引用；source_reported 条目缺依据则转为 unknown 保留阅读）。
      for (const e of g.knowledge) mapped('knowledge', e.entryId);
      for (const x of g.knowledgeRelations) mapped('relation', x.relationId);
      const restoredKnowledge: typeof g.knowledge = [];
      for (const e of g.knowledge) {
        const sourceRefs = e.sourceRefs.map(id => mapping.find(m => m.kind === 'source' && m.original === id)?.current).filter((id): id is string => typeof id === 'string');
        const nodeIds = e.nodeIds.map(id => mapping.find(m => m.kind === 'node' && m.original === id)?.current).filter((id): id is string => typeof id === 'string');
        const droppedCalculations = e.calculationIds.length ? [...e.calculationIds] : [];
        const claims = (e.claims ?? []).filter(c => c.locators.every(l => {
          if (l.kind === 'calculation') return false;
          if (l.kind === 'text' || l.kind === 'pdf') return mapping.some(m => m.kind === 'source' && m.original === l.sourceId);
          if (l.kind === 'table') return mapping.some(m => m.kind === 'source' && m.original === l.sourceId) && mapping.some(m => m.kind === 'dataset' && m.original === l.datasetId);
          return false;
        })).map(c => ({ ...c, locators: c.locators.map(l => {
          if (l.kind === 'text' || l.kind === 'pdf') { const m = mapping.find(m => m.kind === 'source' && m.original === l.sourceId)!; const s = g.sources.find(s => s.sourceId === m.current)!; return { ...l, sourceId: m.current, sourceSha256: s.sha256 }; }
          const sm = mapping.find(m => m.kind === 'source' && m.original === (l as { sourceId: string }).sourceId)!; const dm = mapping.find(m => m.kind === 'dataset' && m.original === (l as { datasetId: string }).datasetId)!;
          const s = g.sources.find(s => s.sourceId === sm.current)!; const d = g.datasets.find(d => d.datasetId === dm.current)!;
          return { ...l, sourceId: sm.current, sourceSha256: s.sha256, parsedSha256: s.parsedSha256, datasetId: dm.current, dictionaryHash: dictionaryHash(d) };
        }) }));
        let nature = e.nature;
        if (nature === 'source_reported' && !sourceRefs.length) nature = 'unknown';
        const suffix = droppedCalculations.length ? `\n\n[导入留痕] 原计算依据 ${droppedCalculations.join('、')} 未随包导入，已剥离；正文与来源引用保留待本地重算。` : '';
        restoredKnowledge.push({ ...e, images: (e.images ?? []).map(i => ({ ...i, sourceId: mapped('source', i.sourceId) })), sourcePins: (e.sourcePins ?? []).map(p => ({ ...p, sourceId: mapped('source', p.sourceId) })), entryId: mapped('knowledge', e.entryId), sourceRefs, nodeIds, calculationIds: [], claims, nature, content: e.content.replace(/\]\(wiki:([^)]+)\)/g, (all, id: string) => { const current = mapping.find(m => m.kind === 'knowledge' && m.original === id)?.current; return current ? '](wiki:' + current + ')' : all; }) + suffix });
      }
      g.knowledge = restoredKnowledge;
      // F08/F10：人工关系端点重映射到新条目身份；text 定位来源重映射，calculation 定位不随包存活则
      // 该关系整条不导入（避免伪造证据关系），其 relationId 仍保留映射记录以便核对。
      const restoredRelations: typeof g.knowledgeRelations = [];
      for (const x of g.knowledgeRelations) {
        const from = mapping.find(m => m.kind === 'knowledge' && m.original === x.fromEntryId)?.current;
        const to = mapping.find(m => m.kind === 'knowledge' && m.original === x.toEntryId)?.current;
        if (!from || !to) continue;
        if (x.locator?.kind === 'calculation') continue;
        let locator: typeof x.locator = x.locator;
        if (locator != null && locator.kind === 'text') {
          const textLocator = locator;
          const sm = mapping.find(m => m.kind === 'source' && m.original === textLocator.sourceId);
          if (!sm) continue;
          locator = { ...textLocator, sourceId: sm.current };
        }
        restoredRelations.push({ ...x, relationId: mapped('relation', x.relationId), fromEntryId: from, toEntryId: to, locator });
      }
      g.knowledgeRelations = restoredRelations;
      // F08/F10：图谱布局仅保留仍存在的条目坐标，并跟随新身份。
      const keptLayout: Record<string, { x: number; y: number }> = {};
      for (const [id, position] of Object.entries(g.knowledgeLayout)) {
        const current = id.startsWith('source:') ? mapping.find(m => m.kind === 'source' && m.original === id.slice(7))?.current : mapping.find(m => m.kind === 'knowledge' && m.original === id)?.current;
        if (current) keptLayout[id.startsWith('source:') ? 'source:' + current : current] = position;
      }
      g.knowledgeLayout = keptLayout;
      if (g.wiki) {
        g.wiki.tasks = []; // An imported queue is never resumed or granted old authority.
        for (const board of g.wiki.boards) for (const card of board.cards) card.entryId = mapped('knowledge', card.entryId);
      }
      g.requireHumanConfirmation = true; g.limits = { maxAttempts: 1, maxRounds: 1, deadline: null };
      g.sourceAccess = g.sources.map(s => ({ decisionId: context.mint('access'), sourceId: s.sourceId, allowed: false, reason: '导入材料待本地核对并明确授权；原工作区授权不继承。', actor: { identity, actionId: input.operationId }, createdAt: now }));
      const cycles = this.publications(r.researchId);
      // All schemas, manifests and live-state transformations are validated before writing blobs.
      const archiveRef = { id: `artifacts/${hash(Buffer.from(`${JSON.stringify(p, null, 2)}\n`))}.json`, sha256: hash(Buffer.from(`${JSON.stringify(p, null, 2)}\n`)) };
      g.importedHistory = [{ importId: context.mint('import'), originalResearchId: p.researchId, title: p.title, importedAt: now, status: 'needs_review', packageRef: archiveRef, actor: { identity, actionId: input.operationId }, idMap: mapping }];
      r.general = validateGeneralResearch(g); r.contract.goal = g.ideas[0]?.question ?? title; r.contract.researchQuestion = r.contract.goal;
      for (const m of p.materials) new GeneralMaterialStore(this.store.workspaceRoot).persist(decode(m.raw, DATA_LIMITS.maxFileBytes).bytes, validateParsedMaterial(json(decode(m.parsed, GENERAL_PACKAGE_LIMITS.maxBlobBytes).bytes)));
      // Original artifacts and jobs stay inside the read-only archive; never install old CycleState.
      const published = cycles.publishArtifact(p); if (published.sha256 !== archiveRef.sha256) throw new Error('Archive publication hash mismatch');
      context.state.activeResearchId = r.researchId;
      return { changed: true, result: { researchId: r.researchId, importId: g.importedHistory[0].importId, idMap: mapping, status: 'needs_review' } };
    } });
  }
  adoptImportedPlan(input: { operationId: string; baseRevision: number; researchId: string; importId: string; originalPlanId: string; originalVersion: number; reason: string }, identity: string) {
    const reason = str(input.reason, 'adoption reason', 4000, true);
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, researchId: input.researchId, kind: 'adopt_general_imported_plan', requestPayload: { researchId: input.researchId, importId: input.importId, originalPlanId: input.originalPlanId, originalVersion: input.originalVersion, reason }, apply: context => {
      const research = requireResearch(context.state, input.researchId), g = research.general;
      if (!g) throw new BootstrapError('INVALID_INPUT', 'Imported plan requires generic research');
      const record = g.importedHistory.find(r => r.importId === input.importId);
      if (!record) throw new BootstrapError('NOT_FOUND', 'Imported history not found');
      const p = this.readImportedHistory(input.researchId, input.importId, context.state);
      const old = p.general.plans.find(plan => plan.planId === input.originalPlanId && plan.version === input.originalVersion);
      if (!old) throw new BootstrapError('NOT_FOUND', 'Historical analysis plan/version not found');
      if (old.metricContext) throw new BootstrapError('POLICY_DENIED', '历史方案绑定指标协议；请先在当前工作区重新冻结指标协议，再通过分析方案表单重建，不能静默丢弃指标绑定。');
      const map = (kind: typeof record.idMap[number]['kind'], id: string) => { const m = record.idMap.find(m => m.kind === kind && m.original === id); if (!m) throw new BootstrapError('SOURCE_MISSING', 'Historical identity mapping missing'); return m.current; };
      const node = g.graph.nodes.find(n => n.nodeId === map('node', old.nodeId));
      if (!node || node.kind !== 'analysis') throw new BootstrapError('NOT_FOUND', 'Mapped analysis node is missing or changed kind');
      if (node.task) new GeneralFollowupService(this.store).freeze(input.researchId, node, node.task.sourceIds, context.state);
      const dataset = g.datasets.find(d => d.datasetId === map('dataset', old.dataset.datasetId) && d.version === old.dataset.version);
      const source = g.sources.find(s => s.sourceId === map('source', old.dataset.sourceId));
      if (!source || !dataset || dataset.sourceId !== source.sourceId || source.sha256 !== old.dataset.sourceSha256 || dataset.tableId !== old.dataset.tableId) throw new BootstrapError('SOURCE_STALE', 'Historical mapped material/dictionary mismatch');
      const originalDataset = p.general.datasets.find(d => d.datasetId === old.dataset.datasetId && d.version === old.dataset.version)!;
      const expected = { ...originalDataset, datasetId: dataset.datasetId, sourceId: source.sourceId };
      if (cycleContentHash('import-dictionary-v1', expected) !== cycleContentHash('import-dictionary-v1', dataset)) throw new BootstrapError('SOURCE_STALE', 'Mapped dictionary changed; rebuild the plan against current fields');
      assertGeneralSourceAccess(g, source.sourceId); new GeneralMaterialStore(this.store.workspaceRoot).readParsed(source);
      const idea = old.idea ? g.ideas.find(i => i.ideaId === map('idea', old.idea!.ideaId)) : null;
      if (old.idea && !idea) throw new BootstrapError('SOURCE_MISSING', 'Mapped Idea missing');
      const now = context.now();
      const { importedOrigin: _, metricContext: __, ...parameters } = old;
      const plan = validateAnalysisPlan({ ...parameters, planId: context.mint('analysis-plan'), version: 1, nodeId: node.nodeId, nodeSnapshotHash: nodeHash(node), nodeContext: structuredClone(node), contextHash: generalContextHash(g), dependencySnapshotHash: dependencySnapshotHash(g, node.nodeId), dataset: { datasetId: dataset.datasetId, version: dataset.version, sourceId: source.sourceId, sourceSha256: source.sha256, tableId: dataset.tableId, dictionarySha256: dictionaryHash(dataset) }, idea: idea ? { ideaId: idea.ideaId, revision: idea.revision } : null, createdAt: now, importedOrigin: { importId: record.importId, packageRef: record.packageRef, originalPlanId: old.planId, originalVersion: old.version, reason, actor: { identity, actionId: input.operationId }, adoptedAt: now } });
      g.plans.push(plan); g.revision++; research.general = validateGeneralResearch(g); research.updatedAt = now;
      return { changed: true, result: { planId: plan.planId, version: plan.version, nodeId: node.nodeId, status: 'plan_saved_not_executed' } };
    } });
  }
  readImportedHistory(researchId: string, importId: string, snapshot?: BootstrapState): GeneralPortablePackage {
    const g = requireResearch(snapshot ?? this.store.readStateOrEmpty(), researchId).general;
    const record = g?.importedHistory.find(r => r.importId === importId);
    if (!g || !record) throw new BootstrapError('NOT_FOUND', 'Imported history not found in this research');
    for (const s of g.sources) assertGeneralSourceAccess(g, s.sourceId);
    const cycles = this.publications(researchId), file = path.join(cycles.artifactsDir, `${record.packageRef.sha256}.json`), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > GENERAL_PACKAGE_LIMITS.maxBytes) throw new Error('Invalid imported archive type/size');
    const value = validateGeneralPortablePackage(json(cycles.readArtifact(record.packageRef)));
    if (value.researchId !== record.originalResearchId) throw new Error('Imported archive provenance mismatch');
    return value;
  }
}
