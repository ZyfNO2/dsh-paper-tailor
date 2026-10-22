/** Browser-safe shared scientific record contracts. */
import type { GeneralEvidenceLocator } from "./general-evidence.ts";

export interface ProtocolSpec {
  mode: "experiment" | "systematic_review";
  question: string;
  sources: string[];
  inclusion: string[];
  exclusion: string[];
  outcomes: string[];
  metric: string;
  unit: string;
  split: string;
  direction: "minimize" | "maximize";
  maxAttempts: number;
  timeoutSeconds: number;
  maxOutputBytes: number;
}
export interface ProtocolRevision {
  protocolId: string;
  version: number;
  parentHash: string | null;
  hash: string;
  status: "draft" | "frozen";
  reason: string;
  actor: string;
  createdAt: string;
  spec: ProtocolSpec;
}
export interface PaperRecord {
  paperId: string;
  reportId: string;
  studyId: string;
  title: string;
  doi: string | null;
  aliases: string[];
  sourceIds: string[];
  acquisitions: Array<{
    provider: string;
    query: string;
    retrievedAt: string;
    responseHash: string;
  }>;
}
export interface Measurement {
  measurementId: string;
  reportId: string;
  protocolHash: string;
  outcome: string;
  value: number;
  unit: string;
  n: number | null;
  nMeaning: string;
  uncertainty: { kind: "se" | "sd" | "variance"; value: number } | null;
  split: string;
  method: string;
  timepoint: string;
  locator: GeneralEvidenceLocator;
  verifiedAt: string;
}
export interface ScreeningDecision {
  decisionId: string;
  reportId: string;
  protocolHash: string;
  stage: "title_abstract" | "full_text";
  decision: "include" | "exclude" | "awaiting" | "conflict";
  reason: string;
  criterion: string;
  actor: string;
  confidence: number | null;
  supersedes: string | null;
  createdAt: string;
}
export interface ArtifactFile {
  name: string;
  sha256: string;
  bytes: number;
}
export interface RunSpec {
  backend: "portable_cpu" | "docker" | "ssh_docker";
  profile: "linear-regression-v1";
  variant: "baseline" | "candidate" | "ablation";
  seed: number;
  image: string | null;
  hostId: string | null;
  protocolHash: string;
}
export interface ResearchJob {
  jobId: string;
  operationId: string;
  specHash: string;
  spec: RunSpec;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  attempt: number;
  externalId: string | null;
  pid: number | null;
  processStart: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  metrics: Record<string, number> | null;
  artifacts: ArtifactFile[];
  token: string;
}
export interface FigureBundle {
  figureId: string;
  jobId: string;
  parentId: string | null;
  inputHash: string;
  files: ArtifactFile[];
  createdAt: string;
}
export interface AnalysisSpec {
  protocolHash: string;
  measurementIds: string[];
  measure: "GEN";
  method: "REML" | "FE";
  outcome: string;
  unit: string;
  split: string;
  sensitivity: boolean;
  publicationBias: boolean;
}
export interface AnalysisRecord {
  analysisId: string;
  spec: AnalysisSpec;
  inputHash: string;
  files: ArtifactFile[];
  createdAt: string;
}
export interface BiasAssessment {
  reportId: string;
  protocolHash: string;
  tool: "ROB2" | "ROBINS-I";
  domains: Array<{
    name: string;
    judgement: string;
    locator: GeneralEvidenceLocator;
  }>;
  reviewer: string;
  reason: string;
}
export interface Publication {
  artifactId: string;
  kind: "reports" | "reviews" | "parses";
  protocolHash: string | null;
  inputHash: string;
  sourceIds: string[];
  files: ArtifactFile[];
  createdAt: string;
}
export interface FoundationState {
  schemaVersion: 1;
  protocols: ProtocolRevision[];
  papers: PaperRecord[];
  measurements: Measurement[];
  decisions: ScreeningDecision[];
  jobs: ResearchJob[];
  figures: FigureBundle[];
  analyses: AnalysisRecord[];
  bias: BiasAssessment[];
  publications: Publication[];
}
