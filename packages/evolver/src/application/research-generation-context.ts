import { createHash } from 'node:crypto';
import { ExperimentError, expAssertArtifactRef, expAssertId, expNoExtraKeys, type ArtifactRef } from '../contracts/experiments.ts';
import { canonicalJsonV1 } from '../domain/research-canonical.ts';

export interface GenerationDependency { ref: ArtifactRef; kind: 'knowledge_snapshot' | 'wiki' | 'asset' | 'observation' | 'config' | 'comparison' | 'diagnostic' | 'decision' | 'budget' | 'issue' }
export interface GenerationContextPack {
  schemaVersion: 1; taskId: string; scope: 'development'; round: number;
  entries: Array<GenerationDependency & { contentBase64: string }>;
  hardConstraints: string[]; unresolvedIssues: string[]; excluded: Array<{ ref: ArtifactRef; reason: string }>;
  proposalSource: 'scripted_fixture' | 'live'; roleConfigurationRef: ArtifactRef | null;
}
export interface GenerationContextReader {
  /** Authoritative registry metadata checked BEFORE bytes are opened. */
  describe(caller: unknown, ref: ArtifactRef): { taskId: string; kind: GenerationDependency['kind']; scope: 'development' | 'test' | 'gold'; current: boolean } | null;
  read(caller: unknown, ref: ArtifactRef): Buffer;
}
export function buildGenerationContext(caller: unknown, input: Omit<GenerationContextPack, 'entries' | 'excluded'> & { dependencies: GenerationDependency[] }, reader: GenerationContextReader,
  maxBytes = 512 * 1024): GenerationContextPack {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || input.schemaVersion !== 1 || input.scope !== 'development' || !Number.isSafeInteger(input.round) || input.round < 1) throw new ExperimentError('SCHEMA_VIOLATION', 'Invalid generation context limits or round');
  expAssertId(input.taskId, 'taskId');
  const entries: GenerationContextPack['entries'] = [], excluded: GenerationContextPack['excluded'] = [], seen = new Map<string, string>();
  let bytes = 0;
  for (const dependency of input.dependencies) {
    expNoExtraKeys(dependency, ['ref', 'kind'], 'generation dependency');
    const ref = expAssertArtifactRef(dependency.ref, 'context ref');
    if (seen.has(ref.id)) {
      if (seen.get(ref.id) !== ref.sha256) throw new ExperimentError('SOURCE_MISMATCH', 'Context repeats ref with another hash');
      continue;
    }
    seen.set(ref.id, ref.sha256);
    const description = reader.describe(caller, ref);
    if (!description || description.taskId !== input.taskId || description.scope !== 'development' || !description.current) { excluded.push({ ref, reason: 'outside_active_development_scope' }); continue; }
    if (description.kind !== dependency.kind) throw new ExperimentError('SOURCE_MISMATCH', 'Context dependency kind differs from authoritative registry');
    const content = reader.read(caller, ref);
    if (createHash('sha256').update(content).digest('hex') !== ref.sha256) throw new ExperimentError('ARTIFACT_CORRUPT', 'Generation dependency bytes changed');
    bytes += content.length;
    if (bytes > maxBytes) throw new ExperimentError('BUDGET_EXHAUSTED', 'Generation context exceeds trusted byte ceiling');
    entries.push({ ref, kind: dependency.kind, contentBase64: content.toString('base64') });
  }
  for (const required of ['knowledge_snapshot', 'config', 'comparison', 'decision', 'budget'] as const) {
    if (!entries.some((entry) => entry.kind === required)) throw new ExperimentError('DEPENDENCY_NOT_READY', `Generation context is missing ${required}`);
  }
  if (input.round > 1 && !entries.some((entry) => entry.kind === 'observation') || input.proposalSource === 'live' && !input.roleConfigurationRef) throw new ExperimentError('DEPENDENCY_NOT_READY', 'Later round requires prior observation; live generation requires applied role');
  const { dependencies: _dependencies, ...base } = input;
  const result = { ...base, entries, excluded };
  assertGenerationContext(result);
  return result;
}
export function assertGenerationContext(raw: unknown): GenerationContextPack {
  const o = expNoExtraKeys(raw, ['schemaVersion', 'taskId', 'scope', 'round', 'entries', 'hardConstraints', 'unresolvedIssues', 'excluded', 'proposalSource', 'roleConfigurationRef'], 'context');
  if (o.schemaVersion !== 1 || o.scope !== 'development' || !Number.isSafeInteger(o.round) || (o.round as number) < 1 || !Array.isArray(o.entries) || !Array.isArray(o.excluded) || !['scripted_fixture', 'live'].includes(String(o.proposalSource))) throw new ExperimentError('SCHEMA_VIOLATION', 'Invalid context schema');
  expAssertId(o.taskId, 'taskId');
  if (o.roleConfigurationRef !== null) expAssertArtifactRef(o.roleConfigurationRef, 'roleConfigurationRef');
  for (const values of [o.hardConstraints, o.unresolvedIssues]) if (!Array.isArray(values) || values.some((entry) => typeof entry !== 'string' || !entry.trim())) throw new ExperimentError('SCHEMA_VIOLATION', 'Context constraints and issues require strings');
  const ids = new Set<string>();
  for (const entry of o.entries as GenerationContextPack['entries']) {
    expNoExtraKeys(entry, ['ref', 'kind', 'contentBase64'], 'context entry'); expAssertArtifactRef(entry.ref, 'entry ref');
    if (!['knowledge_snapshot', 'wiki', 'asset', 'observation', 'config', 'comparison', 'diagnostic', 'decision', 'budget', 'issue'].includes(entry.kind) || ids.has(entry.ref.id) || typeof entry.contentBase64 !== 'string') throw new ExperimentError('SCHEMA_VIOLATION', 'Invalid or duplicate context entry');
    const bytes = Buffer.from(entry.contentBase64, 'base64');
    if (bytes.toString('base64') !== entry.contentBase64 || createHash('sha256').update(bytes).digest('hex') !== entry.ref.sha256) throw new ExperimentError('ARTIFACT_CORRUPT', 'Context embedded bytes do not match pinned hash');
    ids.add(entry.ref.id);
  }
  for (const entry of o.excluded as GenerationContextPack['excluded']) { expNoExtraKeys(entry, ['ref', 'reason'], 'excluded entry'); expAssertArtifactRef(entry.ref, 'excluded ref'); expAssertId(entry.reason, 'excluded reason'); }
  for (const required of ['knowledge_snapshot', 'config', 'comparison', 'decision', 'budget']) if (!(o.entries as GenerationContextPack['entries']).some((entry) => entry.kind === required)) throw new ExperimentError('DEPENDENCY_NOT_READY', `Generation context is missing ${required}`);
  if ((o.round as number) > 1 && !(o.entries as GenerationContextPack['entries']).some((entry) => entry.kind === 'observation') || o.proposalSource === 'live' && !o.roleConfigurationRef) throw new ExperimentError('DEPENDENCY_NOT_READY', 'Later round requires prior observation; live generation requires applied role');
  canonicalJsonV1(o);
  return o as unknown as GenerationContextPack;
}
