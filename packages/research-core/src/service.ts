import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  APPROVAL_CAPABILITIES,
  ResearchCoreError,
  validateActorContext,
  type ActorContext,
  type ApprovalCapability,
  type ApprovalRecord,
  type ResearchProjectState,
  type SourceRecord,
} from '../../research-contracts/src/index.ts';
import { readLegacyInventory } from './inventory.ts';
import { createExperimentPlan as writePlan, createResearchIdea as writeIdea, exportAssignment as writeAssignment, recordExperimentResult as writeRun, researchTree as readTree, searchPapers as writeSearch, submitResearchReview as writeReview, type IdeaWrite, type PlanWrite, type ReviewWrite, type RunWrite } from './loop.ts';
import { commitOperation, ProjectStore, requestHash, sha256File, type MutationBody, type ProjectStoreOptions } from './project-store.ts';
import { readMaterial, searchWiki, upsertKnowledge, type KnowledgeWrite } from './knowledge.ts';
import { assertInside, exportTarget, resolveResearchRoot } from './root.ts';

import { activeStore } from './active-store.ts';
import { legacyResearchAction, legacyScope } from './legacy-domain.ts';
import { readNativeExperimentProject, approveNativeExperiment, assertNativeExperimentPlan, assertNativeAssignmentApproval } from './bootstrap-loop-store.ts';

const IMPORT_LIMIT_BYTES = 5_000_000;
const MEDIA: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.png': 'image/png',
  '.log': 'text/plain',
};

export interface WriteRequest {
  workspaceDir: string;
  operationId: string;
  actor: ActorContext;
  /** Ignored when present. A payload must not be able to nominate the actor. */
  claimedActor?: unknown;
}

export interface InitRequest extends WriteRequest {
  goal: string;
  constraints?: string[];
}

export interface ImportRequest extends WriteRequest {
  filePath: string;
  baseRevision: number;
  /** Relative paths are confined to the workspace. Absolute paths are the CLI user's explicit file. */
  allowAbsolute?: boolean;
}

export interface ApproveRequest extends WriteRequest {
  baseRevision: number;
  subjectId: string;
  subjectRevision: number;
  subjectHash: string;
  capability: string;
}

export type { MutationBody };

export class ResearchCore {
  private readonly options: ProjectStoreOptions;

  constructor(options: ProjectStoreOptions = {}) {
    this.options = options;
  }

  context(workspaceDir: string): {
    rootKind: ReturnType<typeof resolveResearchRoot>['kind'];
    project: ResearchProjectState | null;
    legacy: ReturnType<typeof readLegacyInventory>;
    needsMigration: boolean;
  } {
    const root = resolveResearchRoot(workspaceDir);
    const project = activeStore(workspaceDir) ? readNativeExperimentProject(workspaceDir) : new ProjectStore(workspaceDir, this.options).read();
    return { rootKind: root.kind, project, legacy: readLegacyInventory(workspaceDir), needsMigration: activeStore(workspaceDir) ? false : new ProjectStore(workspaceDir, this.options).needsMigration() };
  }

  validate(workspaceDir: string): { projectValid: boolean; legacyValid: boolean; sourcesValid: boolean; runEvidenceValid: boolean; plansValid: boolean; issues: string[]; rootKind: string } {
    const context = this.context(workspaceDir);
    const sourceIssues: string[] = [], runIssues: string[] = [], planIssues: string[] = [];
    for (const source of context.project?.sources ?? []) {
      try {
        const file = assertInside(path.join(path.resolve(workspaceDir), '.research'), path.join(path.resolve(workspaceDir), '.research', source.relativePath));
        if (!fs.existsSync(file) || sha256File(file).sha256 !== source.sha256) sourceIssues.push(`source missing or changed: ${source.sourceId}`);
      } catch (error) { sourceIssues.push(`${source.sourceId}: ${String(error)}`); }
    }
    for (const run of context.project?.runs ?? []) {
      for (const hash of [run.manifestSha256, run.metricsSha256]) {
        const file = path.join(path.resolve(workspaceDir), '.research', 'artifacts', hash);
        if (!fs.existsSync(file) || sha256File(file).sha256 !== hash) runIssues.push(`run evidence missing or changed: ${run.runId} / ${hash}`);
      }
    }
    for (const plan of context.project?.plans ?? []) {
      try {
        if (activeStore(workspaceDir)) assertNativeExperimentPlan(workspaceDir, plan.planId);
        else {
          const { planId: _id, revision: _revision, status: _status, contentHash, updatedAt: _updatedAt, ...body } = plan;
          if (requestHash(body) !== contentHash) throw new ResearchCoreError('STATE_CORRUPT', 'Experiment plan hash mismatch');
          if (!context.project?.ideas.some(idea => idea.ideaId === plan.ideaId)) throw new ResearchCoreError('NOT_FOUND', 'Experiment plan candidate is missing');
        }
      } catch (error) { planIssues.push(`plan ${plan.planId}: ${String(error)}`); }
    }
    return {
      projectValid: context.project !== null || !resolveResearchRoot(workspaceDir).projectExists,
      legacyValid: true,
      sourcesValid: sourceIssues.length === 0,
      runEvidenceValid: runIssues.length === 0,
      plansValid: planIssues.length === 0,
      issues: [...sourceIssues, ...runIssues, ...planIssues],
      rootKind: context.rootKind,
    };
  }

  init(request: InitRequest): MutationBody<{ projectId: string }> {
    const actor = acceptActor(request);
    const goal = requiredText(request.goal, 'goal', 2000);
    const constraints = (request.constraints ?? []).map((entry, index) => requiredText(entry, `constraints[${index}]`, 300));
    const payload = { goal, constraints };
    const store = new ProjectStore(request.workspaceDir, this.options);
    return commitOperation(store, request.operationId, 'init_project', payload, (current) => {
      if (current) throw new ResearchCoreError('ALREADY_EXISTS', `project ${current.projectId} already exists`);
      const root = resolveResearchRoot(request.workspaceDir);
      const projectId = `proj-${crypto.randomUUID()}`;
      const created: ResearchProjectState = {
        schemaVersion: 1,
        projectId,
        goal,
        constraints,
        revision: 0,
        sources: [],
        approvals: [],
        receipts: [],
        knowledge: [],
        ideas: [],
        plans: [],
        assignments: [],
        runs: [],
        reviews: [],
        searches: [],
        legacyRoot: root.legacyExists ? '.dsh/research' : null,
        stateHash: '0'.repeat(64),
      };
      return { state: created, result: { projectId } };
    });
  }

  importMaterial(request: ImportRequest): MutationBody<{ sourceId: string; sha256: string; created: boolean }> {
    acceptActor(request);
    const sourceFile = resolveImportFile(request);
    const hashed = sha256File(sourceFile);
    if (hashed.bytes > IMPORT_LIMIT_BYTES) throw new ResearchCoreError('QUOTA', `import exceeds ${IMPORT_LIMIT_BYTES} bytes`);
    const extension = allowedExtension(sourceFile);
    if (activeStore(request.workspaceDir)) {
      const state = legacyScope(request.workspaceDir).store.readStateOrEmpty();
      const research = state.researches.find(r => r.researchId === state.activeResearchId);
      if (!research?.general) throw new ResearchCoreError('NOT_FOUND', 'Select a general research before importing material');
      const bytes = fs.readFileSync(sourceFile);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== hashed.sha256) throw new ResearchCoreError('STATE_CORRUPT', 'Import file changed while reading');
      const saved = legacyResearchAction(request.workspaceDir, {
        type: 'import_general_material', operationId: request.operationId, baseRevision: request.baseRevision,
        researchId: research.researchId, filename: path.basename(sourceFile), mediaType: MEDIA[extension] ?? 'application/octet-stream',
        contentBase64: bytes.toString('base64'), nature: 'unknown',
        description: 'Imported local file; evidence nature has not been classified.', purpose: 'Research input; import does not execute code or validate scientific claims.',
      }, acceptActor(request));
      if (!('sourceId' in saved.result) || typeof saved.result.sourceId !== 'string') throw new ResearchCoreError('SCHEMA_VIOLATION', 'Native material receipt is missing sourceId; inspect the committed operation before retrying');
      return { ...saved, projectId: research.researchId.replace(/^research-/, 'proj-'), result: { sourceId: saved.result.sourceId, sha256: hashed.sha256, created: true } };
    }
    const relativePath = `sources/${hashed.sha256}${extension}`;
    const payload = { sha256: hashed.sha256, bytes: hashed.bytes, relativePath };
    const store = new ProjectStore(request.workspaceDir, this.options);
    return commitOperation<{ sourceId: string; sha256: string; created: boolean }>(store, request.operationId, 'import_material', payload, (current) => {
      if (!current) throw new ResearchCoreError('NOT_FOUND', 'init a research project before importing material');
      if (request.baseRevision !== current.revision) {
        throw new ResearchCoreError('REVISION_CONFLICT', `baseRevision ${request.baseRevision} does not match revision ${current.revision}`);
      }
      const existing = current.sources.find((source) => source.sha256 === hashed.sha256);
      if (existing) return { state: current, result: { sourceId: existing.sourceId, sha256: hashed.sha256, created: false }, unchanged: true };
      const destination = assertInside(path.join(store.workspaceDir, '.research'), path.join(store.workspaceDir, '.research', relativePath));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (!fs.existsSync(destination)) fs.copyFileSync(sourceFile, destination);
      if (sha256File(destination).sha256 !== hashed.sha256) throw new ResearchCoreError('STATE_CORRUPT', 'source changed during import or stored source bytes changed');
      const source: SourceRecord = {
        filename: path.basename(sourceFile),
        sourceId: `src-${hashed.sha256.slice(0, 12)}`,
        relativePath,
        sha256: hashed.sha256,
        bytes: hashed.bytes,
        mediaType: MEDIA[extension] ?? 'application/octet-stream',
        importedAt: store.now(),
      };
      current.sources.push(source);
      return { state: current, result: { sourceId: source.sourceId, sha256: source.sha256, created: true } };
    });
  }

  approve(request: ApproveRequest): MutationBody<{ approvalId: string }> {
    if (activeStore(request.workspaceDir)) return approveNativeExperiment(request);
    const actor = acceptActor(request);
    if (actor.kind !== 'user' || actor.source === 'mcp') throw new ResearchCoreError('INVALID_INPUT', 'approval requires a trusted user channel');
    void request.claimedActor;
    const capability = request.capability;
    if (!(APPROVAL_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new ResearchCoreError('SCHEMA_VIOLATION', 'capability is not allowed');
    }
    if (!/^[0-9a-f]{64}$/.test(request.subjectHash)) throw new ResearchCoreError('SCHEMA_VIOLATION', 'subjectHash must be a sha256');
    const subjectId = requiredText(request.subjectId, 'subjectId', 200);
    if (!Number.isSafeInteger(request.subjectRevision) || request.subjectRevision < 0) {
      throw new ResearchCoreError('SCHEMA_VIOLATION', 'subjectRevision must be a non-negative integer');
    }
    const payload = { subjectId, subjectRevision: request.subjectRevision, subjectHash: request.subjectHash, capability };
    const store = new ProjectStore(request.workspaceDir, this.options);
    return commitOperation(store, request.operationId, 'record_approval', payload, (current) => {
      if (!current) throw new ResearchCoreError('NOT_FOUND', 'init a research project before recording an approval');
      if (request.baseRevision !== current.revision) {
        throw new ResearchCoreError('REVISION_CONFLICT', `baseRevision ${request.baseRevision} does not match revision ${current.revision}`);
      }
      const subject = capability === 'select_idea' ? current.ideas.find((i) => i.ideaId === subjectId)
        : capability === 'export_assignment' ? current.plans.find((p) => p.planId === subjectId)
        : current.reviews.find((r) => r.reviewId === subjectId);
      if (!subject) throw new ResearchCoreError('NOT_FOUND', 'approval subject is not in this project');
      const subjectHash = 'contentHash' in subject ? subject.contentHash : requestHash(subject);
      const subjectRevision = 'revision' in subject ? subject.revision : 1;
      if (request.subjectHash !== subjectHash || request.subjectRevision !== subjectRevision) throw new ResearchCoreError('REVISION_CONFLICT', 'approval is not bound to the current subject');
      if (capability === 'select_idea' && 'status' in subject) {
        for (const idea of current.ideas) idea.status = idea.ideaId === subjectId ? 'selected' : 'candidate';
      }
      const approval: ApprovalRecord = {
        approvalId: `apr-${crypto.randomUUID()}`,
        projectId: current.projectId,
        subjectId,
        subjectRevision: request.subjectRevision,
        subjectHash: request.subjectHash,
        capability: capability as ApprovalCapability,
        actorId: actor.actorId,
        actorKind: actor.kind,
        actorSource: actor.source,
        createdAt: store.now(),
      };
      current.approvals.push(approval);
      return { state: current, result: { approvalId: approval.approvalId } };
    });
  }

  migrate(workspaceDir: string, actor: ActorContext) {
    if (validateActorContext(actor).kind !== 'user' || actor.source === 'mcp') throw new ResearchCoreError('INVALID_INPUT', 'migration requires a trusted user channel');
    return new ProjectStore(workspaceDir, this.options).migrate();
  }

  readMaterial(workspaceDir: string, sourceId: string) { return readMaterial(this.options, workspaceDir, sourceId); }
  searchWiki(workspaceDir: string, query = '', offset = 0, limit = 30) { return searchWiki(this.options, workspaceDir, query, offset, limit); }
  upsertKnowledge(request: KnowledgeWrite) { return upsertKnowledge(this.options, request); }

  exportView(workspaceDir: string, outPath: string): { outPath: string; bytes: number } {
    const root = resolveResearchRoot(workspaceDir);
    const target = exportTarget(workspaceDir, outPath);
    const researchDir = path.resolve(root.researchDir);
    const legacyDir = path.resolve(root.legacyDir);
    for (const forbidden of [researchDir, legacyDir]) {
      const relative = path.relative(forbidden, target);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        throw new ResearchCoreError('PATH_ESCAPE', 'export cannot overwrite research state');
      }
    }
    const view = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      note: 'This file is a view. Authoritative state stays in .research/project.json and, until migrated, .dsh/research/bootstrap/state.json.',
      ...this.context(workspaceDir),
    };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const body = `${JSON.stringify(view, null, 2)}\n`;
    fs.writeFileSync(target, body);
    return { outPath: target, bytes: Buffer.byteLength(body) };
  }

  createIdea(request: IdeaWrite): ReturnType<typeof writeIdea> {
    return writeIdea(this.options, request);
  }

  createPlan(request: PlanWrite): ReturnType<typeof writePlan> {
    return writePlan(this.options, request);
  }

  exportAssignment(request: WriteRequest & { baseRevision: number; planId: string; outPath?: string }): ReturnType<typeof writeAssignment> {
    const saved = writeAssignment(this.options, { ...request, outPath: undefined });
    if (request.outPath) this.exportAssignmentBundle(request.workspaceDir, saved.result.assignmentId, request.outPath);
    return saved;
  }

  assignmentBundle(workspaceDir: string, assignmentId: string) {
    const project = this.context(workspaceDir).project;
    const assignment = project?.assignments.find((a) => a.assignmentId === assignmentId);
    const plan = project?.plans.find((p) => p.planId === assignment?.planId);
    const idea = project?.ideas.find((i) => i.ideaId === plan?.ideaId);
    if (!project || !assignment || !plan || !idea) throw new ResearchCoreError('NOT_FOUND', 'assignment inputs are missing');
    if (plan.contentHash !== assignment.planHash || plan.revision !== assignment.planRevision) throw new ResearchCoreError('REVISION_CONFLICT', 'assignment plan is stale');
    const native = activeStore(workspaceDir) ? assertNativeExperimentPlan(workspaceDir, plan.planId) : null;
    if (native) assertNativeAssignmentApproval(workspaceDir, plan.planId);
    const sources = idea.sourceIds.map((id) => this.readMaterial(workspaceDir, id));
    return { schemaVersion: 1, projectId: project.projectId, goal: project.goal, constraints: project.constraints, assignment, idea, plan, sources, ...(native ? { authority: 'bootstrap', sourcePins: native.pin, nativeIdea: native.research.general!.ideas.find(i => i.ideaId === idea.ideaId) } : {}),
      instructions: ['在用户授权的外部环境中执行；本包不授予额外执行权限。', '提交 patch/commit、环境信息、run-manifest 和原始指标文件。', '失败保留首错，缺失指标为 null；模拟必须 recordKind=mock。', '单 Agent 流程按 self_review 标识。'],
      manifestTemplate: { runId: null, assignmentId, planId: plan.planId, planRevision: plan.revision, planHash: plan.contentHash, execution: 'unknown', recordKind: 'external_reported', split: plan.split, configHash: null, metricsFile: null, failureQuote: null, metrics: [{ name: plan.metric, unit: plan.metricUnit, value: null, row: null, column: null }] },
      templateNote: 'null 是待填写字段；模板不是有效运行记录，不能直接作为实验结果导入。' };
  }

  private exportAssignmentBundle(workspaceDir: string, assignmentId: string, outPath: string) {
    const root = resolveResearchRoot(workspaceDir);
    const target = exportTarget(workspaceDir, outPath);
    for (const forbidden of [root.researchDir, root.legacyDir]) {
      const relative = path.relative(forbidden, target);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new ResearchCoreError('PATH_ESCAPE', 'export cannot overwrite research state');
    }
    const bundle = this.assignmentBundle(workspaceDir, assignmentId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(bundle, null, 2)}\n`);
  }

  recordRun(request: RunWrite): ReturnType<typeof writeRun> {
    return writeRun(this.options, request);
  }

  submitReview(request: ReviewWrite): ReturnType<typeof writeReview> {
    return writeReview(this.options, request);
  }

  searchPapers(request: WriteRequest & { baseRevision: number; query: string }): ReturnType<typeof writeSearch> {
    return writeSearch(this.options, request);
  }

  tree(workspaceDir: string): ReturnType<typeof readTree> {
    return readTree(this.options, workspaceDir);
  }
}

function acceptActor(request: WriteRequest): ActorContext {
  return validateActorContext(request.actor);
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new ResearchCoreError('INVALID_INPUT', `${label} must be non-empty text of at most ${max} characters`);
  }
  return value;
}

function resolveImportFile(request: ImportRequest): string {
  if (typeof request.filePath !== 'string' || request.filePath.trim().length === 0) {
    throw new ResearchCoreError('INVALID_INPUT', 'filePath is required');
  }
  if (request.filePath.includes('\0')) throw new ResearchCoreError('PATH_ESCAPE', 'filePath contains a null byte');
  const workspace = path.resolve(request.workspaceDir);
  const absolute = path.isAbsolute(request.filePath);
  if (absolute && request.allowAbsolute !== true) throw new ResearchCoreError('PATH_ESCAPE', 'absolute import paths require an explicit CLI user file');
  const requested = absolute ? path.resolve(request.filePath) : path.resolve(workspace, request.filePath);
  if (!absolute) {
    const relative = path.relative(workspace, requested);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ResearchCoreError('PATH_ESCAPE', 'relative import leaves the workspace');
  }
  if (!fs.existsSync(requested)) throw new ResearchCoreError('NOT_FOUND', 'import file does not exist');
  const real = fs.realpathSync(requested);
  if (!absolute) {
    const relative = path.relative(fs.realpathSync(workspace), real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ResearchCoreError('PATH_ESCAPE', 'import symlink leaves the workspace');
  }
  if (!fs.statSync(real).isFile()) throw new ResearchCoreError('INVALID_INPUT', 'import target must be a file');
  return real;
}

function allowedExtension(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return Object.prototype.hasOwnProperty.call(MEDIA, extension) ? extension : '.bin';
}
