import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ProjectStore, requestHash } from './project-store.ts';
import { assertInside } from './root.ts';
import { activeStore, migrationInventory } from './active-store.ts';
import { ResearchCoreError, validateResearchProjectState, type ResearchProjectState } from '../../research-contracts/src/index.ts';
import { emptyBootstrapState, validateBootstrapState } from '../../evolver/src/contracts/research-bootstrap.ts';
import { createResearch, ResearchBootstrapStore } from '../../evolver/src/application/research-bootstrap-store.ts';
import { assertGeneralSourceAccess } from '../../evolver/src/application/general-source-access.ts';
import { createGeneralResearch } from '../../evolver/src/contracts/general-research.ts';
import { GeneralMaterialStore } from '../../evolver/src/application/general-material-store.ts';
import { parseTextMaterial } from '../../evolver/src/application/general-material-parser.ts';
import { initialFields } from '../../evolver/src/application/general-data-service.ts';
import type { GeneralNode } from '../../evolver/src/contracts/general-workflow.ts';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const mint = (prefix: string) => `${prefix}-${randomUUID()}`;
const warnings = ['来源性质未知，全部需重新授权；批准、已选方向与节点确认不继承。', 'Wiki 保留条目 ID 和版本；候选为当前草稿，原 revision/status 与引用逐字保存在只读历史。', '计划、交接、运行、self_review 映射为待核对 DAG 节点；原始结构和文件完整归档，不转为人工审查或当前执行结果。'];

function project(workspace: string) {
  const value = new ProjectStore(workspace).read();
  if (!value) throw new ResearchCoreError('NOT_FOUND', 'prototype project.json missing');
  return value;
}

/** Pure projection: never invent missing idea revisions or carry historical authority. */
function projectBootstrap(p: ResearchProjectState, sourceRoot: string) {
  const now = new Date().toISOString(), state = emptyBootstrapState();
  const research = createResearch(state, { title: p.goal.slice(0, 300), now, mint });
  research.researchId = p.projectId;
  state.activeResearchId = p.projectId;
  const g = createGeneralResearch({ question: p.goal, domains: [], methods: ['algorithm'], entryMode: 'idea_only', now, mint });
  g.constraints = p.constraints;
  g.pendingQuestions = [...warnings];
  for (const s of p.sources) {
    const sourceFile = assertInside(sourceRoot, path.join(sourceRoot, s.relativePath));
    assertInside(fs.realpathSync(sourceRoot), fs.realpathSync(sourceFile));
    const filename = s.filename ?? path.basename(s.relativePath), parsed = parseTextMaterial(filename, fs.readFileSync(sourceFile));
    g.sources.push({ sourceId: s.sourceId, revision: 1, previousSourceId: null, filename, mediaType: s.mediaType, sha256: s.sha256, bytes: s.bytes, nature: 'unknown', description: '早期轻量项目迁移；来源性质需核对', purpose: '保留原资料与引用', acquiredAt: s.importedAt, parser: parsed.parser, parsedSha256: hash(JSON.stringify(parsed)), parseStatus: parsed.error ? parsed.error.code === 'ATTACHMENT_ONLY' ? 'attachment' : 'failed' : 'parsed', firstError: parsed.error, tables: parsed.tables.map((t) => ({ tableId: t.tableId, name: t.name, rowCount: t.rows.length, columnCount: t.headers.length })) });
    for (const t of parsed.tables) g.datasets.push({ datasetId: mint('dataset'), version: 1, sourceId: s.sourceId, sourceSha256: s.sha256, tableId: t.tableId, fields: initialFields(t), conditions: [], excludedRows: [], processingReason: '', createdAt: now });
  }
  g.ideas = p.ideas.map((i) => ({ ideaId: i.ideaId, revision: 1, question: i.hypothesis, rationale: `${i.title}\n${i.mechanism}`, verificationPlan: `${i.change}\n反证条件：${i.falsifier}`, sourceRefs: i.sourceIds, nature: 'hypothesis', updatedAt: i.updatedAt }));
  g.knowledge = p.knowledge.map((k) => ({ entryId: k.cardId, version: k.revision, kind: k.kind === 'method' ? 'method' : 'wiki', title: k.title, category: k.kind,
    content: k.body, nature: 'unknown', sourceRefs: k.sourceIds, sourcePins: k.sourceIds.map((id) => ({ sourceId: id, sha256: p.sources.find((s) => s.sourceId === id)!.sha256 })),
    calculationIds: [], nodeIds: [], input: '', output: '', conditions: [], limitations: k.unknowns, parameters: [], operation: 'external_not_connected', archived: false, createdAt: k.updatedAt }));
  const node = (nodeId: string, title: string, kind: GeneralNode['kind'], detail: string): GeneralNode => ({ nodeId, title: title.slice(0, 300), kind, goal: '核对迁移历史；尚未取得当前工作区执行或科学判断', inputs: [], method: detail, output: '完整原记录见只读迁移历史', completionCriterion: '重新确认输入、协议、来源权限和产物后另行执行/审查', join: 'all', execution: 'not_started' });
  const historical = [
    ...p.ideas.map((x) => node(x.ideaId, `历史候选：${x.title}`, 'goal', x.hypothesis)),
    ...p.plans.map((x) => node(x.planId, `历史计划 v${x.revision}：${x.variable}`, 'protocol', `variable=${x.variable}; baseline=${x.baseline}; split=${x.split}; metric=${x.metric} (${x.metricUnit}); ${x.stopCondition}`)),
    ...p.assignments.map((x) => node(x.assignmentId, '历史外部交接（self_review）', 'manual', `plan=${x.planId}@${x.planRevision}; ${x.planHash}`)),
    ...p.runs.map((x) => node(x.runId, `历史运行：${x.recordKind} / ${x.execution}`, 'analysis', `attestation=${x.attestation}; freshness=${x.freshness}; manifest=${x.manifestSha256}; metrics=${x.metricsSha256}`)),
    ...p.reviews.map((x) => node(x.reviewId, `历史 self_review：${x.judgment}`, 'review', x.reason)),
  ];
  g.graph.nodes.push(...historical);
  const depends = (from: string, to: string) => g.graph.edges.push({ edgeId: mint('edge'), from, to, kind: 'derived_from', condition: null });
  for (const x of p.plans) depends(x.planId, x.ideaId);
  for (const x of p.assignments) depends(x.assignmentId, x.planId);
  for (const x of p.runs) depends(x.runId, x.assignmentId);
  for (const x of p.reviews) for (const id of x.runIds) depends(x.reviewId, id);
  g.layout = Object.fromEntries(g.graph.nodes.map((n, i) => [n.nodeId, { x: 50 + (i % 6) * 270, y: 170 + Math.floor(i / 6) * 180 }]));
  research.general = g;
  state.revision = 1;
  return { state, g, research, now };
}

export function prototypeMigrationPreview(workspace: string) {
  if (activeStore(workspace)) throw new ResearchCoreError('ALREADY_EXISTS', 'workspace already has an active store');
  if (fs.existsSync(path.join(workspace, '.dsh/research/bootstrap/state.json'))) throw new ResearchCoreError('INVALID_INPUT', 'both prototype and DSH assets exist; choose a merge strategy before migrating');
  if (fs.existsSync(path.join(workspace, '.research/compat'))) throw new ResearchCoreError('ALREADY_EXISTS', 'compat directory already exists; explicit recovery required');
  const p = project(workspace), root = path.join(workspace, '.research'), files = migrationInventory(root), issues: string[] = [];
  const file = (name: string) => files.find((f) => f.file === name);
  for (const s of p.sources) if (file(s.relativePath)?.sha256 !== s.sha256 || file(s.relativePath)?.bytes !== s.bytes) issues.push(`source ${s.sourceId}: missing/corrupt bytes`);
  for (const r of p.runs) for (const digest of [r.manifestSha256, r.metricsSha256]) if (file(`artifacts/${digest}`)?.sha256 !== digest) issues.push(`run ${r.runId}: missing/corrupt artifact ${digest}`);
  if (file('project.json')?.sha256 !== hash(fs.readFileSync(path.join(root, 'project.json'))) || project(workspace).stateHash !== p.stateHash) throw new ResearchCoreError('REVISION_CONFLICT', 'prototype changed during preview');
  // Validate the full destination, including source/card/idea references, without writing.
  try { if (!issues.length) validateBootstrapState(projectBootstrap(p, root).state); }
  catch (error) { issues.push(`destination: ${String(error)}`); }
  return { schemaVersion: 1, kind: 'prototype', source: '.research', sourceRevision: p.revision, sourceStateHash: p.stateHash, sourceInventoryHash: hash(JSON.stringify(files)),
    referencesValid: issues.length === 0, issues, files, objects: { researches: 1, sources: p.sources.length, knowledgeVersions: p.knowledge.length, ideas: p.ideas.length, plans: p.plans.length, assignments: p.assignments.length, runs: p.runs.length, reviews: p.reviews.length }, warnings };
}

export function migratePrototypeWorkspace(workspace: string, expectedHash: string) {
  prototypeMigrationPreview(workspace);
  const source = path.join(workspace, '.research'), lock = path.join(source, '.writer.lock');
  let fd: number;
  try { fd = fs.openSync(lock, 'wx'); } catch (error) { throw new ResearchCoreError('HOST_BUSY', `prototype migration cannot acquire source lock: ${String(error)}`); }
  const migrationId = `migration-${randomUUID()}`, stage = path.join(workspace, `.${migrationId}`);
  fs.writeFileSync(fd, JSON.stringify({ token: migrationId, pid: process.pid }));
  try {
    const before = prototypeMigrationPreview(workspace);
    if (before.sourceInventoryHash !== expectedHash) throw new ResearchCoreError('REVISION_CONFLICT', 'prototype changed since preview');
    if (!before.referencesValid) throw new ResearchCoreError('STATE_CORRUPT', before.issues.join('; '));
    fs.mkdirSync(stage);
    for (const entry of before.files) {
      const target = path.join(stage, 'prototype-original', entry.file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(source, entry.file), target, fs.constants.COPYFILE_EXCL);
      if (hash(fs.readFileSync(target)) !== entry.sha256) throw new ResearchCoreError('STATE_CORRUPT', `copy changed: ${entry.file}`);
    }
    const p = project(workspace), { state, g, now } = projectBootstrap(p, path.join(stage, 'prototype-original')), materials = new GeneralMaterialStore(stage);
    for (const s of p.sources) {
      const bytes = fs.readFileSync(path.join(stage, 'prototype-original', s.relativePath)), filename = s.filename ?? path.basename(s.relativePath), parsed = parseTextMaterial(filename, bytes), persisted = materials.persist(bytes, parsed);
      if (persisted.parsedSha256 !== g.sources.find((x) => x.sourceId === s.sourceId)!.parsedSha256) throw new ResearchCoreError('STATE_CORRUPT', 'parsed material changed during migration');
      g.sourceAccess.push({ decisionId: mint('access'), sourceId: s.sourceId, allowed: false, reason: warnings[0], actor: { identity: 'migration', actionId: migrationId }, createdAt: now });
    }
    const checked = validateBootstrapState(state), bootstrapFile = path.join(stage, '.dsh/research/bootstrap/state.json');
    fs.mkdirSync(path.dirname(bootstrapFile), { recursive: true }); fs.writeFileSync(bootstrapFile, JSON.stringify(checked, null, 2) + '\n', { flag: 'wx' });
    const destinationFiles = migrationInventory(stage);
    fs.writeFileSync(path.join(stage, 'migration-manifest.json'), JSON.stringify({ migrationId, ...before, projectId: p.projectId, destinationRevision: checked.revision, permissionsInherited: false, destinationFiles, destinationInventoryHash: hash(JSON.stringify(destinationFiles)) }, null, 2));
    if (prototypeMigrationPreview(workspace).sourceInventoryHash !== expectedHash) throw new ResearchCoreError('REVISION_CONFLICT', 'prototype changed during migration; staged files retained');
    fs.renameSync(stage, path.join(source, 'compat'));
    fs.writeFileSync(path.join(source, 'active-store.json'), JSON.stringify({ schemaVersion: 1, kind: 'bootstrap', root: '.research/compat', migrationId, sourceInventoryHash: expectedHash }, null, 2), { flag: 'wx' });
    return { migrationId, sourceInventoryHash: expectedHash, destinationRevision: checked.revision, researchId: p.projectId, sourcePreserved: true };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

/** Historical approvals are returned only as history, never fed to action authorization. */
export function readPrototypeHistory(workspace: string) {
  const selected = activeStore(workspace);
  if (!selected?.migrationId) throw new ResearchCoreError('NOT_FOUND', 'no migrated prototype history');
  const root = path.join(workspace, selected.root), manifest = JSON.parse(fs.readFileSync(path.join(root, 'migration-manifest.json'), 'utf8'));
  if (manifest.kind !== 'prototype' || manifest.sourceInventoryHash !== selected.sourceInventoryHash || hash(JSON.stringify(manifest.files)) !== selected.sourceInventoryHash) throw new ResearchCoreError('STATE_CORRUPT', 'prototype history inventory changed');
  const state = new ResearchBootstrapStore(workspace).readStateOrEmpty();
  // Full history contains original quotations. Match portable-package history's
  // rule: revoked material must not be readable through an archive side door.
  const research = state.researches.find((r) => r.researchId === manifest.projectId);
  const general = research?.general;
  if (!general) throw new ResearchCoreError('STATE_CORRUPT', 'migrated research missing');
  for (const source of general.sources) assertGeneralSourceAccess(general, source.sourceId);
  const files = migrationInventory(path.join(root, 'prototype-original'));
  if (hash(JSON.stringify(files)) !== selected.sourceInventoryHash) throw new ResearchCoreError('STATE_CORRUPT', 'prototype historical bytes changed');
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'prototype-original/project.json'), 'utf8'));
  const p = validateResearchProjectState(Object.hasOwn(raw, 'stateHash') ? raw : { ...raw, stateHash: manifest.sourceStateHash });
  const { stateHash, ...payload } = p;
  if (p.projectId !== manifest.projectId || requestHash(payload) !== stateHash || stateHash !== manifest.sourceStateHash) throw new ResearchCoreError('STATE_CORRUPT', 'prototype history stateHash changed');
  return { authority: 'historical_read_only', permissionsInherited: false, project: p, warnings, files };
}
