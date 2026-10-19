/**
 * Core DTO contracts, error codes, and strict validation logic.
 * Follows docs/mvp/CONTRACTS.md specifications.
 */

export const ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'OWNER_MISMATCH',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'HOST_BUSY',
  'PREFLIGHT_FAILED',
  'UNSUPPORTED_CAPABILITY',
  'SOURCE_MISMATCH',
  'MODULE_NOT_READY',
  'INCOMPATIBLE_BINDING',
  'POLICY_DENIED',
  'RUN_TIMEOUT',
  'INVALID_RESULT',
  'ARTIFACT_CORRUPT',
  'RECONCILIATION_REQUIRED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class EvolverError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, retryable = false, details?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = 'EvolverError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }

  toAppError(): AppError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export interface AppError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface Command {
  commandId: string;
  taskId: string;
  expectedRevision: number;
}

export interface Receipt {
  commandId: string;
  taskId: string;
  revision: number;
  operationId: string;
}

export type OperationStatus =
  | 'accepted'
  | 'running'
  | 'stopping'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface Operation {
  id: string;
  commandId: string;
  kind: string;
  status: OperationStatus;
  resultRefs: string[];
  error?: AppError;
  createdAt: string;
  updatedAt: string;
}

export interface BaselineRef {
  id: string;
  revision: number;
  sourceHash: string;
  configHash: string;
  adapterId: string;
}

export interface SourceRef {
  paperId: string;
  sourceUri: string;
  documentArtifactId: string;
  documentHash: string;
  locator: string;
  excerptHash: string;
}

export interface ModuleCard {
  id: string;
  revision: number;
  sourceRefs: SourceRef[];
  implementationId: string;
  implementationHash: string;
  inputContract: {
    tensorShape?: number[];
    dtype?: string;
    channels?: number;
  };
  outputContract: {
    tensorShape?: number[];
    dtype?: string;
    channels?: number;
  };
  allowedSlots: string[];
  readyReportId: string;
  status?: 'proposed' | 'ready';
}

export interface Binding {
  slotId: string;
  orderedModuleRefs: string[];
}

export interface AssemblyPlan {
  id: string;
  taskRevision: number;
  protocolHash: string;
  baselineRef: BaselineRef;
  modules: ModuleCard[];
  bindings: Binding[];
  provenance?: Record<string, unknown>;
}

export interface TaskBudget {
  timeoutSec?: number;
  maxCalls?: number;
  maxTokens?: number;
}

export interface TaskSpec {
  protocolId: string;
  baselineRef?: BaselineRef;
  moduleRefs?: string[];
  budget?: TaskBudget;
}

export interface Campaign {
  id: string;
  planHash: string;
  taskSpecSnapshot: TaskSpec;
  matrix: string[];
  status: 'prepared' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  operationId: string;
  runIds: string[];
  error?: AppError;
}

export interface Run {
  id: string;
  campaignId: string;
  variant: 'baseline' | 'a' | 'b' | 'ab';
  attempt: number;
  seed: number;
  stage: 'check' | 'forward' | 'backward' | 'train' | 'evaluate';
  status: 'prepared' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  manifestHash?: string;
  resultRef?: string;
  error?: AppError;
}

export interface Artifact {
  id: string;
  kind: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  producerRunId?: string;
  operationId?: string;
}

export interface Task {
  id: string;
  ownerSessionId: string;
  revision: number;
  title?: string;
  spec: TaskSpec;
  operations: Record<string, Operation>;
  campaigns: Record<string, Campaign>;
  receipts: Record<string, Receipt>;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSnapshot {
  id: string;
  ownerSessionId: string;
  revision: number;
  title?: string;
  spec: TaskSpec;
  operationIds: string[];
  campaignIds: string[];
  createdAt: string;
  updatedAt: string;
}

export function toTaskSnapshot(task: Task): TaskSnapshot {
  return {
    id: task.id,
    ownerSessionId: task.ownerSessionId,
    revision: task.revision,
    title: task.title,
    spec: JSON.parse(JSON.stringify(task.spec)),
    operationIds: Object.keys(task.operations),
    campaignIds: Object.keys(task.campaigns),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

// ----------------- Strict Validation Helpers -----------------

export function assertNoUnknownProperties(
  obj: unknown,
  allowedKeys: readonly string[],
  context: string
): void {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new EvolverError('INVALID_INPUT', `${context} must be a plain object`);
  }
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (!allowedKeys.includes(k)) {
      throw new EvolverError('INVALID_INPUT', `Unknown field "${k}" in ${context}`);
    }
  }
}

export function validateNonEmptyString(val: unknown, fieldName: string): string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new EvolverError('INVALID_INPUT', `Field "${fieldName}" must be a non-empty string`);
  }
  return val.trim();
}

export function validateFiniteNumber(val: unknown, fieldName: string, min = 0): number {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < min) {
    throw new EvolverError(
      'INVALID_INPUT',
      `Field "${fieldName}" must be a finite number >= ${min}, received: ${String(val)}`
    );
  }
  return val;
}

export function validateCommand(raw: unknown): Command {
  if (typeof raw !== 'object' || raw === null) {
    throw new EvolverError('INVALID_INPUT', 'Command must be an object');
  }
  assertNoUnknownProperties(raw, ['commandId', 'taskId', 'expectedRevision'], 'Command');
  const r = raw as Record<string, unknown>;
  const commandId = validateNonEmptyString(r.commandId, 'commandId');
  const taskId = validateNonEmptyString(r.taskId, 'taskId');
  const expectedRevision = validateFiniteNumber(r.expectedRevision, 'expectedRevision', 0);
  return { commandId, taskId, expectedRevision };
}

export function validateTaskSpec(raw: unknown): TaskSpec {
  if (typeof raw !== 'object' || raw === null) {
    throw new EvolverError('INVALID_INPUT', 'TaskSpec must be an object');
  }
  assertNoUnknownProperties(raw, ['protocolId', 'baselineRef', 'moduleRefs', 'budget'], 'TaskSpec');
  const r = raw as Record<string, unknown>;
  const protocolId = validateNonEmptyString(r.protocolId, 'protocolId');

  let budget: TaskBudget | undefined;
  if (r.budget !== undefined) {
    if (typeof r.budget !== 'object' || r.budget === null) {
      throw new EvolverError('INVALID_INPUT', 'TaskBudget must be an object');
    }
    assertNoUnknownProperties(r.budget, ['timeoutSec', 'maxCalls', 'maxTokens'], 'TaskBudget');
    const b = r.budget as Record<string, unknown>;
    budget = {
      ...(b.timeoutSec !== undefined
        ? { timeoutSec: validateFiniteNumber(b.timeoutSec, 'budget.timeoutSec', 1) }
        : {}),
      ...(b.maxCalls !== undefined
        ? { maxCalls: validateFiniteNumber(b.maxCalls, 'budget.maxCalls', 1) }
        : {}),
      ...(b.maxTokens !== undefined
        ? { maxTokens: validateFiniteNumber(b.maxTokens, 'budget.maxTokens', 1) }
        : {}),
    };
  }

  let moduleRefs: string[] | undefined;
  if (r.moduleRefs !== undefined) {
    if (!Array.isArray(r.moduleRefs)) {
      throw new EvolverError('INVALID_INPUT', 'moduleRefs must be an array of strings');
    }
    moduleRefs = r.moduleRefs.map((item, idx) => validateNonEmptyString(item, `moduleRefs[${idx}]`));
  }

  return {
    protocolId,
    ...(r.baselineRef ? { baselineRef: r.baselineRef as BaselineRef } : {}),
    ...(moduleRefs ? { moduleRefs } : {}),
    ...(budget ? { budget } : {}),
  };
}

export * from './acceptance-evidence.ts';
export * from './knowledge.ts';
export * from './search.ts';
export * from './search-feedback.ts';
export * from './research-cycle.ts';
