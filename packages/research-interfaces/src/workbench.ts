import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { ResearchCoreError, type ActorContext } from '../../research-contracts/src/index.ts';
import { ResearchCore, requestHash } from '../../research-core/src/index.ts';

const HOST = '127.0.0.1';
const core = new ResearchCore();
const actor: ActorContext = {
  actorId: `workbench:${os.userInfo().username.trim() || 'local-user'}`,
  kind: 'user',
  source: 'http',
};

interface Launch {
  port: number;
  roots: string[];
}

function launch(): Launch {
  const portFlag = process.argv.indexOf('--port');
  const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 9411;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ResearchCoreError('INVALID_INPUT', '--port must be a TCP port');
  }
  const rootsFlag = process.argv.indexOf('--roots');
  const given = rootsFlag >= 0 ? process.argv[rootsFlag + 1] : process.cwd();
  const roots = given.split(path.delimiter).map((entry) => path.resolve(entry.trim())).filter(Boolean);
  if (!roots.length) throw new ResearchCoreError('INVALID_INPUT', '--roots needs at least one directory');
  return { port, roots };
}

function workspaceFor(roots: string[], requested: string): string {
  const resolved = fs.realpathSync(path.resolve(requested));
  const allowed = roots.find((root) => {
    const relative = path.relative(fs.realpathSync(root), resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!allowed) throw new ResearchCoreError('PATH_ESCAPE', 'workspace is outside the directories given at launch');
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'workspace must be a real directory');
  return resolved;
}

function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new ResearchCoreError('INVALID_INPUT', 'request body exceeds 1 MB'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject(new ResearchCoreError('INVALID_INPUT', 'request body must be an object'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        reject(new ResearchCoreError('INVALID_INPUT', `request body is not JSON: ${String(error)}`));
      }
    });
    request.on('error', reject);
  });
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ResearchCoreError('INVALID_INPUT', `${name} is required`);
  return value;
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ResearchCoreError('INVALID_INPUT', 'baseRevision must be a non-negative integer');
  }
  return value;
}

function list(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new ResearchCoreError('INVALID_INPUT', `${name} must be a list`);
  return value.map((entry, index) => text(entry, `${name}[${index}]`));
}

function operationId(body: Record<string, unknown>): string {
  return typeof body.operationId === 'string' && body.operationId.trim().length > 0 ? body.operationId : `op-${crypto.randomUUID()}`;
}

function projects(roots: string[]): Array<{ workspaceDir: string; goal: string | null; revision: number | null; projectId: string | null; error: string | null }> {
  const found: Array<{ workspaceDir: string; goal: string | null; revision: number | null; projectId: string | null; error: string | null }> = [];
  for (const root of roots) {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const candidates = [root, ...entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => path.join(root, entry.name))];
    for (const candidate of candidates) {
      if (!fs.existsSync(path.join(candidate, '.research', 'project.json')) && !fs.existsSync(path.join(candidate, '.dsh', 'research', 'bootstrap', 'state.json'))) continue;
      try {
        workspaceFor(roots, candidate);
        const context = core.context(candidate);
        found.push({
          workspaceDir: candidate,
          goal: context.project?.goal ?? null,
          revision: context.project?.revision ?? null,
          projectId: context.project?.projectId ?? null,
          error: null,
        });
      } catch (error) {
        found.push({
          workspaceDir: candidate,
          goal: null,
          revision: null,
          projectId: null,
          error: error instanceof ResearchCoreError ? `${error.code}: ${error.message}` : String(error),
        });
      }
    }
  }
  return found;
}

function snapshot(workspaceDir: string): unknown {
  const context = core.context(workspaceDir);
  const tree = context.project ? core.tree(workspaceDir) : { revision: 0, nodes: [], edges: [] };
  return {
    workspaceDir,
    rootKind: context.rootKind,
    project: context.project,
    needsMigration: context.needsMigration,
    subjectHashes: {
      ideas: Object.fromEntries((context.project?.ideas ?? []).map((i) => [i.ideaId, requestHash(i)])),
      reviews: Object.fromEntries((context.project?.reviews ?? []).map((r) => [r.reviewId, requestHash(r)])),
    },
    legacy: context.legacy,
    tree,
  };
}

async function dispatch(roots: string[], url: URL, body: Record<string, unknown>): Promise<unknown> {
  if (url.pathname === '/api/projects') return { projects: projects(roots) };
  const workspaceDir = workspaceFor(roots, text(body.workspaceDir, 'workspaceDir'));
  const base = { workspaceDir, operationId: operationId(body), actor, claimedActor: body.actor };
  if (url.pathname === '/api/context') return snapshot(workspaceDir);
  if (url.pathname === '/api/migrate') return core.migrate(workspaceDir, actor);
  if (url.pathname === '/api/source') return core.readMaterial(workspaceDir, text(body.sourceId, 'sourceId'));
  if (url.pathname === '/api/wiki') return core.searchWiki(workspaceDir, typeof body.query === 'string' ? body.query : '');
  if (url.pathname === '/api/knowledge') {
    const kind = text(body.kind, 'kind');
    if (kind !== 'brief' && kind !== 'method' && kind !== 'evaluation') throw new ResearchCoreError('INVALID_INPUT', 'unsupported knowledge kind');
    if (!Array.isArray(body.citations)) throw new ResearchCoreError('INVALID_INPUT', 'citations must be a list');
    return core.upsertKnowledge({ ...base, baseRevision: revision(body.baseRevision),
      ...(body.cardId ? { cardId: text(body.cardId, 'cardId'), cardRevision: revision(body.cardRevision) } : {}),
      kind, title: text(body.title, 'title'), body: text(body.body, 'body'), sourceIds: list(body.sourceIds, 'sourceIds'),
      unknowns: list(body.unknowns ?? [], 'unknowns'), citations: body.citations as Parameters<ResearchCore['upsertKnowledge']>[0]['citations'] });
  }
  if (url.pathname === '/api/assignment-bundle') return core.assignmentBundle(workspaceDir, text(body.assignmentId, 'assignmentId'));
  if (url.pathname === '/api/init') return core.init({ ...base, goal: text(body.goal, 'goal'), constraints: Array.isArray(body.constraints) ? list(body.constraints, 'constraints') : [] });
  if (url.pathname === '/api/import') return core.importMaterial({ ...base, baseRevision: revision(body.baseRevision), filePath: text(body.filePath, 'filePath'), allowAbsolute: true });
  if (url.pathname === '/api/idea') {
    return core.createIdea({
      ...base,
      baseRevision: revision(body.baseRevision),
      title: text(body.title, 'title'),
      hypothesis: text(body.hypothesis, 'hypothesis'),
      change: text(body.change, 'change'),
      mechanism: text(body.mechanism, 'mechanism'),
      falsifier: text(body.falsifier, 'falsifier'),
      sourceIds: list(body.sourceIds, 'sourceIds'),
    });
  }
  if (url.pathname === '/api/plan') {
    return core.createPlan({
      ...base,
      baseRevision: revision(body.baseRevision),
      ideaId: text(body.ideaId, 'ideaId'),
      baseline: text(body.baseline, 'baseline'),
      variable: text(body.variable, 'variable'),
      fixedConditions: Array.isArray(body.fixedConditions) ? list(body.fixedConditions, 'fixedConditions') : [],
      split: text(body.split, 'split'),
      seedPolicy: text(body.seedPolicy, 'seedPolicy'),
      metric: text(body.metric, 'metric'),
      metricUnit: text(body.metricUnit, 'metricUnit'),
      budget: text(body.budget, 'budget'),
      stopCondition: text(body.stopCondition, 'stopCondition'),
    });
  }
  if (url.pathname === '/api/approve') {
    return core.approve({
      ...base,
      baseRevision: revision(body.baseRevision),
      subjectId: text(body.subjectId, 'subjectId'),
      subjectRevision: revision(body.subjectRevision),
      subjectHash: text(body.subjectHash, 'subjectHash'),
      capability: text(body.capability, 'capability'),
    });
  }
  if (url.pathname === '/api/assignment') return core.exportAssignment({ ...base, baseRevision: revision(body.baseRevision), planId: text(body.planId, 'planId') });
  if (url.pathname === '/api/record') return core.recordRun({ ...base, baseRevision: revision(body.baseRevision), manifestPath: text(body.manifestPath, 'manifestPath') });
  if (url.pathname === '/api/review') {
    const judgment = text(body.judgment, 'judgment');
    if (judgment !== 'supported' && judgment !== 'contradicted' && judgment !== 'inconclusive') {
      throw new ResearchCoreError('INVALID_INPUT', 'judgment must be supported, contradicted, or inconclusive');
    }
    return core.submitReview({
      ...base,
      baseRevision: revision(body.baseRevision),
      runIds: list(body.runIds, 'runIds'),
      judgment,
      reason: text(body.reason, 'reason'),
      nextStep: text(body.nextStep, 'nextStep'),
    });
  }
  if (url.pathname === '/api/search') return core.searchPapers({ ...base, baseRevision: revision(body.baseRevision), query: text(body.query, 'query') });
  throw new ResearchCoreError('NOT_FOUND', `unknown route ${url.pathname}`);
}

function send(response: http.ServerResponse, status: number, payload: unknown): void {
  const json = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json),
  });
  response.end(json);
}

export function createWorkbenchServer(roots: string[]): http.Server {
  const page = fs.readFileSync(new URL('./workbench.html', import.meta.url), 'utf8');
  return http.createServer((request, response) => {
    void (async () => {
      const origin = request.headers.origin;
      const expectedHost = `${HOST}:${launchPort(request.socket.localPort)}`;
      if (request.headers.host !== expectedHost || (origin !== undefined && origin !== `http://${expectedHost}`)) {
        send(response, 403, { ok: false, code: 'PATH_ESCAPE', message: 'PATH_ESCAPE: cross-origin request refused' });
        return;
      }
      const url = new URL(request.url ?? '/', `http://${HOST}`);
      if (request.method === 'GET' && url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (request.method === 'GET' && url.pathname === '/workbench-client.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        response.end(fs.readFileSync(new URL('./workbench-client.js', import.meta.url), 'utf8'));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(page);
        return;
      }
      if (request.method !== 'POST') {
        send(response, 404, { ok: false, code: 'NOT_FOUND', message: 'NOT_FOUND: route not found' });
        return;
      }
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        send(response, 415, { ok: false, code: 'INVALID_INPUT', message: 'application/json is required' });
        return;
      }
      const body = await readBody(request);
      const result = await dispatch(roots, url, body);
      send(response, 200, { ok: true, result });
    })().catch((error: unknown) => {
      const code = error instanceof ResearchCoreError ? error.code : 'INVALID_INPUT';
      const message = error instanceof Error ? error.message : String(error);
      send(response, code === 'NOT_FOUND' ? 404 : 400, { ok: false, code, message });
    });
  });
}

function launchPort(localPort: number | undefined): number {
  return localPort && localPort > 0 ? localPort : 9411;
}

function main(): void {
  const config = launch();
  const server = createWorkbenchServer(config.roots);
  server.listen(config.port, HOST, () => {
    process.stdout.write(`${JSON.stringify({ ok: true, url: `http://${HOST}:${config.port}/`, roots: config.roots })}\n`);
  });
}

const entry = process.argv[1]?.replaceAll('\\', '/');
if (entry?.endsWith('/packages/research-interfaces/src/workbench.ts')) main();

export { main };
