/** Research role configuration. This does not itself grant Host permissions. */
import * as path from 'node:path';
import {
  ExperimentError,
  expAssertArray,
  expAssertArtifactRef,
  expAssertEnum,
  expAssertId,
  expNoExtraKeys,
  type ArtifactRef,
} from './experiments.ts';
import { researchInteger } from './research-command.ts';

export const RESEARCH_ROLES = ['engineer', 'reviewer', 'knowledge_analyst'] as const;
export type ResearchRole = (typeof RESEARCH_ROLES)[number];
export type ResearchToolEffect = 'read' | 'write' | 'execute';

export interface ResearchToolBinding {
  name: string;
  effect: ResearchToolEffect;
}

export interface ResearchRoleConfiguration {
  schemaVersion: 1;
  roleId: ResearchRole;
  version: number;
  systemPromptRef: ArtifactRef;
  policyRef: ArtifactRef;
  tools: ResearchToolBinding[];
  readRoots: string[];
  writeRoots: string[];
  allowedTaskIds: string[];
  allowedInputRefs: ArtifactRef[];
  modelRoute: string;
  context: 'fresh';
  limits: {
    maxModelCalls: number;
    maxTotalTokens: number;
    maxRepairAttempts: number;
    deadlineMs: number;
  };
}

/** Issued by the Host after resolving an exact live member, never self-issued. */
export interface ResearchDelegationGrant {
  schemaVersion: 1;
  grantId: string;
  revision: number;
  taskId: string;
  teamId: string;
  ownerSessionId: string;
  memberSessionId: string;
  memberName: string;
  roleConfigurationRef: ArtifactRef;
  roleConfiguration: ResearchRoleConfiguration;
  policyRef: ArtifactRef;
  budgetRef: ArtifactRef;
  expiresAt: string;
  revoked: boolean;
}

export function validateResearchDelegationGrant(raw: unknown): ResearchDelegationGrant {
  const o = expNoExtraKeys(raw, [
    'schemaVersion', 'grantId', 'revision', 'taskId', 'teamId', 'ownerSessionId',
    'memberSessionId', 'memberName', 'roleConfigurationRef', 'roleConfiguration',
    'policyRef', 'budgetRef', 'expiresAt', 'revoked',
  ], 'ResearchDelegationGrant');
  if (o.schemaVersion !== 1 || typeof o.revoked !== 'boolean' ||
      typeof o.expiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(o.expiresAt) ||
      !Number.isFinite(Date.parse(o.expiresAt))) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'Grant version, revocation or expiry is invalid');
  }
  return {
    schemaVersion: 1,
    grantId: expAssertId(o.grantId, 'grantId'),
    revision: researchInteger(o.revision, 'revision', 1),
    taskId: expAssertId(o.taskId, 'taskId'),
    teamId: expAssertId(o.teamId, 'teamId'),
    ownerSessionId: expAssertId(o.ownerSessionId, 'ownerSessionId'),
    memberSessionId: expAssertId(o.memberSessionId, 'memberSessionId'),
    memberName: expAssertId(o.memberName, 'memberName'),
    roleConfigurationRef: expAssertArtifactRef(o.roleConfigurationRef, 'roleConfigurationRef'),
    roleConfiguration: validateResearchRoleConfiguration(o.roleConfiguration),
    policyRef: expAssertArtifactRef(o.policyRef, 'policyRef'),
    budgetRef: expAssertArtifactRef(o.budgetRef, 'budgetRef'),
    expiresAt: o.expiresAt,
    revoked: o.revoked,
  };
}

function uniqueStrings(raw: unknown, at: string): string[] {
  const values = expAssertArray(raw, at).map((value, index) => expAssertId(value, `${at}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${at} contains duplicates`, { fieldPaths: [at] });
  }
  return values;
}

function roots(raw: unknown, at: string): string[] {
  const values = uniqueStrings(raw, at);
  for (const value of values) {
    if (!path.isAbsolute(value) || value.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(value)) {
      throw new ExperimentError('SCHEMA_VIOLATION', `${at} requires absolute roots without traversal`, { fieldPaths: [at] });
    }
  }
  return values;
}

/** Lexical check only; runtime enforcement must also verify filesystem identity. */
export function researchPathWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function validateResearchRoleConfiguration(raw: unknown): ResearchRoleConfiguration {
  const o = expNoExtraKeys(raw, [
    'schemaVersion', 'roleId', 'version', 'systemPromptRef', 'policyRef', 'tools',
    'readRoots', 'writeRoots', 'allowedTaskIds', 'allowedInputRefs', 'modelRoute', 'context', 'limits',
  ], 'ResearchRoleConfiguration');
  if (o.schemaVersion !== 1 || o.context !== 'fresh') {
    throw new ExperimentError('SCHEMA_VIOLATION', 'Research roles require schemaVersion 1 and fresh context');
  }
  const roleId = expAssertEnum(o.roleId, RESEARCH_ROLES, 'roleId');
  const tools = expAssertArray(o.tools, 'tools').map((rawTool, index): ResearchToolBinding => {
    const tool = expNoExtraKeys(rawTool, ['name', 'effect'], `tools[${index}]`);
    return {
      name: expAssertId(tool.name, `tools[${index}].name`),
      effect: expAssertEnum(tool.effect, ['read', 'write', 'execute'] as const, `tools[${index}].effect`),
    };
  });
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'Tool names must be unique');
  }
  const readRoots = roots(o.readRoots, 'readRoots');
  const writeRoots = roots(o.writeRoots, 'writeRoots');
  if (writeRoots.some((root) => !readRoots.some((readRoot) => researchPathWithin(readRoot, root)))) {
    throw new ExperimentError('POLICY_DENIED', 'Every write root must lie within a read root');
  }
  if (roleId !== 'engineer' && (writeRoots.length > 0 || tools.some((tool) => tool.effect !== 'read'))) {
    throw new ExperimentError('POLICY_DENIED', `${roleId} may only use read tools with no file write roots`);
  }
  const allowedTaskIds = uniqueStrings(o.allowedTaskIds, 'allowedTaskIds');
  if (allowedTaskIds.length === 0) throw new ExperimentError('POLICY_DENIED', 'Role requires an explicit task scope');
  const allowedInputRefs = expAssertArray(o.allowedInputRefs, 'allowedInputRefs')
    .map((ref, index) => expAssertArtifactRef(ref, `allowedInputRefs[${index}]`));
  if (new Set(allowedInputRefs.map((ref) => ref.id)).size !== allowedInputRefs.length) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'Input ref ids must be unique, including across versions');
  }
  const limits = expNoExtraKeys(o.limits, [
    'maxModelCalls', 'maxTotalTokens', 'maxRepairAttempts', 'deadlineMs',
  ], 'limits');
  return {
    schemaVersion: 1,
    roleId,
    version: researchInteger(o.version, 'version', 1),
    systemPromptRef: expAssertArtifactRef(o.systemPromptRef, 'systemPromptRef'),
    policyRef: expAssertArtifactRef(o.policyRef, 'policyRef'),
    tools,
    readRoots,
    writeRoots,
    allowedTaskIds,
    allowedInputRefs,
    modelRoute: expAssertId(o.modelRoute, 'modelRoute'),
    context: 'fresh',
    limits: {
      maxModelCalls: researchInteger(limits.maxModelCalls, 'limits.maxModelCalls', 1),
      maxTotalTokens: researchInteger(limits.maxTotalTokens, 'limits.maxTotalTokens', 1),
      maxRepairAttempts: researchInteger(limits.maxRepairAttempts, 'limits.maxRepairAttempts'),
      deadlineMs: researchInteger(limits.deadlineMs, 'limits.deadlineMs', 1),
    },
  };
}
