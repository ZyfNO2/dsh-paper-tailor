import { ExperimentError, expAssertArray, expAssertArtifactRef, expAssertEnum, expAssertId, expNoExtraKeys, type ArtifactRef } from './experiments.ts';

export interface ResearchReviewIssueInput {
  issueId: string;
  subjectRef: ArtifactRef;
  evidenceRefs: ArtifactRef[];
  reproduction: string;
  repairRequirement: string;
  severity: 'blocking' | 'advisory';
}
export interface ResearchReviewIssue extends ResearchReviewIssueInput {
  reviewerSessionId: string;
  status: 'open' | 'addressed' | 'closed' | 'unresolved';
  repairIds: string[];
  recheckRefs: ArtifactRef[];
  firstErrorRef: ArtifactRef;
}
export interface ResearchRepairAttempt {
  repairId: string;
  issueId: string;
  engineerSessionId: string;
  grantId: string;
  oldSubjectRef: ArtifactRef;
  newSubjectRef: ArtifactRef | null;
  status: 'admitted' | 'submitted' | 'failed';
  diffRef: ArtifactRef | null;
  checkRefs: ArtifactRef[];
  callRefs: ArtifactRef[];
  chargeRef: ArtifactRef;
  firstErrorRef: ArtifactRef;
  failureDiagnosticRef: ArtifactRef | null;
}

export function validateReviewIssueInput(raw: unknown): ResearchReviewIssueInput {
  const o = expNoExtraKeys(raw, ['issueId', 'subjectRef', 'evidenceRefs', 'reproduction', 'repairRequirement', 'severity'], 'ReviewIssue');
  const evidenceRefs = expAssertArray(o.evidenceRefs, 'evidenceRefs').map((ref) => expAssertArtifactRef(ref, 'evidenceRef'));
  if (!evidenceRefs.length || new Set(evidenceRefs.map((ref) => ref.id)).size !== evidenceRefs.length) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'Review evidence must be nonempty and have distinct identities');
  }
  return { issueId: expAssertId(o.issueId, 'issueId'), subjectRef: expAssertArtifactRef(o.subjectRef, 'subjectRef'), evidenceRefs,
    reproduction: expAssertId(o.reproduction, 'reproduction'), repairRequirement: expAssertId(o.repairRequirement, 'repairRequirement'),
    severity: expAssertEnum(o.severity, ['blocking', 'advisory'] as const, 'severity') };
}
