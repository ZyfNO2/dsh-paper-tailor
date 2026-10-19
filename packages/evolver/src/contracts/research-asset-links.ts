import { ExperimentError, expAssertArray, expAssertArtifactRef, expAssertEnum, expAssertId, expNoExtraKeys, type ArtifactRef } from './experiments.ts';
import { RESEARCH_ASSET_KINDS, type ResearchAssetKind } from './research-assets.ts';
import { researchInteger } from './research-command.ts';

export interface ResearchPosition {
  positionKey: string; domain: string; label: string; allowedKinds: ResearchAssetKind[];
  constraints: { input: string[]; output: string[]; conditions: string[] };
}
export interface ResearchContribution {
  contributionKey: string; paperId: string; sourceRef: ArtifactRef; wikiRef: ArtifactRef | null;
  kind: 'mechanism' | 'claim' | 'method' | 'result' | 'resource' | 'mapping'; text: string;
  claimStatus: 'source_reported' | 'inferred' | 'hypothesis' | 'unknown'; assetRefs: ArtifactRef[];
  locator: { chunkRef: ArtifactRef; rawByteStart: number; rawByteEndExclusive: number; paragraphIndex: number };
}
export interface ResearchAssetRelation {
  relationKey: string; sourceRef: ArtifactRef; targetRef: ArtifactRef; relation: string;
  conditionsRef: ArtifactRef; evidenceRefs: ArtifactRef[]; status: 'proposed' | 'supported' | 'unsupported';
}
export interface ResearchCitation {
  citationKey: string; contributionRef: ArtifactRef; targetRef: ArtifactRef; purpose: string; conditionsRef: ArtifactRef;
}
export interface ResearchProcessNode {
  nodeKey: string; kind: 'problem' | 'hypothesis' | 'scheme' | 'experiment' | 'result' | 'decision' | 'conclusion'; statement: string;
  nature: 'design_input' | 'hypothesis' | 'local_observation' | 'failure_diagnostic' | 'inferred' | 'unknown';
  parentRefs: ArtifactRef[]; assetRefs: ArtifactRef[]; observationRefs: ArtifactRef[]; conditionsRef: ArtifactRef | null;
}
function strings(raw: unknown, field: string) { return expAssertArray(raw, field).map((entry) => expAssertId(entry, field)); }
function refs(raw: unknown, field: string) { return expAssertArray(raw, field).map((entry) => expAssertArtifactRef(entry, field)); }
export function validatePosition(raw: unknown): ResearchPosition {
  const o = expNoExtraKeys(raw, ['positionKey', 'domain', 'label', 'allowedKinds', 'constraints'], 'position');
  const constraints = expNoExtraKeys(o.constraints, ['input', 'output', 'conditions'], 'constraints');
  const allowedKinds = expAssertArray(o.allowedKinds, 'allowedKinds').map((entry) => expAssertEnum(entry, RESEARCH_ASSET_KINDS, 'allowedKind'));
  if (!allowedKinds.length || new Set(allowedKinds).size !== allowedKinds.length) throw new ExperimentError('SCHEMA_VIOLATION', 'Position kind list is empty or repeated');
  return { positionKey: expAssertId(o.positionKey, 'positionKey'), domain: expAssertId(o.domain, 'domain'), label: expAssertId(o.label, 'label'), allowedKinds,
    constraints: { input: strings(constraints.input, 'input'), output: strings(constraints.output, 'output'), conditions: strings(constraints.conditions, 'conditions') } };
}
export function validateContribution(raw: unknown): ResearchContribution {
  const o = expNoExtraKeys(raw, ['contributionKey', 'paperId', 'sourceRef', 'wikiRef', 'kind', 'text', 'claimStatus', 'assetRefs', 'locator'], 'contribution');
  const locator = expNoExtraKeys(o.locator, ['chunkRef', 'rawByteStart', 'rawByteEndExclusive', 'paragraphIndex'], 'locator');
  const start = researchInteger(locator.rawByteStart, 'rawByteStart'), end = researchInteger(locator.rawByteEndExclusive, 'rawByteEndExclusive', 1);
  if (end <= start) throw new ExperimentError('SCHEMA_VIOLATION', 'Source byte locator is empty or reversed');
  return { contributionKey: expAssertId(o.contributionKey, 'contributionKey'), paperId: expAssertId(o.paperId, 'paperId'),
    sourceRef: expAssertArtifactRef(o.sourceRef, 'sourceRef'), wikiRef: o.wikiRef === null ? null : expAssertArtifactRef(o.wikiRef, 'wikiRef'),
    kind: expAssertEnum(o.kind, ['mechanism', 'claim', 'method', 'result', 'resource', 'mapping'] as const, 'kind'), text: expAssertId(o.text, 'text'),
    claimStatus: expAssertEnum(o.claimStatus, ['source_reported', 'inferred', 'hypothesis', 'unknown'] as const, 'claimStatus'), assetRefs: refs(o.assetRefs, 'assetRefs'),
    locator: { chunkRef: expAssertArtifactRef(locator.chunkRef, 'chunkRef'), rawByteStart: start, rawByteEndExclusive: end,
      paragraphIndex: researchInteger(locator.paragraphIndex, 'paragraphIndex') } };
}
export function validateAssetRelation(raw: unknown): ResearchAssetRelation {
  const o = expNoExtraKeys(raw, ['relationKey', 'sourceRef', 'targetRef', 'relation', 'conditionsRef', 'evidenceRefs', 'status'], 'relation');
  const evidenceRefs = refs(o.evidenceRefs, 'evidenceRefs');
  const status = expAssertEnum(o.status, ['proposed', 'supported', 'unsupported'] as const, 'status');
  if (status === 'supported' && !evidenceRefs.length) throw new ExperimentError('SOURCE_MISMATCH', 'Supported relation needs evidence');
  return { relationKey: expAssertId(o.relationKey, 'relationKey'), sourceRef: expAssertArtifactRef(o.sourceRef, 'sourceRef'), targetRef: expAssertArtifactRef(o.targetRef, 'targetRef'),
    relation: expAssertId(o.relation, 'relation'), conditionsRef: expAssertArtifactRef(o.conditionsRef, 'conditionsRef'), evidenceRefs, status };
}
export function validateCitation(raw: unknown): ResearchCitation {
  const o = expNoExtraKeys(raw, ['citationKey', 'contributionRef', 'targetRef', 'purpose', 'conditionsRef'], 'citation');
  return { citationKey: expAssertId(o.citationKey, 'citationKey'), contributionRef: expAssertArtifactRef(o.contributionRef, 'contributionRef'),
    targetRef: expAssertArtifactRef(o.targetRef, 'targetRef'), purpose: expAssertId(o.purpose, 'purpose'), conditionsRef: expAssertArtifactRef(o.conditionsRef, 'conditionsRef') };
}
export function validateProcessNode(raw: unknown): ResearchProcessNode {
  const o = expNoExtraKeys(raw, ['nodeKey', 'kind', 'statement', 'nature', 'parentRefs', 'assetRefs', 'observationRefs', 'conditionsRef'], 'process node');
  const kind = expAssertEnum(o.kind, ['problem', 'hypothesis', 'scheme', 'experiment', 'result', 'decision', 'conclusion'] as const, 'kind');
  const nature = expAssertEnum(o.nature, ['design_input', 'hypothesis', 'local_observation', 'failure_diagnostic', 'inferred', 'unknown'] as const, 'nature');
  const parentRefs = refs(o.parentRefs, 'parentRefs'), observationRefs = refs(o.observationRefs, 'observationRefs'), conditionsRef = o.conditionsRef === null ? null : expAssertArtifactRef(o.conditionsRef, 'conditionsRef');
  if (kind !== 'problem' && !parentRefs.length || ['local_observation', 'failure_diagnostic', 'inferred'].includes(nature) && (!observationRefs.length || !conditionsRef) ||
      kind === 'problem' && nature !== 'design_input' || kind === 'hypothesis' && nature !== 'hypothesis' || kind === 'conclusion' && nature !== 'inferred' && nature !== 'unknown') throw new ExperimentError('SCHEMA_VIOLATION', 'Research process node needs explicit provenance and parent/condition evidence');
  return { nodeKey: expAssertId(o.nodeKey, 'nodeKey'), kind, statement: expAssertId(o.statement, 'statement'), nature, parentRefs,
    assetRefs: refs(o.assetRefs, 'assetRefs'), observationRefs, conditionsRef };
}
export type ResearchLinkedRecord = ResearchPosition | ResearchContribution | ResearchAssetRelation | ResearchCitation | ResearchProcessNode;
export type ResearchLinkedKind = 'position' | 'contribution' | 'relation' | 'citation' | 'process';
export const LINK_VALIDATORS = { position: validatePosition, contribution: validateContribution, relation: validateAssetRelation, citation: validateCitation, process: validateProcessNode };
