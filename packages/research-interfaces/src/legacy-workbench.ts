import { bootstrapExperimentView, bootstrapExperimentUserAction } from '../../research-core/src/bootstrap-experiment-api.ts';
import { ResearchCore } from '../../research-core/src/service.ts';
import { searchFailure } from '../../research-core/src/legacy-search.ts';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLegacyWorkbench } from './legacy-domain.ts';
import { foundationSnapshot, foundationArtifact, foundationAction, foundationOptionsFromEnvironment, type FoundationOptions } from '../../research-core/src/legacy-foundations.ts';
import { legacyAsyncResearchAction } from '../../research-core/src/legacy-async-actions.ts';
import { legacyQuery } from './legacy-queries.ts';
import { migrationPreview, migrateDshWorkspace } from '../../research-core/src/active-store.ts';
import { prototypeMigrationPreview, migratePrototypeWorkspace } from '../../research-core/src/prototype-migration.ts';
import { paperLibraryProjection, readWorkspacePaper, paperLibraryAction } from '../../research-core/src/legacy-papers.ts';
import { readWorkspaceCycle } from '../../research-core/src/legacy-cycle.ts';
import { externalCycleAction } from '../../research-core/src/external-cycle.ts';
import { migrationRecoveryPreview, recoverMigration } from '../../research-core/src/migration-recovery.ts';
import { createResearchAssetBackup, previewResearchAssetBackup, restoreResearchAssetBackup, BACKUP_LIMITS } from '../../research-core/src/workspace-backup.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export function createLegacyWorkbenchServer(roots: string[], foundationOptions: FoundationOptions = foundationOptionsFromEnvironment()) {
  const allowed = roots.map((r) => fs.realpathSync(r));
  function scope(input: string | null) {
    if (!input) throw new Error('workspaceDir is required');
    const real = fs.realpathSync(input);
    if (!allowed.some((dir) => { const rel = path.relative(dir, real); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); })) throw new Error('PATH_ESCAPE: workspace outside allowed roots');
    return real;
  }
  return http.createServer((req, res) => {
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    void (async () => {
      const host = `127.0.0.1:${req.socket.localPort}`;
      if (req.headers.host !== host || (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)) { send(403, { message: 'request origin refused' }); return; }
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname === '/api/dsh/experiments' && req.method === 'GET') { send(200, bootstrapExperimentView(scope(url.searchParams.get('workspaceDir')), url.searchParams.get('researchId') ?? '')); return; }
      if (url.pathname === '/api/dsh/experiments/assignment' && req.method === 'GET') { send(200, new ResearchCore().assignmentBundle(scope(url.searchParams.get('workspaceDir')), url.searchParams.get('assignmentId') ?? '')); return; }
      if (url.pathname === '/api/dsh/experiments/actions' && req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') { send(415, { message: 'application/json required' }); return; }
        const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('Experiment action exceeds 64 KiB'); chunks.push(chunk); }
        send(200, bootstrapExperimentUserAction(scope(url.searchParams.get('workspaceDir')), JSON.parse(Buffer.concat(chunks).toString('utf8')))); return;
      }
      // Native links/images use this old route too. The token is only a workspace
      // locator; scope() below validates it against the server's explicit roots.
      if (url.pathname.startsWith('/evolver/research-bootstrap')) {
        const locator = url.searchParams.get('sessionId');
        if (!url.searchParams.has('workspaceDir') && locator?.startsWith('workspace:')) url.searchParams.set('workspaceDir', locator.slice('workspace:'.length));
        url.searchParams.delete('sessionId');
        url.pathname = url.pathname === '/evolver/research-bootstrap' ? '/api/dsh/bootstrap'
          : url.pathname === '/evolver/research-bootstrap/actions' ? '/api/dsh/actions'
          : url.pathname.replace('/evolver/research-bootstrap/', '/api/dsh/bootstrap/');
      }
      if (url.pathname.startsWith('/evolver/research-foundations')) {
        const locator = url.searchParams.get('sessionId');
        if (!url.searchParams.has('workspaceDir') && locator?.startsWith('workspace:')) url.searchParams.set('workspaceDir', locator.slice('workspace:'.length));
        url.searchParams.delete('sessionId');
        url.pathname = url.pathname.replace('/evolver/research-foundations', '/api/dsh/foundations');
      }
      if (url.pathname.startsWith('/api/dsh/foundations')) {
        const workspace = scope(url.searchParams.get('workspaceDir')), researchId = url.searchParams.get('researchId');
        if (!researchId) throw new Error('researchId required');
        if (req.method === 'GET' && url.pathname === '/api/dsh/foundations') { send(200, foundationSnapshot(workspace, researchId, foundationOptions)); return; }
        if (req.method === 'GET' && url.pathname === '/api/dsh/foundations/artifacts') {
          const result = foundationArtifact(workspace, researchId, url.searchParams, foundationOptions);
          res.writeHead(200, { 'content-type': result.mediaType, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }); res.end(result.bytes); return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dsh/foundations/actions') {
          if (req.headers['content-type']?.split(';')[0] !== 'application/json') { send(415, { error: 'application/json required' }); return; }
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > 512 * 1024) throw new Error('foundations body exceeds 512 KiB'); chunks.push(chunk); }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object body required');
          send(200, await foundationAction(workspace, researchId, body, undefined, foundationOptions)); return;
        }
        send(404, { error: 'unsupported foundations route' }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/dsh/external-cycle') {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') { send(415, { message: 'application/json required' }); return; }
        const researchId = url.searchParams.get('researchId'); if (!researchId) throw new Error('researchId required');
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 512 * 1024) throw new Error('external cycle request exceeds 512 KiB'); chunks.push(chunk); }
        send(200, await externalCycleAction(scope(url.searchParams.get('workspaceDir')), researchId, JSON.parse(Buffer.concat(chunks).toString('utf8')))); return;
      }
      if (url.pathname.startsWith('/evolver/research-cycle')) {
        const locator = url.searchParams.get('sessionId');
        if (!url.searchParams.has('workspaceDir') && locator?.startsWith('workspace:')) url.searchParams.set('workspaceDir', locator.slice('workspace:'.length));
        url.searchParams.delete('sessionId'); url.pathname = url.pathname.replace('/evolver/research-cycle', '/api/dsh/cycle');
      }
      if (req.method === 'GET' && (url.pathname === '/api/dsh/cycle' || url.pathname === '/api/dsh/cycle/artifacts')) {
        const researchId = url.searchParams.get('researchId'); if (!researchId) throw new Error('researchId required');
        if (url.pathname.endsWith('/artifacts') && (!url.searchParams.get('id') || !url.searchParams.get('sha256'))) throw new Error('artifact id/sha256 required');
        send(200, readWorkspaceCycle(scope(url.searchParams.get('workspaceDir')), researchId, url.searchParams)); return;
      }
      if (url.pathname === '/api/dsh/cycle/actions') { send(400, { ok: false, error: 'UNSUPPORTED_CAPABILITY', message: '独立版尚未接原生 Team 调度；未派发、未伪造运行。' }); return; }
      if (url.pathname === '/evolver/paper-library') {
        const locator = url.searchParams.get('sessionId');
        if (!url.searchParams.has('workspaceDir') && locator?.startsWith('workspace:')) url.searchParams.set('workspaceDir', locator.slice('workspace:'.length));
        url.searchParams.delete('sessionId'); url.pathname = '/api/dsh/papers';
      }
      if (url.pathname === '/api/dsh/papers') {
        const workspace = scope(url.searchParams.get('workspaceDir'));
        if (req.method === 'GET') {
          const paperId = url.searchParams.get('paperId');
          if (!paperId) { send(200, paperLibraryProjection(workspace)); return; }
          const result = readWorkspacePaper(workspace, paperId, url.searchParams.get('op') !== 'read');
          if (result.bytes) { res.writeHead(200, { 'content-type': result.mediaType!, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename!)}`, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }); res.end(result.bytes); }
          else send(200, result.json); return;
        }
        if (req.method === 'POST') {
          if (req.headers['content-type']?.split(';')[0] !== 'application/json') { send(415, { message: 'application/json required' }); return; }
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > 15 * 1024 * 1024) throw new Error('paper request exceeds 15 MiB'); chunks.push(chunk); }
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object body required');
          const paper = await paperLibraryAction(workspace, value);
          send(200, { ok: true, paperId: paper.id, revision: paper.revision, wikiSections: paper.sections.length, components: paper.components.length, status: 'provisional' }); return;
        }
        send(405, { message: 'GET or POST required' }); return;
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 研究工作台</title><body style="margin:0"><div id="root"></div><script type="module" src="/workbench.js"></script></body></html>'); return; }
      if (req.method === 'GET' && url.pathname === '/workbench.js') { const file = path.join(root, 'artifacts/legacy-workbench-build/main.js'); if (!fs.existsSync(file)) throw new Error('Run npm run build:legacy-workbench first'); res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(fs.readFileSync(file)); return; }
      if (url.pathname.startsWith('/api/dsh/assets/')) {
        if (req.method !== 'POST') { send(405, { message: 'POST required for user asset backup/restore' }); return; }
        const workspace = scope(url.searchParams.get('workspaceDir'));
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') { send(415, { message: 'application/json required' }); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > BACKUP_LIMITS.jsonBytes) throw new Error('Research asset backup body exceeds 96 MiB'); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object body required');
        if (url.pathname === '/api/dsh/assets/backup') {
          if (body.authorize !== true || Object.keys(body).some(key => key !== 'authorize')) throw new Error('explicit user asset backup authorization required');
          const backup = createResearchAssetBackup(workspace);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="dsh-research-assets.json"', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }); res.end(JSON.stringify(backup)); return;
        }
        if (url.pathname === '/api/dsh/assets/preview') {
          if (Object.keys(body).some(key => key !== 'backup')) throw new Error('unexpected asset preview field');
          send(200, previewResearchAssetBackup(body.backup)); return;
        }
        if (url.pathname === '/api/dsh/assets/restore') {
          if (body.authorize !== true || typeof body.expectedHash !== 'string' || typeof body.directory !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(body.directory) || Object.keys(body).some(key => !['authorize', 'expectedHash', 'directory', 'backup'].includes(key))) throw new Error('explicit restoration, preview hash and a new child directory name required');
          send(200, { ok: true, ...restoreResearchAssetBackup(path.join(workspace, body.directory), body.backup, body.expectedHash) }); return;
        }
        send(404, { message: 'unsupported asset backup route' }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/workspaces') { send(200, { workspaces: allowed }); return; }
      if (req.method === 'GET' && url.pathname === '/api/dsh/bootstrap') { send(200, readLegacyWorkbench(scope(url.searchParams.get('workspaceDir')))); return; }
      if (url.pathname === '/api/dsh/migration-recovery') {
        const workspace = scope(url.searchParams.get('workspaceDir'));
        if (req.method === 'GET') { send(200, migrationRecoveryPreview(workspace, url.searchParams.get('candidate') ?? '.research/compat')); return; }
        if (req.method === 'POST') {
          if (req.headers['content-type']?.split(';')[0] !== 'application/json') { send(415, { message: 'application/json required' }); return; }
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new Error('recovery body exceeds 16 KiB'); chunks.push(chunk); }
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value || Array.isArray(value) || value.authorize !== true || typeof value.candidate !== 'string' || typeof value.expectedHash !== 'string' || Object.keys(value).some((key) => !['candidate', 'expectedHash', 'authorize'].includes(key))) throw new Error('explicit recovery authorization, candidate and preview hash required');
          send(200, { ok: true, ...recoverMigration(workspace, value.candidate, value.expectedHash) }); return;
        }
        send(405, { message: 'GET or POST required' }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/dsh/migration') {
        const workspace = scope(url.searchParams.get('workspaceDir'));
        send(200, fs.existsSync(path.join(workspace, '.research/project.json')) ? prototypeMigrationPreview(workspace) : { ...migrationPreview(workspace), kind: 'dsh' }); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/dsh/bootstrap/')) {
        const result = legacyQuery(scope(url.searchParams.get('workspaceDir')), url.pathname.slice('/api/dsh/bootstrap/'.length), url.searchParams);
        if (result.bytes) { res.writeHead(200, { 'content-type': result.mediaType!, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename!)}`, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }); res.end(result.bytes); }
        else send(200, result.json);
        return;
      }
      if (req.method === 'POST' && (url.pathname === '/api/dsh/actions' || url.pathname === '/api/dsh/migrate' || url.pathname === '/api/dsh/bootstrap/package')) {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') { send(415, { message: 'application/json required' }); return; }
        const chunks: Buffer[] = []; let size = 0;
        const packageRequest = url.pathname === '/api/dsh/bootstrap/package';
        const maximum = (packageRequest ? 65 : 15) * 1024 * 1024;
        for await (const chunk of req) { size += chunk.length; if (size > maximum) throw new Error(`body exceeds ${maximum} byte transport limit`); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (packageRequest && (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some((key) => !['operationId', 'baseRevision', 'title', 'package'].includes(key)))) throw new Error('Unexpected package import envelope');
        if (url.pathname === '/api/dsh/migrate') {
          if (typeof body?.expectedHash !== 'string') throw new Error('expectedHash required');
          const workspace = scope(url.searchParams.get('workspaceDir'));
          if (body.kind !== 'prototype' && body.kind !== 'dsh') throw new Error('migration kind must match preview');
          send(200, { ok: true, ...(body.kind === 'prototype' ? migratePrototypeWorkspace(workspace, body.expectedHash) : migrateDshWorkspace(workspace, body.expectedHash)) }); return;
        }
        const saved = await legacyAsyncResearchAction(scope(url.searchParams.get('workspaceDir')), packageRequest ? { ...body, type: 'import_general_portable_package' } : body);
        const blocked = 'status' in saved.result && saved.result.status === 'blocked';
        send(blocked ? 400 : 200, { ok: !blocked, revision: saved.revision, replayed: saved.replayed, ...saved.result, ...(blocked ? { message: '接管采纳被阻止；请检查 firstError 与当前文件状态。' } : {}) }); return;
      }
      send(404, { message: `UNSUPPORTED_ROUTE: ${url.pathname} 尚未适配。` });
    })().catch((error) => { const message = error instanceof Error ? error.message : String(error); send(400, { ok: false, message, error: message, ...searchFailure(error) }); });
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
  const port = Number(flag('--port', '9412'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  createLegacyWorkbenchServer(flag('--roots', process.cwd()).split(path.delimiter)).listen(port, '127.0.0.1', () => process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${port}` }) + '\n'));
}
