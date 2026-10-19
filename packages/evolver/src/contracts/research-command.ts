/** New sidecar command boundary; existing Phase 2/3 signatures are unchanged. */
import {
  ExperimentError,
  expAssertArtifactRef,
  expAssertFinite,
  expAssertId,
  expNoExtraKeys,
  type ArtifactRef,
  type ExecutionReceipt,
} from './experiments.ts';

export interface ResearchCommand<P> {
  schemaVersion: 1;
  commandId: string;
  taskId: string;
  expectedRevision: number;
  policyRef: ArtifactRef;
  budgetRef: ArtifactRef | null;
  payload: P;
}

/** A sidecar receipt wraps, rather than redefines, the frozen execution receipt. */
export interface ResearchCommandReceipt {
  schemaVersion: 1;
  receipt: ExecutionReceipt;
  status: 'succeeded' | 'running' | 'failed' | 'blocked';
  resultRefs: ArtifactRef[];
  error: { code: string; message: string; fieldPaths: string[] } | null;
}

export function researchInteger(raw: unknown, at: string, min = 0): number {
  const value = expAssertFinite(raw, at, min);
  if (!Number.isSafeInteger(value)) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${at} must be a safe integer`, { fieldPaths: [at] });
  }
  return value;
}

export function validateResearchCommand<P>(raw: unknown, validatePayload: (raw: unknown) => P): ResearchCommand<P> {
  const o = expNoExtraKeys(raw, [
    'schemaVersion', 'commandId', 'taskId', 'expectedRevision', 'policyRef', 'budgetRef', 'payload',
  ], 'ResearchCommand');
  if (o.schemaVersion !== 1) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'ResearchCommand.schemaVersion must be 1', { fieldPaths: ['schemaVersion'] });
  }
  return {
    schemaVersion: 1,
    commandId: expAssertId(o.commandId, 'commandId'),
    taskId: expAssertId(o.taskId, 'taskId'),
    expectedRevision: researchInteger(o.expectedRevision, 'expectedRevision'),
    policyRef: expAssertArtifactRef(o.policyRef, 'policyRef'),
    budgetRef: o.budgetRef === null ? null : expAssertArtifactRef(o.budgetRef, 'budgetRef'),
    payload: validatePayload(o.payload),
  };
}
