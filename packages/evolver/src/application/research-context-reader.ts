import { ExperimentError, type ArtifactRef } from '../contracts/experiments.ts';
import { KnowledgeService, type KnowledgeActor } from './knowledge-service.ts';
import { ResearchAssetService } from './research-asset-service.ts';
import { PublishedResearchObservationReader } from './research-observation-reader.ts';
import type { GenerationContextReader, GenerationDependency } from './research-generation-context.ts';

/** Concrete source-policy bridge. Unknown refs have no filesystem fallback. */
export function createResearchContextReader(options: {
  taskId: string; developmentUsageScope: string; actorFor(caller: unknown): KnowledgeActor; knowledge: KnowledgeService; assets: ResearchAssetService; execution: PublishedResearchObservationReader;
  /** Authoritative execution/decision/budget registry metadata, never inferred from ref names. */
  describeExecution(caller: unknown, ref: ArtifactRef): { kind: GenerationDependency['kind']; taskId: string; scope: 'development' | 'test' | 'gold'; current: boolean } | null;
  readExecution?(caller: unknown, ref: ArtifactRef): Buffer;
}): GenerationContextReader {
  if (!options.developmentUsageScope.trim()) throw new ExperimentError('POLICY_DENIED', 'A pinned development usage scope is required');
  const actorFor = (caller: unknown) => {
    const actor = options.actorFor(caller);
    if (actor.taskId !== options.taskId || !actor.usageScopes.includes(options.developmentUsageScope)) throw new ExperimentError('POLICY_DENIED', 'Context caller lacks the pinned task development scope');
    return actor;
  };
  return {
    describe: (caller, ref) => {
      const actor = actorFor(caller);
      const knowledge = options.knowledge.describeResearchDependency(ref, actor);
      if (knowledge) return ['wiki', 'knowledge_snapshot'].includes(knowledge.kind) ? { kind: knowledge.kind as 'wiki' | 'knowledge_snapshot', taskId: actor.taskId, scope: 'development', current: knowledge.status === 'current' && knowledge.scope.usageScopes.includes(options.developmentUsageScope) } : null;
      const asset = options.assets.describeResearchDependency(caller, ref);
      if (asset) return asset.kind === 'asset' ? { kind: 'asset', taskId: actor.taskId, scope: 'development', current: asset.status === 'current' && asset.scope.usageScopes.includes(options.developmentUsageScope) } : null;
      return options.describeExecution(caller, ref);
    },
    read: (caller, ref) => {
      const actor = actorFor(caller), knowledge = options.knowledge.describeResearchDependency(ref, actor);
      if (knowledge && ['wiki', 'knowledge_snapshot'].includes(knowledge.kind)) {
        if (knowledge.status !== 'current' || !knowledge.scope.usageScopes.includes(options.developmentUsageScope)) throw new ExperimentError('POLICY_DENIED', 'Knowledge dependency is no longer current development content');
        return options.knowledge.readResearchDependency(ref, actor);
      }
      const asset = options.assets.describeResearchDependency(caller, ref);
      if (knowledge) throw new ExperimentError('POLICY_DENIED', 'Knowledge ref is not an eligible context dependency');
      if (asset?.kind === 'asset') { if (asset.status !== 'current' || !asset.scope.usageScopes.includes(options.developmentUsageScope)) throw new ExperimentError('POLICY_DENIED', 'Asset dependency is outside current development policy'); return options.assets.readResearchDependency(caller, ref); }
      if (asset) throw new ExperimentError('POLICY_DENIED', 'Asset link is not an eligible context dependency');
      const execution = options.describeExecution(caller, ref);
      if (!execution || execution.taskId !== options.taskId || execution.scope !== 'development' || !execution.current) throw new ExperimentError('POLICY_DENIED', 'Execution dependency is outside active development policy');
      return options.readExecution ? options.readExecution(caller, ref) : options.execution.readBytes(caller, ref);
    },
  };
}
