import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ResearchCoreError,
  validateActorContext,
  type ActorContext,
  type AssignmentRecord,
  type ExperimentPlanRecord,
  type ExperimentRunRecord,
  type ResearchProjectState,
  type ReviewRecord,
} from '../../research-contracts/src/index.ts';
import { checkMetricTable, type MetricClaim } from './metrics.ts';
import { commitOperation, ProjectStore, requestHash, sha256File, type MutationBody, type ProjectStoreOptions } from './project-store.ts';
import { assertInside, exportTarget, resolveResearchRoot } from './root.ts';
import { readMaterial } from './knowledge.ts';
import { experimentStore, commitExperiment, BootstrapLoopStore } from './bootstrap-loop-store.ts';

interface Write {
  workspaceDir: string;
  operationId: string;
  actor: ActorContext;
  baseRevision: number;
  claimedActor?: unknown;
}

export interface IdeaWrite extends Write {
  title: string;
  hypothesis: string;
  change: string;
  mechanism: string;
  falsifier: string;
  sourceIds: string[];
}

export interface PlanWrite extends Write {
  ideaId: string;
  baseline: string;
  variable: string;
  fixedConditions: string[];
  split: string;
  seedPolicy: string;
  metric: string;
  metricUnit: string;
  budget: string;
  stopCondition: string;
}

export interface RunWrite extends Write {
  manifestPath: string;
}

export interface ReviewWrite extends Write {
  runIds: string[];
  judgment: ReviewRecord['judgment'];
  reason: string;
  nextStep: string;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new ResearchCoreError('INVALID_INPUT', `${label} must be non-empty text of at most ${max} characters`);
  }
  return value;
}

function projectOf(current: ResearchProjectState | null): ResearchProjectState {
  if (!current) throw new ResearchCoreError('NOT_FOUND', 'init a research project first');
  return current;
}

function sameRevision(current: ResearchProjectState, baseRevision: number): void {
  if (baseRevision !== current.revision) {
    throw new ResearchCoreError('REVISION_CONFLICT', `baseRevision ${baseRevision} does not match revision ${current.revision}`);
  }
}

function planHash(input: Omit<ExperimentPlanRecord, 'planId' | 'revision' | 'status' | 'contentHash' | 'updatedAt'>): string {
  return requestHash(input);
}

export function createResearchIdea(options: ProjectStoreOptions, request: IdeaWrite): MutationBody<{ ideaId: string }> {
  validateActorContext(request.actor);
  void request.claimedActor;
  const sourceIds = request.sourceIds.map((entry, index) => text(entry, `sourceIds[${index}]`, 80));
  if (!sourceIds.length) throw new ResearchCoreError('INVALID_INPUT', 'an idea requires a source');
  const payload = {
    title: text(request.title, 'title', 300),
    hypothesis: text(request.hypothesis, 'hypothesis', 2000),
    change: text(request.change, 'change', 2000),
    mechanism: text(request.mechanism, 'mechanism', 2000),
    falsifier: text(request.falsifier, 'falsifier', 2000),
    sourceIds,
  };
  const store = new ProjectStore(request.workspaceDir, options);
  return commitOperation(store, request.operationId, 'create_idea', payload, (current) => {
    const project = projectOf(current);
    sameRevision(project, request.baseRevision);
    for (const sourceId of sourceIds) {
      if (!project.sources.some((source) => source.sourceId === sourceId)) throw new ResearchCoreError('NOT_FOUND', `source ${sourceId} is not in this project`);
    }
    const ideaId = `idea-${crypto.randomUUID()}`;
    project.ideas.push({ ideaId, revision: 1, ...payload, status: 'candidate', updatedAt: store.now() });
    return { state: project, result: { ideaId } };
  });
}

export function createExperimentPlan(options: ProjectStoreOptions, request: PlanWrite): MutationBody<{ planId: string; contentHash: string }> {
  validateActorContext(request.actor);
  void request.claimedActor;
  const body = {
    ideaId: text(request.ideaId, 'ideaId', 80),
    baseline: text(request.baseline, 'baseline', 500),
    variable: text(request.variable, 'variable', 500),
    fixedConditions: request.fixedConditions.map((entry, index) => text(entry, `fixedConditions[${index}]`, 300)),
    split: text(request.split, 'split', 200),
    seedPolicy: text(request.seedPolicy, 'seedPolicy', 200),
    metric: text(request.metric, 'metric', 200),
    metricUnit: text(request.metricUnit, 'metricUnit', 80),
    budget: text(request.budget, 'budget', 200),
    stopCondition: text(request.stopCondition, 'stopCondition', 500),
  };
  const contentHash = planHash(body);
  const store = experimentStore(request.workspaceDir, options);
  return commitExperiment(store, request, 'create_plan', body, (current) => {
    const project = projectOf(current);
    sameRevision(project, request.baseRevision);
    if (!project.ideas.some((idea) => idea.ideaId === body.ideaId)) throw new ResearchCoreError('NOT_FOUND', 'plan idea is not in this project');
    const planId = `plan-${crypto.randomUUID()}`;
    const plan: ExperimentPlanRecord = { planId, revision: 1, ...body, status: 'draft', contentHash, updatedAt: store.now() };
    project.plans.push(plan);
    return { state: project, result: { planId, contentHash } };
  });
}

export function exportAssignment(options: ProjectStoreOptions, request: Write & { planId: string; outPath?: string }): MutationBody<{ assignmentId: string; planHash: string }> {
  validateActorContext(request.actor);
  void request.claimedActor;
  const planId = text(request.planId, 'planId', 80);
  const store = experimentStore(request.workspaceDir, options);
  const saved = commitExperiment(store, request, 'export_assignment', { planId }, (current) => {
    const project = projectOf(current);
    sameRevision(project, request.baseRevision);
    const plan = project.plans.find((entry) => entry.planId === planId);
    if (!plan) throw new ResearchCoreError('NOT_FOUND', 'plan is not in this project');
    const approved = project.approvals.some((approval) => approval.capability === 'export_assignment' && approval.subjectId === plan.planId && approval.subjectRevision === plan.revision && approval.subjectHash === plan.contentHash && approval.actorKind === 'user');
    if (!approved) throw new ResearchCoreError('INVALID_INPUT', 'export requires a user approval bound to this plan hash');
    const existing = project.assignments.find((entry) => entry.planId === plan.planId && entry.planHash === plan.contentHash);
    if (existing) return { state: project, result: { assignmentId: existing.assignmentId, planHash: existing.planHash }, unchanged: true };
    const assignment: AssignmentRecord = {
      assignmentId: `asg-${crypto.randomUUID()}`,
      planId: plan.planId,
      planRevision: plan.revision,
      planHash: plan.contentHash,
      role: 'engineer',
      reviewMode: 'self_review',
      status: 'prepared',
      expectedOutputs: ['patch', 'run-manifest', 'validation-report'],
      createdAt: store.now(),
    };
    project.assignments.push(assignment);
    return { state: project, result: { assignmentId: assignment.assignmentId, planHash: assignment.planHash } };
  });
  if (request.outPath) writeView(request.workspaceDir, request.outPath, saved.result);
  return saved;
}

export function recordExperimentResult(options: ProjectStoreOptions, request: RunWrite): MutationBody<{ runId: string; created: boolean }> {
  validateActorContext(request.actor);
  void request.claimedActor;
  const manifestFile = workspaceFile(request.workspaceDir, request.manifestPath);
  const manifest = readManifest(manifestFile);
  const metricsFile = workspaceFile(request.workspaceDir, manifest.metricsFile);
  const manifestHash = sha256File(manifestFile);
  const metricsHash = sha256File(metricsFile);
  const metricsText = fs.readFileSync(metricsFile, 'utf8');
  const checked = checkMetricTable(metricsText, manifest.metrics, manifest.runId, manifest.failureQuote);
  const payload = { runId: manifest.runId, assignmentId: manifest.assignmentId, manifestSha256: manifestHash.sha256, metricsSha256: metricsHash.sha256, recordKind: manifest.recordKind };
  const store = experimentStore(request.workspaceDir, options);
  return commitExperiment<{ runId: string; created: boolean }>(store, request, 'record_run', payload, (current) => {
    const project = projectOf(current);
    sameRevision(project, request.baseRevision);
    const assignment = project.assignments.find((entry) => entry.assignmentId === manifest.assignmentId);
    if (!assignment) throw new ResearchCoreError('NOT_FOUND', 'assignment is not in this project');
    if (assignment.planId !== manifest.planId || assignment.planRevision !== manifest.planRevision || assignment.planHash !== manifest.planHash) {
      throw new ResearchCoreError('INVALID_INPUT', 'manifest is not pinned to the exported assignment');
    }
    const same = project.runs.find((run) => run.runId === manifest.runId);
    if (same && (same.manifestSha256 !== manifestHash.sha256 || same.metricsSha256 !== metricsHash.sha256)) throw new ResearchCoreError('ALREADY_EXISTS', `run ${manifest.runId} already records different files`);
    const plan = project.plans.find((entry) => entry.planId === assignment.planId);
    if (!plan || (store instanceof BootstrapLoopStore && manifest.split !== plan.split) || manifest.metrics.some((metric) => metric.name !== plan.metric || metric.unit !== plan.metricUnit)) {
      throw new ResearchCoreError('INVALID_INPUT', 'manifest metrics do not match the pinned plan metric and unit');
    }
    const artifactDir = resultArtifactDirectory(store.workspaceDir, true);
    // Keep the evidence bytes: a hash alone cannot recover an external file later.
    for (const [file, hash] of [[manifestFile, manifestHash.sha256], [metricsFile, metricsHash.sha256]]) {
      const destination = path.join(artifactDir, hash);
      if (fs.existsSync(destination)) {
        if (fs.lstatSync(destination).isSymbolicLink() || !fs.lstatSync(destination).isFile()) throw new ResearchCoreError('PATH_ESCAPE', 'Result artifact must be a regular file');
        if (sha256File(destination).sha256 !== hash) throw new ResearchCoreError('STATE_CORRUPT', 'stored result artifact hash changed');
      } else fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
      if (sha256File(destination).sha256 !== hash) throw new ResearchCoreError('STATE_CORRUPT', 'result file changed during import');
    }
    if (same) return { state: project, result: { runId: same.runId, created: false }, unchanged: true };
    const run: ExperimentRunRecord = {
      runId: manifest.runId,
      planId: assignment.planId,
      planRevision: assignment.planRevision,
      planHash: assignment.planHash,
      assignmentId: assignment.assignmentId,
      manifestSha256: manifestHash.sha256,
      metricsSha256: metricsHash.sha256,
      execution: manifest.execution,
      recordKind: manifest.recordKind,
      attestation: manifest.recordKind === 'mock' ? 'mock_not_executed' : 'external_reported',
      metrics: checked,
      split: manifest.split,
      configHash: manifest.configHash,
      comparability: 'pending',
      comparabilityReason: 'not compared yet',
      freshness: plan && plan.contentHash === assignment.planHash ? 'current' : 'stale',
      createdAt: store.now(),
    };
    project.runs.push(run);
    refreshComparability(project.runs);
    return { state: project, result: { runId: run.runId, created: true } };
  });
}

export function submitResearchReview(options: ProjectStoreOptions, request: ReviewWrite): MutationBody<{ reviewId: string; reviewMode: 'self_review' }> {
  const actor = validateActorContext(request.actor);
  void request.claimedActor;
  const runIds = request.runIds.map((entry, index) => text(entry, `runIds[${index}]`, 80));
  if (!runIds.length || new Set(runIds).size !== runIds.length) throw new ResearchCoreError('INVALID_INPUT', 'review requires distinct runs');
  const reason = text(request.reason, 'reason', 4000);
  const nextStep = text(request.nextStep, 'nextStep', 2000);
  const payload = { runIds, judgment: request.judgment, reason, nextStep };
  const store = experimentStore(request.workspaceDir, options);
  return commitExperiment(store, request, 'submit_review', payload, (current) => {
    const project = projectOf(current);
    sameRevision(project, request.baseRevision);
    const runs = runIds.map((runId) => {
      const run = project.runs.find((entry) => entry.runId === runId);
      if (!run) throw new ResearchCoreError('NOT_FOUND', `run ${runId} is not in this project`);
      return run;
    });
    const decisive = request.judgment === 'supported' || request.judgment === 'contradicted';
    for (const run of runs) {
      const plan = project.plans.find((p) => p.planId === run.planId);
      const idea = project.ideas.find((i) => i.ideaId === plan?.ideaId);
      if (!plan || plan.contentHash !== run.planHash || !idea) throw new ResearchCoreError('REVISION_CONFLICT', 'review plan inputs are stale');
      for (const sourceId of idea.sourceIds) readMaterial(options, request.workspaceDir, sourceId);
    }
    for (const run of runs) {
      for (const hash of [run.manifestSha256, run.metricsSha256]) {
        const file = path.join(resultArtifactDirectory(store.workspaceDir, false), hash);
        if (!fs.existsSync(file) || sha256File(file).sha256 !== hash) throw new ResearchCoreError('STATE_CORRUPT', `review evidence missing or changed for ${run.runId}; re-import the original run evidence`);
      }
    }
    if (decisive && runs.some((run) => run.recordKind === 'mock' || run.attestation !== 'external_reported' || run.execution !== 'succeeded' || run.comparability !== 'comparable' || run.freshness !== 'current')) {
      throw new ResearchCoreError('INVALID_INPUT', 'supported or contradicted requires current, comparable, external observations. self_review cannot upgrade a mock, a failure, or a different split');
    }
    if (decisive && (runs.length < 2 || runs.some((run) => run.planId !== runs[0].planId || run.planHash !== runs[0].planHash || run.split !== runs[0].split || run.configHash !== runs[0].configHash))) {
      throw new ResearchCoreError('INVALID_INPUT', 'decisive review needs at least two mutually aligned runs from the pinned plan');
    }
    const review: ReviewRecord = {
      reviewId: `rev-${crypto.randomUUID()}`,
      runIds,
      judgment: request.judgment,
      reviewMode: 'self_review',
      reason,
      nextStep,
      subjectHash: requestHash(runs.map((run) => ({ runId: run.runId, manifestSha256: run.manifestSha256, metricsSha256: run.metricsSha256 }))),
      actorKind: actor.kind,
      actorSource: actor.source,
      createdAt: store.now(),
    };
    project.reviews.push(review);
    return { state: project, result: { reviewId: review.reviewId, reviewMode: 'self_review' as const } };
  });
}

export function searchPapers(options: ProjectStoreOptions, request: Write & { query: string }): MutationBody<{ status: 'search_incomplete'; reason: string }> {
  validateActorContext(request.actor);
  const query = text(request.query, 'query', 500);
  const reason = 'no retrieval provider is implemented for the standalone workbench';
  const store = new ProjectStore(request.workspaceDir, options);
  return commitOperation(store, request.operationId, 'search_papers', { query }, (current) => {
    const project = projectOf(current);
    sameRevision(project, request.baseRevision);
    project.searches.push({ searchId: `search-${crypto.randomUUID()}`, query, provider: null, status: 'search_incomplete', reason, createdAt: store.now() });
    return { state: project, result: { status: 'search_incomplete', reason } };
  });
}

export function researchTree(options: ProjectStoreOptions, workspaceDir: string): { revision: number; nodes: Array<{ id: string; kind: string; title: string }>; edges: Array<{ from: string; to: string; relation: string }> } {
  const project = experimentStore(workspaceDir, options).read();
  if (!project) throw new ResearchCoreError('NOT_FOUND', 'research project does not exist');
  const nodes = [
    ...project.ideas.map((idea) => ({ id: idea.ideaId, kind: 'idea', title: idea.title })),
    ...project.plans.map((plan) => ({ id: plan.planId, kind: 'plan', title: plan.variable })),
    ...project.runs.map((run) => ({ id: run.runId, kind: 'run', title: `${run.recordKind}:${run.execution}` })),
    ...project.reviews.map((review) => ({ id: review.reviewId, kind: 'review', title: `${review.reviewMode}:${review.judgment}` })),
    ...project.reviews.filter((review) => project.approvals.some((a) => a.capability === 'accept_decision' && a.subjectId === review.reviewId && a.subjectHash === requestHash(review) && a.actorKind === 'user')).map((review) => ({ id: `next-${review.reviewId}`, kind: 'followup', title: `未执行：${review.nextStep}` })),
  ];
  const edges = [
    ...project.plans.map((plan) => ({ from: plan.planId, to: plan.ideaId, relation: 'derived_from' })),
    ...project.runs.map((run) => ({ from: run.runId, to: run.planId, relation: 'tests' })),
    ...project.reviews.flatMap((review) => review.runIds.map((runId) => ({ from: review.reviewId, to: runId, relation: reviewEdge(review.judgment) }))),
    ...nodes.filter((node) => node.kind === 'followup').map((node) => ({ from: node.id, to: node.id.slice(5), relation: 'derived_from' })),
  ];
  return { revision: project.revision, nodes, edges };
}

function reviewEdge(judgment: ReviewRecord['judgment']): 'supports' | 'contradicts' | 'examines' {
  if (judgment === 'supported') return 'supports';
  if (judgment === 'contradicted') return 'contradicts';
  if (judgment === 'inconclusive') return 'examines';
  throw new ResearchCoreError('SCHEMA_VIOLATION', `review judgment ${String(judgment)} has no tree edge`);
}

function refreshComparability(runs: ExperimentRunRecord[]): void {
  for (const run of runs) {
    if (run.recordKind === 'mock' || run.execution !== 'succeeded' || run.metrics.every((metric) => metric.value === null)) {
      run.comparability = 'incomparable';
      run.comparabilityReason = 'A mock, a failed run, or a null metric cannot be ranked.';
      continue;
    }
    const peers = runs.filter((other) => other.runId !== run.runId && other.planId === run.planId && other.planHash === run.planHash && other.recordKind === 'external_reported' && other.execution === 'succeeded');
    const sameMetric = (other: ExperimentRunRecord) => run.metrics.some((metric) => metric.value !== null && other.metrics.some((peer) => peer.name === metric.name && peer.unit === metric.unit && peer.value !== null));
    const aligned = peers.filter((other) => sameMetric(other) && other.split === run.split && other.configHash === run.configHash);
    const conflicts = peers.filter((other) => sameMetric(other) && !aligned.includes(other));
    if (aligned.length) {
      run.comparability = 'comparable';
      run.comparabilityReason = 'Same split and config can sit side by side. No delta is computed, and the hypothesis is not accepted.';
    } else if (conflicts.length) {
      run.comparability = 'incomparable';
      run.comparabilityReason = 'The metric matches another run with a different split or config, so the values cannot be ranked.';
    } else {
      run.comparability = 'pending';
      run.comparabilityReason = 'No same-split comparison exists yet.';
    }
  }
}

interface Manifest {
  runId: string;
  assignmentId: string;
  planId: string;
  planRevision: number;
  planHash: string;
  execution: ExperimentRunRecord['execution'];
  recordKind: ExperimentRunRecord['recordKind'];
  split: string;
  configHash: string;
  metricsFile: string;
  metrics: MetricClaim[];
  failureQuote: string | null;
}

function readManifest(filePath: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new ResearchCoreError('STATE_CORRUPT', `run manifest is not valid JSON: ${String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new ResearchCoreError('SCHEMA_VIOLATION', 'run manifest must be an object');
  const obj = parsed as Record<string, unknown>;
  const execution = obj.execution;
  const recordKind = obj.recordKind;
  if (execution !== 'succeeded' && execution !== 'failed' && execution !== 'unknown') throw new ResearchCoreError('SCHEMA_VIOLATION', 'execution must be succeeded, failed, or unknown');
  if (recordKind !== 'external_reported' && recordKind !== 'mock') throw new ResearchCoreError('SCHEMA_VIOLATION', 'recordKind must be external_reported or mock');
  if (!Array.isArray(obj.metrics)) throw new ResearchCoreError('SCHEMA_VIOLATION', 'manifest metrics must be a list');
  return {
    runId: text(obj.runId, 'runId', 80),
    assignmentId: text(obj.assignmentId, 'assignmentId', 80),
    planId: text(obj.planId, 'planId', 80),
    planRevision: typeof obj.planRevision === 'number' && Number.isSafeInteger(obj.planRevision) ? obj.planRevision : (() => { throw new ResearchCoreError('SCHEMA_VIOLATION', 'planRevision must be an integer'); })(),
    planHash: text(obj.planHash, 'planHash', 64),
    execution,
    recordKind,
    split: text(obj.split, 'split', 200),
    configHash: text(obj.configHash, 'configHash', 64),
    metricsFile: text(obj.metricsFile, 'metricsFile', 300),
    failureQuote: obj.failureQuote === null || obj.failureQuote === undefined ? null : text(obj.failureQuote, 'failureQuote', 500),
    metrics: obj.metrics.map((entry) => {
      if (typeof entry !== 'object' || entry === null) throw new ResearchCoreError('SCHEMA_VIOLATION', 'metric claim must be an object');
      const metric = entry as Record<string, unknown>;
      if (metric.value !== null && (typeof metric.value !== 'number' || !Number.isFinite(metric.value))) throw new ResearchCoreError('SCHEMA_VIOLATION', 'metric value must be a finite number or null');
      return {
        name: text(metric.name, 'metric.name', 200),
        value: metric.value as number | null,
        unit: text(metric.unit, 'metric.unit', 80),
        row: typeof metric.row === 'number' ? metric.row : -1,
        column: typeof metric.column === 'number' ? metric.column : -1,
      };
    }),
  };
}

function resultArtifactDirectory(workspaceDir: string, create: boolean): string {
  const workspace = fs.realpathSync(workspaceDir); let current = workspace;
  for (const part of ['.research', 'artifacts']) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      if (!create) throw new ResearchCoreError('STATE_CORRUPT', 'Result artifact directory is missing');
      fs.mkdirSync(current);
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ResearchCoreError('PATH_ESCAPE', 'Result artifact directories must be regular workspace directories');
    assertInside(workspace, fs.realpathSync(current));
  }
  return current;
}

function workspaceFile(workspaceDir: string, relativePath: string): string {
  if (relativePath.split(/[\\/]/).some(part => ['.research','.dsh','.git','.codex','.claude','.agents','.ssh','.aws','.env'].includes(part.toLowerCase()) || part.toLowerCase().startsWith('.env.'))) throw new ResearchCoreError('PATH_ESCAPE', 'Result inputs cannot read internal stores or credentials');
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) throw new ResearchCoreError('PATH_ESCAPE', 'result paths must stay inside the workspace');
  const workspace = path.resolve(workspaceDir);
  const requested = path.resolve(workspace, relativePath);
  const relative = path.relative(workspace, requested);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ResearchCoreError('PATH_ESCAPE', 'result path leaves the workspace');
  if (!fs.existsSync(requested)) throw new ResearchCoreError('NOT_FOUND', `result file is missing: ${relativePath}`);
  const real = fs.realpathSync(requested);
  if (path.relative(fs.realpathSync(workspace), real).startsWith('..')) throw new ResearchCoreError('PATH_ESCAPE', 'result symlink leaves the workspace');
  const stat = fs.lstatSync(requested);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new ResearchCoreError('PATH_ESCAPE', 'result file must be a regular file');
  return real;
}

function writeView(workspaceDir: string, outPath: string, body: unknown): void {
  const root = resolveResearchRoot(workspaceDir);
  const target = exportTarget(workspaceDir, outPath);
  for (const forbidden of [root.researchDir, root.legacyDir]) {
    const relative = path.relative(path.resolve(forbidden), target);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new ResearchCoreError('PATH_ESCAPE', 'export cannot overwrite research state');
    }
  }
  assertInside(path.dirname(target), target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`);
}
