import { ExperimentError, expAssertArray, expAssertArtifactRef, expAssertId, expNoExtraKeys, type ArtifactRef } from './experiments.ts';

export interface ResearchHandoffInput {
  handoffId: string;
  goal: string;
  dependencies: string[];
  inputRefs: ArtifactRef[];
  expectedOutputs: string[];
  exitCriteria: string;
  deadlineAt: string;
}

export function validateResearchHandoffInput(raw: unknown): ResearchHandoffInput {
  const o = expNoExtraKeys(raw, ['handoffId', 'goal', 'dependencies', 'inputRefs', 'expectedOutputs', 'exitCriteria', 'deadlineAt'], 'handoff');
  const uniqueIds = (value: unknown, field: string): string[] => {
    const values = expAssertArray(value, field).map((entry) => expAssertId(entry, field));
    if (new Set(values).size !== values.length) throw new ExperimentError('SCHEMA_VIOLATION', `${field} has duplicate identifiers`);
    return values;
  };
  const handoffId = expAssertId(o.handoffId, 'handoffId');
  const dependencies = uniqueIds(o.dependencies, 'dependencies');
  if (dependencies.includes(handoffId)) throw new ExperimentError('DEPENDENCY_NOT_READY', 'Handoff cannot depend on itself');
  const expectedOutputs = uniqueIds(o.expectedOutputs, 'expectedOutputs');
  if (!expectedOutputs.length) throw new ExperimentError('SCHEMA_VIOLATION', 'Handoff must declare output kinds');
  const inputRefs = expAssertArray(o.inputRefs, 'inputRefs').map((ref) => expAssertArtifactRef(ref, 'inputRef'));
  if (new Set(inputRefs.map((ref) => ref.id)).size !== inputRefs.length) throw new ExperimentError('SCHEMA_VIOLATION', 'Handoff input refs repeat an identity');
  const deadlineAt = expAssertId(o.deadlineAt, 'deadlineAt');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(deadlineAt) || !Number.isFinite(Date.parse(deadlineAt))) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'Handoff requires an explicit UTC deadline');
  }
  return { handoffId, goal: expAssertId(o.goal, 'goal'), dependencies, inputRefs, expectedOutputs,
    exitCriteria: expAssertId(o.exitCriteria, 'exitCriteria'), deadlineAt };
}

export interface ResearchHandoffRecord extends ResearchHandoffInput {
  fromSessionId: string;
  toSessionId: string;
  grantId: string;
  budgetRef: ArtifactRef;
  status: 'prepared' | 'accepted' | 'completed' | 'failed' | 'cancelled';
  nativeAcceptanceRef: ArtifactRef | null;
  outputs: Array<{ kind: string; ref: ArtifactRef }>;
  failure: string | null;
}
