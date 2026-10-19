/** Research component sidecars; frozen research cards and original papers stay unchanged. */
import { ExperimentError, expAssertArray, expAssertArtifactRef, expAssertEnum, expAssertId, expNoExtraKeys, type ArtifactRef } from './experiments.ts';
import { researchInteger } from './research-command.ts';

export const RESEARCH_ASSET_KINDS = ['Baseline', 'Method', 'Module', 'Experiment'] as const;
export type ResearchAssetKind = typeof RESEARCH_ASSET_KINDS[number];
type Scalar = string | number | boolean;
export interface ResearchParameter {
  key: string; type: 'number' | 'integer' | 'string' | 'boolean'; unit: string | null;
  required: boolean; defaultValue: Scalar | null; minimum: number | null; maximum: number | null; enumValues: Scalar[] | null;
}
export interface ResearchAssetDraft {
  assetKey: string; kind: ResearchAssetKind; name: string;
  scope: { taskIds: string[]; usageScopes: string[] };
  sourceRefs: ArtifactRef[]; wikiRefs: ArtifactRef[]; dependencies: ArtifactRef[];
  claims: Array<{ text: string; status: 'source_reported' | 'inferred' | 'hypothesis' | 'unknown'; evidenceRefs: ArtifactRef[] }>;
  parameterSchema: ResearchParameter[];
  applicability: { domain: string; conditions: string[] };
  positionBindings: Array<{ positionRef: ArtifactRef; parameterKeys: string[] }>;
  capability: { status: 'available' | 'unsupported' | 'unknown'; runnerId: string | null; executableRef: ArtifactRef | null; reason: string | null };
}
export interface ResearchAssetRevision extends ResearchAssetDraft {
  schemaVersion: 1; revision: number; previousRef: ArtifactRef | null;
}

function ids(raw: unknown, field: string): string[] {
  const values = expAssertArray(raw, field).map((value) => expAssertId(value, field));
  if (new Set(values).size !== values.length) throw new ExperimentError('SCHEMA_VIOLATION', `${field} repeats identity`);
  return values;
}
function refs(raw: unknown, field: string): ArtifactRef[] {
  const values = expAssertArray(raw, field).map((value) => expAssertArtifactRef(value, field));
  if (new Set(values.map((ref) => ref.id)).size !== values.length) throw new ExperimentError('SCHEMA_VIOLATION', `${field} repeats ref identity`);
  return values;
}
function scalar(raw: unknown, field: string): Scalar {
  if (typeof raw === 'string' || typeof raw === 'boolean' || typeof raw === 'number' && Number.isFinite(raw)) return raw;
  throw new ExperimentError('SCHEMA_VIOLATION', `${field} must be a finite scalar`);
}

export function validateParameterValue(parameter: ResearchParameter, raw: unknown): Scalar {
  const value = scalar(raw, parameter.key);
  const actualType = parameter.type === 'integer' ? 'number' : parameter.type;
  if (typeof value !== actualType || parameter.type === 'integer' && !Number.isSafeInteger(value) ||
      typeof value === 'number' && (parameter.minimum !== null && value < parameter.minimum || parameter.maximum !== null && value > parameter.maximum) ||
      parameter.enumValues !== null && !parameter.enumValues.includes(value)) {
    throw new ExperimentError('INCOMPATIBLE_BINDING', `Value for ${parameter.key} violates its parameter schema`);
  }
  return value;
}

function parameter(raw: unknown): ResearchParameter {
  const o = expNoExtraKeys(raw, ['key', 'type', 'unit', 'required', 'defaultValue', 'minimum', 'maximum', 'enumValues'], 'parameter');
  if (typeof o.required !== 'boolean') throw new ExperimentError('SCHEMA_VIOLATION', 'Parameter required must be boolean');
  const bound = (value: unknown): number | null => {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new ExperimentError('SCHEMA_VIOLATION', 'Parameter bound must be finite or null');
    return value;
  };
  const value: ResearchParameter = {
    key: expAssertId(o.key, 'key'), type: expAssertEnum(o.type, ['number', 'integer', 'string', 'boolean'] as const, 'type'),
    unit: o.unit === null ? null : expAssertId(o.unit, 'unit'), required: o.required,
    defaultValue: o.defaultValue === null ? null : scalar(o.defaultValue, 'defaultValue'), minimum: bound(o.minimum), maximum: bound(o.maximum),
    enumValues: o.enumValues === null ? null : expAssertArray(o.enumValues, 'enumValues').map((entry) => scalar(entry, 'enumValue')),
  };
  if (value.minimum !== null && value.maximum !== null && value.minimum > value.maximum ||
      !['number', 'integer'].includes(value.type) && (value.minimum !== null || value.maximum !== null) ||
      value.enumValues !== null && (!value.enumValues.length || new Set(value.enumValues).size !== value.enumValues.length)) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'Parameter constraints are contradictory');
  }
  if (value.defaultValue !== null) validateParameterValue(value, value.defaultValue);
  value.enumValues?.forEach((entry) => validateParameterValue(value, entry));
  return value;
}

export function validateResearchAssetDraft(raw: unknown): ResearchAssetDraft {
  const o = expNoExtraKeys(raw, ['assetKey', 'kind', 'name', 'scope', 'sourceRefs', 'wikiRefs', 'dependencies', 'claims',
    'parameterSchema', 'applicability', 'positionBindings', 'capability'], 'asset');
  const scope = expNoExtraKeys(o.scope, ['taskIds', 'usageScopes'], 'scope');
  const taskIds = ids(scope.taskIds, 'taskIds'), usageScopes = ids(scope.usageScopes, 'usageScopes');
  if (!taskIds.length || !usageScopes.length) throw new ExperimentError('POLICY_DENIED', 'Asset scope must be explicit and nonempty');
  const parameters = expAssertArray(o.parameterSchema, 'parameterSchema').map(parameter);
  if (new Set(parameters.map((entry) => entry.key)).size !== parameters.length) throw new ExperimentError('SCHEMA_VIOLATION', 'Duplicate parameter key');
  const applicability = expNoExtraKeys(o.applicability, ['domain', 'conditions'], 'applicability');
  const capability = expNoExtraKeys(o.capability, ['status', 'runnerId', 'executableRef', 'reason'], 'capability');
  const status = expAssertEnum(capability.status, ['available', 'unsupported', 'unknown'] as const, 'capability.status');
  const runnerId = capability.runnerId === null ? null : expAssertId(capability.runnerId, 'runnerId');
  const executableRef = capability.executableRef === null ? null : expAssertArtifactRef(capability.executableRef, 'executableRef');
  const reason = capability.reason === null ? null : expAssertId(capability.reason, 'reason');
  if (status === 'available' && (!runnerId || !executableRef) || status === 'unsupported' && !reason) throw new ExperimentError('CONFIG_INCOMPLETE', 'Capability lacks execution refs or an unsupported reason');
  return {
    assetKey: expAssertId(o.assetKey, 'assetKey'), kind: expAssertEnum(o.kind, RESEARCH_ASSET_KINDS, 'kind'), name: expAssertId(o.name, 'name'),
    scope: { taskIds, usageScopes }, sourceRefs: refs(o.sourceRefs, 'sourceRefs'), wikiRefs: refs(o.wikiRefs, 'wikiRefs'), dependencies: refs(o.dependencies, 'dependencies'),
    claims: expAssertArray(o.claims, 'claims').map((rawClaim) => {
      const claim = expNoExtraKeys(rawClaim, ['text', 'status', 'evidenceRefs'], 'claim');
      const claimStatus = expAssertEnum(claim.status, ['source_reported', 'inferred', 'hypothesis', 'unknown'] as const, 'claim.status');
      const evidenceRefs = refs(claim.evidenceRefs, 'claim.evidenceRefs');
      if (['source_reported', 'inferred'].includes(claimStatus) && !evidenceRefs.length) throw new ExperimentError('SOURCE_MISMATCH', 'Reported or inferred claim requires evidence');
      return { text: expAssertId(claim.text, 'claim.text'), status: claimStatus, evidenceRefs };
    }),
    parameterSchema: parameters, applicability: { domain: expAssertId(applicability.domain, 'domain'), conditions: ids(applicability.conditions, 'conditions') },
    positionBindings: expAssertArray(o.positionBindings, 'positionBindings').map((binding) => {
      const entry = expNoExtraKeys(binding, ['positionRef', 'parameterKeys'], 'positionBinding');
      const parameterKeys = ids(entry.parameterKeys, 'parameterKeys');
      if (parameterKeys.some((key) => !parameters.some((entry) => entry.key === key))) throw new ExperimentError('INCOMPATIBLE_BINDING', 'Position binds an unknown parameter');
      return { positionRef: expAssertArtifactRef(entry.positionRef, 'positionRef'), parameterKeys };
    }), capability: { status, runnerId, executableRef, reason },
  };
}

export function validateResearchAssetRevision(raw: unknown): ResearchAssetRevision {
  const o = expNoExtraKeys(raw, ['schemaVersion', 'revision', 'previousRef', 'assetKey', 'kind', 'name', 'scope', 'sourceRefs', 'wikiRefs',
    'dependencies', 'claims', 'parameterSchema', 'applicability', 'positionBindings', 'capability'], 'asset revision');
  const { schemaVersion, revision: rawRevision, previousRef: rawPrevious, ...draft } = o;
  if (schemaVersion !== 1) throw new ExperimentError('SCHEMA_VIOLATION', 'Unsupported asset schema');
  const revision = researchInteger(rawRevision, 'revision', 1);
  const previousRef = rawPrevious === null ? null : expAssertArtifactRef(rawPrevious, 'previousRef');
  if ((revision === 1) !== (previousRef === null)) throw new ExperimentError('REVISION_CONFLICT', 'Asset predecessor does not match revision');
  return { schemaVersion, revision, previousRef, ...validateResearchAssetDraft(draft) };
}
