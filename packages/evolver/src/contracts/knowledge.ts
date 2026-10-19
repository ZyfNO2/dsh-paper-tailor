import { createHash } from 'node:crypto';

export const KNOWLEDGE_SCHEMA_VERSION = 1 as const;
export const KNOWLEDGE_PAGE_TYPES = ['method', 'mechanism', 'compatibility', 'experiment'] as const;
export type KnowledgePageType = (typeof KNOWLEDGE_PAGE_TYPES)[number];
export const KNOWLEDGE_CLAIM_KINDS = ['source_reported', 'inferred', 'local_observation'] as const;
export type KnowledgeClaimKind = (typeof KNOWLEDGE_CLAIM_KINDS)[number];
export const KNOWLEDGE_CLAIM_STATES = ['current', 'stale', 'conflicted', 'unsupported'] as const;
export type KnowledgeClaimState = (typeof KNOWLEDGE_CLAIM_STATES)[number];

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class KnowledgeError extends Error {
  readonly code: string;
  readonly fieldPaths: string[];

  constructor(code: string, message: string, fieldPaths: string[] = []) {
    super(`[${code}] ${message}`);
    this.name = 'KnowledgeError';
    this.code = code;
    this.fieldPaths = fieldPaths;
  }
}

export interface KnowledgeScope {
  usageScopes: string[];
  allowedTaskIds: string[];
  visibleSections: string[];
  forbiddenContentClasses: string[];
}

export interface KnowledgeSourceConfig {
  paperId: string;
  title: string;
  identifier: string;
  declaredVersion: string;
  sourceGroupId: string;
  sourceUri: string;
  hostRegisteredFileRef: string;
  section: string;
  contentClass: 'provisional_text' | 'public_text' | 'verified_observation';
  sha256: string;
  qualityStatus: 'provisional' | 'verified';
  accessPolicyRef: string;
  accessPolicySha256: string;
  scope: KnowledgeScope;
}

export interface KnowledgeQueryFixture {
  queryId: string;
  taskId: string;
  usageScope: string;
  query: string;
  maxContextTokens: number;
  expectedSourceRefs: string[];
  expectedUnknown: boolean;
}

export interface KnowledgeConfig {
  schemaVersion: 1;
  libraryId: string;
  sourceRoot: string;
  sources: KnowledgeSourceConfig[];
  policy: {
    allowedTaskIds: string[];
    usageScopes: string[];
    forbiddenContentClasses: string[];
    tokenizer: 'unicode-keyword-bigram-stop-v1';
    ranking: 'matched-token-count+phrase-bonus-v1';
    chunking: 'blank-line-paragraph-v1';
    indexVersion: 'keyword-index-v1';
    topK: number;
    maxSourceBytes: number;
    maxChunkBytes: number;
    maxContextTokens: number;
    tokenEstimate: 'ceil-utf8-bytes-over-3-v1';
  };
  modelBudget: { maxCalls: 0; maxInputTokens: 0; maxOutputTokens: 0 };
  querySet: KnowledgeQueryFixture[];
}

function objectAt(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KnowledgeError('INVALID_CONFIG', `${at} must be an object`, [at]);
  }
  return value as Record<string, unknown>;
}

function exactKeys(obj: Record<string, unknown>, keys: string[], at: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new KnowledgeError('INVALID_CONFIG', `${at} contains unknown field "${key}"`, [`${at}.${key}`]);
  }
  for (const key of keys) {
    if (!(key in obj)) throw new KnowledgeError('INVALID_CONFIG', `${at}.${key} is required`, [`${at}.${key}`]);
  }
}

function stringAt(value: unknown, at: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    throw new KnowledgeError('INVALID_CONFIG', `${at} must be a trimmed non-empty string`, [at]);
  }
  if (pattern && !pattern.test(value)) throw new KnowledgeError('INVALID_CONFIG', `${at} has an invalid format`, [at]);
  return value;
}

function stringArrayAt(value: unknown, at: string, min = 1): string[] {
  if (!Array.isArray(value) || value.length < min) throw new KnowledgeError('INVALID_CONFIG', `${at} must contain at least ${min} strings`, [at]);
  const result = value.map((entry, i) => stringAt(entry, `${at}[${i}]`));
  if (new Set(result).size !== result.length) throw new KnowledgeError('INVALID_CONFIG', `${at} contains duplicates`, [at]);
  return result;
}

function integerAt(value: unknown, at: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new KnowledgeError('INVALID_CONFIG', `${at} must be an integer between ${min} and ${max}`, [at]);
  }
  return value as number;
}

function safeRelativePath(value: unknown, at: string): string {
  const input = stringAt(value, at);
  if (input.includes('\\') || input.startsWith('/') || /^[A-Za-z]:/.test(input) || input.split('/').some((part) => part === '..' || part === '.')) {
    throw new KnowledgeError('INVALID_CONFIG', `${at} must be a normalized relative path without traversal`, [at]);
  }
  return input;
}

export function validateKnowledgeConfig(raw: unknown): KnowledgeConfig {
  const top = objectAt(raw, 'config');
  exactKeys(top, ['schemaVersion', 'libraryId', 'sourceRoot', 'sources', 'policy', 'modelBudget', 'querySet'], 'config');
  if (top.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION) throw new KnowledgeError('INVALID_CONFIG', 'Unsupported knowledge config schemaVersion', ['schemaVersion']);
  const libraryId = stringAt(top.libraryId, 'libraryId', SAFE_ID);
  const sourceRoot = safeRelativePath(top.sourceRoot, 'sourceRoot');
  if (!Array.isArray(top.sources) || top.sources.length < 1) throw new KnowledgeError('INVALID_CONFIG', 'sources must be a non-empty array', ['sources']);
  const sourceIds = new Set<string>();
  const sources = top.sources.map((rawSource, index): KnowledgeSourceConfig => {
    const at = `sources[${index}]`;
    const source = objectAt(rawSource, at);
    exactKeys(source, ['paperId', 'title', 'identifier', 'declaredVersion', 'sourceGroupId', 'sourceUri', 'hostRegisteredFileRef', 'section', 'contentClass', 'sha256', 'qualityStatus', 'accessPolicyRef', 'accessPolicySha256', 'scope'], at);
    const paperId = stringAt(source.paperId, `${at}.paperId`, SAFE_ID);
    const section = stringAt(source.section, `${at}.section`, SAFE_ID);
    const sourceKey = `${paperId}/${section}`;
    if (sourceIds.has(sourceKey)) throw new KnowledgeError('INVALID_CONFIG', `duplicate configured source ${sourceKey}`, [at]);
    sourceIds.add(sourceKey);
    const sourceUri = stringAt(source.sourceUri, `${at}.sourceUri`);
    if (!/^https:\/\//.test(sourceUri)) throw new KnowledgeError('INVALID_CONFIG', `${at}.sourceUri must use HTTPS`, [`${at}.sourceUri`]);
    if (source.qualityStatus !== 'provisional' && source.qualityStatus !== 'verified') {
      throw new KnowledgeError('INVALID_CONFIG', `${at}.qualityStatus must be provisional or verified`, [`${at}.qualityStatus`]);
    }
    if (!['provisional_text', 'public_text', 'verified_observation'].includes(String(source.contentClass))) throw new KnowledgeError('INVALID_CONFIG', `${at}.contentClass is unsupported`, [`${at}.contentClass`]);
    if (['gold', 'sealed', 'final_test', 'evaluator_only'].includes(String(source.contentClass))) throw new KnowledgeError('POLICY_DENIED', `${at}.contentClass is forbidden`, [`${at}.contentClass`]);
    const scopeRaw = objectAt(source.scope, `${at}.scope`);
    exactKeys(scopeRaw, ['usageScopes', 'allowedTaskIds', 'visibleSections', 'forbiddenContentClasses'], `${at}.scope`);
    const hostRegisteredFileRef = safeRelativePath(source.hostRegisteredFileRef, `${at}.hostRegisteredFileRef`);
    if (!/\.(txt|md)$/i.test(hostRegisteredFileRef)) throw new KnowledgeError('INVALID_CONFIG', `${at}.hostRegisteredFileRef must end in .txt or .md`, [`${at}.hostRegisteredFileRef`]);
    return {
      paperId,
      title: stringAt(source.title, `${at}.title`),
      identifier: stringAt(source.identifier, `${at}.identifier`),
      declaredVersion: stringAt(source.declaredVersion, `${at}.declaredVersion`),
      sourceGroupId: stringAt(source.sourceGroupId, `${at}.sourceGroupId`, SAFE_ID),
      sourceUri,
      hostRegisteredFileRef,
      section,
      contentClass: source.contentClass as KnowledgeSourceConfig['contentClass'],
      sha256: stringAt(source.sha256, `${at}.sha256`, SHA256),
      qualityStatus: source.qualityStatus,
      accessPolicyRef: safeRelativePath(source.accessPolicyRef, `${at}.accessPolicyRef`),
      accessPolicySha256: stringAt(source.accessPolicySha256, `${at}.accessPolicySha256`, SHA256),
      scope: {
        usageScopes: stringArrayAt(scopeRaw.usageScopes, `${at}.scope.usageScopes`),
        allowedTaskIds: stringArrayAt(scopeRaw.allowedTaskIds, `${at}.scope.allowedTaskIds`),
        visibleSections: stringArrayAt(scopeRaw.visibleSections, `${at}.scope.visibleSections`),
        forbiddenContentClasses: stringArrayAt(scopeRaw.forbiddenContentClasses, `${at}.scope.forbiddenContentClasses`),
      },
    };
  });

  const policyRaw = objectAt(top.policy, 'policy');
  exactKeys(policyRaw, ['allowedTaskIds', 'usageScopes', 'forbiddenContentClasses', 'tokenizer', 'ranking', 'chunking', 'indexVersion', 'topK', 'maxSourceBytes', 'maxChunkBytes', 'maxContextTokens', 'tokenEstimate'], 'policy');
  if (policyRaw.tokenizer !== 'unicode-keyword-bigram-stop-v1' || policyRaw.ranking !== 'matched-token-count+phrase-bonus-v1' || policyRaw.chunking !== 'blank-line-paragraph-v1' || policyRaw.indexVersion !== 'keyword-index-v1' || policyRaw.tokenEstimate !== 'ceil-utf8-bytes-over-3-v1') {
    throw new KnowledgeError('UNSUPPORTED_CAPABILITY', 'This build supports only the frozen keyword policy v1', ['policy']);
  }
  const policy = {
    allowedTaskIds: stringArrayAt(policyRaw.allowedTaskIds, 'policy.allowedTaskIds'),
    usageScopes: stringArrayAt(policyRaw.usageScopes, 'policy.usageScopes'),
    forbiddenContentClasses: stringArrayAt(policyRaw.forbiddenContentClasses, 'policy.forbiddenContentClasses'),
    tokenizer: policyRaw.tokenizer as KnowledgeConfig['policy']['tokenizer'],
    ranking: policyRaw.ranking as KnowledgeConfig['policy']['ranking'],
    chunking: policyRaw.chunking as KnowledgeConfig['policy']['chunking'],
    indexVersion: policyRaw.indexVersion as KnowledgeConfig['policy']['indexVersion'],
    topK: integerAt(policyRaw.topK, 'policy.topK', 1, 5),
    maxSourceBytes: integerAt(policyRaw.maxSourceBytes, 'policy.maxSourceBytes', 1, 1_048_576),
    maxChunkBytes: integerAt(policyRaw.maxChunkBytes, 'policy.maxChunkBytes', 1, 16_384),
    maxContextTokens: integerAt(policyRaw.maxContextTokens, 'policy.maxContextTokens', 1, 8_192),
    tokenEstimate: policyRaw.tokenEstimate as KnowledgeConfig['policy']['tokenEstimate'],
  };
  for (const source of sources) {
    if (policy.forbiddenContentClasses.includes(source.contentClass)) throw new KnowledgeError('POLICY_DENIED', `source ${source.paperId}/${source.section} has forbidden contentClass ${source.contentClass}`);
    if (!source.scope.allowedTaskIds.every((taskId) => policy.allowedTaskIds.includes(taskId))) throw new KnowledgeError('INVALID_CONFIG', `source ${source.paperId}/${source.section} exceeds policy task scope`);
    if (!source.scope.usageScopes.every((scope) => policy.usageScopes.includes(scope))) throw new KnowledgeError('INVALID_CONFIG', `source ${source.paperId}/${source.section} exceeds policy usage scope`);
  }

  const budget = objectAt(top.modelBudget, 'modelBudget');
  exactKeys(budget, ['maxCalls', 'maxInputTokens', 'maxOutputTokens'], 'modelBudget');
  if (budget.maxCalls !== 0 || budget.maxInputTokens !== 0 || budget.maxOutputTokens !== 0) {
    throw new KnowledgeError('INVALID_CONFIG', 'K0–K3 keyword engineering mode must not make model calls', ['modelBudget']);
  }
  if (!Array.isArray(top.querySet) || top.querySet.length < 6) throw new KnowledgeError('INVALID_CONFIG', 'querySet must contain at least six frozen cases', ['querySet']);
  const queryIds = new Set<string>();
  const querySet = top.querySet.map((rawQuery, index): KnowledgeQueryFixture => {
    const at = `querySet[${index}]`;
    const query = objectAt(rawQuery, at);
    exactKeys(query, ['queryId', 'taskId', 'usageScope', 'query', 'maxContextTokens', 'expectedSourceRefs', 'expectedUnknown'], at);
    const queryId = stringAt(query.queryId, `${at}.queryId`, SAFE_ID);
    if (queryIds.has(queryId)) throw new KnowledgeError('INVALID_CONFIG', `duplicate queryId ${queryId}`, [at]);
    queryIds.add(queryId);
    const taskId = stringAt(query.taskId, `${at}.taskId`, SAFE_ID);
    const usageScope = stringAt(query.usageScope, `${at}.usageScope`, SAFE_ID);
    if (!policy.allowedTaskIds.includes(taskId) || !policy.usageScopes.includes(usageScope)) throw new KnowledgeError('INVALID_CONFIG', `${at} exceeds the frozen policy scope`, [at]);
    if (typeof query.expectedUnknown !== 'boolean') throw new KnowledgeError('INVALID_CONFIG', `${at}.expectedUnknown must be boolean`, [`${at}.expectedUnknown`]);
    const expectedSourceRefs = Array.isArray(query.expectedSourceRefs)
      ? query.expectedSourceRefs.map((v, i) => stringAt(v, `${at}.expectedSourceRefs[${i}]`))
      : (() => { throw new KnowledgeError('INVALID_CONFIG', `${at}.expectedSourceRefs must be an array`, [`${at}.expectedSourceRefs`]); })();
    if (query.expectedUnknown !== (expectedSourceRefs.length === 0)) throw new KnowledgeError('INVALID_CONFIG', `${at} expectedUnknown conflicts with expectedSourceRefs`, [at]);
    if (new Set(expectedSourceRefs).size !== expectedSourceRefs.length || expectedSourceRefs.some((ref) => !sourceIds.has(ref))) throw new KnowledgeError('INVALID_CONFIG', `${at}.expectedSourceRefs contains duplicate or unconfigured source ids`, [`${at}.expectedSourceRefs`]);
    return {
      queryId,
      taskId,
      usageScope,
      query: stringAt(query.query, `${at}.query`),
      maxContextTokens: integerAt(query.maxContextTokens, `${at}.maxContextTokens`, 1, policy.maxContextTokens),
      expectedSourceRefs,
      expectedUnknown: query.expectedUnknown,
    };
  });
  return { schemaVersion: 1, libraryId, sourceRoot, sources, policy, modelBudget: { maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0 }, querySet };
}

export function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface ArtifactRef {
  id: string;
  sha256: string;
}

export function validateArtifactRef(raw: unknown, at: string): ArtifactRef {
  const ref = objectAt(raw, at);
  exactKeys(ref, ['id', 'sha256'], at);
  return { id: stringAt(ref.id, `${at}.id`), sha256: stringAt(ref.sha256, `${at}.sha256`, SHA256) };
}

