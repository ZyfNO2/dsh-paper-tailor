import { legacyScope } from './legacy-domain.ts';
import { workspacePaperResolver } from './legacy-papers.ts';
import { ResearchCycleService } from '../../evolver/src/application/research-cycle-service.ts';
import { ResearchCycleStore } from '../../evolver/src/application/research-cycle-store.ts';
import { assertGeneralSourceAccess } from '../../evolver/src/application/general-source-access.ts';
import { ResearchCoreError } from '../../research-contracts/src/index.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ActorContext } from '../../research-contracts/src/index.ts';

/** Read the persisted cycle, without presenting historical Team membership as a live runtime. */
export function readWorkspaceCycle(workspace: string, researchId: string, query = new URLSearchParams(), caller?: ActorContext) {
  const { store } = legacyScope(workspace), state = store.readStateOrEmpty(), research = state.researches.find((r) => r.researchId === researchId);
  if (!research) throw new ResearchCoreError('NOT_FOUND', 'researchId is outside this workspace');
  if (!/^[\w-]+$/.test(researchId)) throw new ResearchCoreError('INVALID_INPUT', 'invalid researchId');
  const cycleRoot = path.join(store.workspaceRoot, '.dsh/research/cycles', researchId);
  const candidates = [path.dirname(cycleRoot), cycleRoot, path.join(cycleRoot, 'state.json'), path.join(cycleRoot, 'artifacts')];
  if (query.has('id') || query.has('sha256')) {
    if (!/^artifacts\/[0-9a-f]{64}\.json$/.test(query.get('id') ?? '') || !/^[0-9a-f]{64}$/.test(query.get('sha256') ?? '')) throw new ResearchCoreError('INVALID_INPUT', 'content-addressed artifact id and sha256 required');
    candidates.push(path.join(cycleRoot, query.get('id')!));
  }
  for (const candidate of candidates) if (fs.existsSync(candidate)) {
    const relative = path.relative(fs.realpathSync(store.workspaceRoot), fs.realpathSync(candidate));
    if (relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(candidate).isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'cycle assets must stay in the selected store without links');
  }
  const cycles = new ResearchCycleStore(store.workspaceRoot, researchId).readStateOrEmpty();
  if (research.general && cycles.runs.length) for (const source of research.general.sources) assertGeneralSourceAccess(research.general, source.sourceId);
  const service = new ResearchCycleService({ workspaceRoot: store.workspaceRoot, bootstrapStore: store, resolver: workspacePaperResolver(workspace) });
  const actor = { kind: caller?.kind === 'agent' ? 'agent' : 'user', identity: caller?.actorId ?? 'standalone-reader', actionId: null };
  if (query.has('id') || query.has('sha256')) return { schemaVersion: 1, ...service.getCycleArtifact(actor, { researchId, ref: { id: query.get('id'), sha256: query.get('sha256') } }) };
  const capability = { available: false, reason: '当前独立版未接原生 Team 调度；显示的是已登记研究状态，不是实时成员。' };
  return { schemaVersion: 1, scope: 'workspace-files', ...service.getResearchCycleView(actor, { researchId, runId: query.get('runId') ?? undefined }), externalHandoffCapability: { available: !legacyScope(workspace).readOnly, reviewMode: 'self_review', dispatchesModel: false }, runtimeCapability: capability, runtime: { ...capability, mode: 'standalone-read-only', members: [], tasks: [] } };
}
