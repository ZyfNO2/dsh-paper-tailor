import type {
  ProtocolSpec,
  ProtocolRevision,
  PaperRecord,
  Measurement,
  ScreeningDecision,
  ArtifactFile,
  RunSpec,
  ResearchJob,
  FigureBundle,
  AnalysisSpec,
  AnalysisRecord,
  BiasAssessment,
  FoundationState,
} from "./research-foundation-types.ts";
export type {
  ProtocolSpec,
  ProtocolRevision,
  PaperRecord,
  Measurement,
  ScreeningDecision,
  ArtifactFile,
  RunSpec,
  ResearchJob,
  FigureBundle,
  AnalysisSpec,
  AnalysisRecord,
  BiasAssessment,
  FoundationState,
} from "./research-foundation-types.ts";
/** Versioned scientific records stored by the existing workspace BootstrapStore. */
import { createHash } from "node:crypto";
import {
  validateGeneralEvidenceLocator,
  type GeneralEvidenceLocator,
} from "./general-evidence.ts";

export function digest(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function record(
  v: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !fields.includes(k))
  )
    throw new Error(`Invalid object; allowed fields: ${fields.join(", ")}`);
  return v as Record<string, unknown>;
}
export function text(v: unknown, label = "text", max = 4000): string {
  if (typeof v !== "string" || !v.trim() || v.length > max || v.includes("\0"))
    throw new Error(`Invalid ${label}`);
  return v.trim();
}
export function id(v: unknown): string {
  const s = text(v, "id", 200);
  if (!/^[\w.-]+$/.test(s)) throw new Error("Invalid id");
  return s;
}
export function finite(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new Error("Expected finite number");
  return v;
}
export function integer(v: unknown, min = 0, max = 1000000): number {
  const n = finite(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error("Integer out of range");
  return n;
}
export function list<T>(
  v: unknown,
  parse: (x: unknown) => T,
  max = 10000,
): T[] {
  if (!Array.isArray(v) || v.length > max)
    throw new Error("Invalid bounded array");
  return v.map(parse);
}
export function choice<T extends string>(v: unknown, values: readonly T[]): T {
  if (!values.includes(v as T)) throw new Error(`Expected ${values.join("|")}`);
  return v as T;
}
export function sha(v: unknown): string {
  const s = text(v, "sha256", 64);
  if (!/^[a-f0-9]{64}$/.test(s)) throw new Error("Invalid SHA-256");
  return s;
}
const nullableText = (v: unknown) => (v === null ? null : text(v));
const strings = (v: unknown) => list(v, (x) => text(x), 100);

export function protocolSpec(v: unknown): ProtocolSpec {
  const o = record(v, [
    "mode",
    "question",
    "sources",
    "inclusion",
    "exclusion",
    "outcomes",
    "metric",
    "unit",
    "split",
    "direction",
    "maxAttempts",
    "timeoutSeconds",
    "maxOutputBytes",
  ]);
  const s: ProtocolSpec = {
    mode: choice(o.mode, ["experiment", "systematic_review"]),
    question: text(o.question),
    sources: strings(o.sources),
    inclusion: strings(o.inclusion),
    exclusion: strings(o.exclusion),
    outcomes: strings(o.outcomes),
    metric: text(o.metric),
    unit: text(o.unit),
    split: text(o.split),
    direction: choice(o.direction, ["minimize", "maximize"]),
    maxAttempts: integer(o.maxAttempts, 1, 100),
    timeoutSeconds: integer(o.timeoutSeconds, 1, 86400),
    maxOutputBytes: integer(o.maxOutputBytes, 1024, 1073741824),
  };
  if (
    !s.outcomes.length ||
    (s.mode === "systematic_review" &&
      (!s.sources.length || !s.inclusion.length || !s.exclusion.length))
  )
    throw new Error(
      "Protocol needs outcomes and review eligibility/search sources",
    );
  return s;
}

export const emptyFoundations = (): FoundationState => ({
  schemaVersion: 1,
  protocols: [],
  papers: [],
  measurements: [],
  decisions: [],
  jobs: [],
  figures: [],
  analyses: [],
  bias: [],
  publications: [],
});
export function runSpec(v: unknown): RunSpec {
  const o = record(v, [
    "backend",
    "profile",
    "variant",
    "seed",
    "image",
    "hostId",
    "protocolHash",
  ]);
  const s: RunSpec = {
    backend: choice(o.backend, ["portable_cpu", "docker", "ssh_docker"]),
    profile: choice(o.profile, ["linear-regression-v1"]),
    variant: choice(o.variant, ["baseline", "candidate", "ablation"]),
    seed: integer(o.seed, 0, 2147483647),
    image: nullableText(o.image),
    hostId: o.hostId === null ? null : id(o.hostId),
    protocolHash: sha(o.protocolHash),
  };
  if (
    s.backend !== "portable_cpu" &&
    (!s.image || !/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(s.image))
  )
    throw new Error("Container requires immutable image digest");
  if (
    (s.backend === "portable_cpu" && (s.image !== null || s.hostId !== null)) ||
    (s.backend === "ssh_docker" && !s.hostId) ||
    (s.backend === "docker" && s.hostId !== null)
  )
    throw new Error("Backend/host mismatch");
  return s;
}
export function artifactFiles(v: unknown): ArtifactFile[] {
  return list(
    v,
    (x) => {
      const o = record(x, ["name", "sha256", "bytes"]);
      const name = text(o.name, "artifact name", 200);
      if (!/^[\w.-]+$/.test(name) || name === "." || name === "..")
        throw new Error("Unsafe artifact name");
      return {
        name,
        sha256: sha(o.sha256),
        bytes: integer(o.bytes, 0, 1073741824),
      };
    },
    100,
  );
}
export function analysisSpec(v: unknown): AnalysisSpec {
  const o = record(v, [
    "protocolHash",
    "measurementIds",
    "measure",
    "method",
    "outcome",
    "unit",
    "split",
    "sensitivity",
    "publicationBias",
  ]);
  if (
    typeof o.sensitivity !== "boolean" ||
    typeof o.publicationBias !== "boolean"
  )
    throw new Error("Analysis diagnostics must be boolean");
  return {
    protocolHash: sha(o.protocolHash),
    measurementIds: list(o.measurementIds, id, 2000),
    measure: choice(o.measure, ["GEN"]),
    method: choice(o.method, ["REML", "FE"]),
    outcome: text(o.outcome),
    unit: text(o.unit),
    split: text(o.split),
    sensitivity: o.sensitivity,
    publicationBias: o.publicationBias,
  };
}
/** Strict read validation also protects old-store reads and package imports. */
export function validateFoundations(v: unknown): FoundationState {
  const o = record(v, [
    "schemaVersion",
    "protocols",
    "papers",
    "measurements",
    "decisions",
    "jobs",
    "figures",
    "analyses",
    "bias",
    "publications",
  ]);
  if (o.schemaVersion !== 1)
    throw new Error("Unsupported research foundations schema");
  const result: FoundationState = {
    schemaVersion: 1,
    publications: list(
      o.publications ?? [],
      (x) => {
        const p = record(x, [
          "artifactId",
          "kind",
          "protocolHash",
          "inputHash",
          "sourceIds",
          "files",
          "createdAt",
        ]);
        return {
          artifactId: id(p.artifactId),
          kind: choice(p.kind, ["reports", "reviews", "parses"]),
          protocolHash: p.protocolHash === null ? null : sha(p.protocolHash),
          inputHash: sha(p.inputHash),
          sourceIds: list(p.sourceIds ?? [], id, 100),
          files: artifactFiles(p.files),
          createdAt: text(p.createdAt),
        };
      },
      2000,
    ),
    protocols: list(
      o.protocols,
      (x) => {
        const p = record(x, [
          "protocolId",
          "version",
          "parentHash",
          "hash",
          "status",
          "reason",
          "actor",
          "createdAt",
          "spec",
        ]);
        const spec = protocolSpec(p.spec),
          version = integer(p.version, 1),
          parentHash = p.parentHash === null ? null : sha(p.parentHash);
        const status = choice(p.status, ["draft", "frozen"]);
        const protocolId = id(p.protocolId);
        if (
          digest({ protocolId, version, parentHash, status, spec }) !== p.hash
        )
          throw new Error("Protocol hash mismatch");
        return {
          protocolId,
          version,
          parentHash,
          status,
          spec,
          hash: sha(p.hash),
          reason: text(p.reason),
          actor: text(p.actor),
          createdAt: text(p.createdAt),
        };
      },
      1000,
    ),
    papers: list(o.papers, (x) => {
      const p = record(x, [
        "paperId",
        "reportId",
        "studyId",
        "title",
        "doi",
        "aliases",
        "sourceIds",
        "acquisitions",
      ]);
      return {
        paperId: id(p.paperId),
        reportId: id(p.reportId),
        studyId: id(p.studyId),
        title: text(p.title),
        doi: nullableText(p.doi),
        aliases: strings(p.aliases),
        sourceIds: list(p.sourceIds ?? [], id, 100),
        acquisitions: list(
          p.acquisitions,
          (a) => {
            const z = record(a, [
              "provider",
              "query",
              "retrievedAt",
              "responseHash",
            ]);
            return {
              provider: text(z.provider),
              query: text(z.query),
              retrievedAt: text(z.retrievedAt),
              responseHash: sha(z.responseHash),
            };
          },
          1000,
        ),
      };
    }),
    measurements: list(o.measurements, (x) => {
      const m = record(x, [
        "measurementId",
        "reportId",
        "protocolHash",
        "outcome",
        "value",
        "unit",
        "n",
        "nMeaning",
        "uncertainty",
        "split",
        "method",
        "timepoint",
        "locator",
        "verifiedAt",
      ]);
      let uncertainty: Measurement["uncertainty"] = null;
      if (m.uncertainty !== null) {
        const u = record(m.uncertainty, ["kind", "value"]);
        const value = finite(u.value);
        if (value < 0) throw new Error("Negative uncertainty");
        uncertainty = { kind: choice(u.kind, ["se", "sd", "variance"]), value };
      }
      return {
        measurementId: id(m.measurementId),
        reportId: id(m.reportId),
        protocolHash: sha(m.protocolHash),
        outcome: text(m.outcome),
        value: finite(m.value),
        unit: text(m.unit),
        n: m.n === null ? null : integer(m.n, 1),
        nMeaning: text(m.nMeaning),
        uncertainty,
        split: text(m.split),
        method: text(m.method),
        timepoint: text(m.timepoint),
        locator: validateGeneralEvidenceLocator(m.locator),
        verifiedAt: text(m.verifiedAt),
      };
    }),
    decisions: list(o.decisions, (x) => {
      const d = record(x, [
        "decisionId",
        "reportId",
        "protocolHash",
        "stage",
        "decision",
        "reason",
        "criterion",
        "actor",
        "confidence",
        "supersedes",
        "createdAt",
      ]);
      const confidence = d.confidence === null ? null : finite(d.confidence);
      if (confidence !== null && (confidence < 0 || confidence > 1))
        throw new Error("Confidence out of range");
      return {
        decisionId: id(d.decisionId),
        reportId: id(d.reportId),
        protocolHash: sha(d.protocolHash),
        stage: choice(d.stage, ["title_abstract", "full_text"]),
        decision: choice(d.decision, [
          "include",
          "exclude",
          "awaiting",
          "conflict",
        ]),
        reason: text(d.reason),
        criterion: text(d.criterion),
        actor: text(d.actor),
        confidence,
        supersedes: d.supersedes === null ? null : id(d.supersedes),
        createdAt: text(d.createdAt),
      };
    }),
    jobs: list(
      o.jobs,
      (x) => {
        const j = record(x, [
          "jobId",
          "operationId",
          "specHash",
          "spec",
          "status",
          "attempt",
          "externalId",
          "pid",
          "processStart",
          "createdAt",
          "updatedAt",
          "error",
          "metrics",
          "artifacts",
          "token",
        ]);
        const spec = runSpec(j.spec);
        if (digest(spec) !== j.specHash)
          throw new Error("Job spec hash mismatch");
        let metrics: Record<string, number> | null = null;
        if (j.metrics !== null) {
          if (
            !j.metrics ||
            typeof j.metrics !== "object" ||
            Array.isArray(j.metrics) ||
            Object.keys(j.metrics).length > 50
          )
            throw new Error("Invalid metrics");
          metrics = Object.fromEntries(
            Object.entries(j.metrics).map(([k, v]) => [text(k), finite(v)]),
          );
        }
        return {
          jobId: id(j.jobId),
          operationId: id(j.operationId),
          specHash: sha(j.specHash),
          spec,
          status: choice(j.status, [
            "queued",
            "running",
            "succeeded",
            "failed",
            "cancelled",
            "interrupted",
          ]),
          attempt: integer(j.attempt, 1, 100),
          externalId: nullableText(j.externalId),
          pid: j.pid === null ? null : integer(j.pid, 1, 2147483647),
          processStart: nullableText(j.processStart),
          createdAt: text(j.createdAt),
          updatedAt: text(j.updatedAt),
          error: nullableText(j.error),
          metrics,
          artifacts: artifactFiles(j.artifacts),
          token: id(j.token),
        };
      },
      1000,
    ),
    figures: list(
      o.figures,
      (x) => {
        const f = record(x, [
          "figureId",
          "jobId",
          "parentId",
          "inputHash",
          "files",
          "createdAt",
        ]);
        return {
          figureId: id(f.figureId),
          jobId: id(f.jobId),
          parentId: f.parentId === null ? null : id(f.parentId),
          inputHash: sha(f.inputHash),
          files: artifactFiles(f.files),
          createdAt: text(f.createdAt),
        };
      },
      1000,
    ),
    analyses: list(
      o.analyses,
      (x) => {
        const a = record(x, [
          "analysisId",
          "spec",
          "inputHash",
          "files",
          "createdAt",
        ]);
        return {
          analysisId: id(a.analysisId),
          spec: analysisSpec(a.spec),
          inputHash: sha(a.inputHash),
          files: artifactFiles(a.files),
          createdAt: text(a.createdAt),
        };
      },
      1000,
    ),
    bias: list(
      o.bias,
      (x) => {
        const b = record(x, [
          "reportId",
          "protocolHash",
          "tool",
          "domains",
          "reviewer",
          "reason",
        ]);
        return {
          reportId: id(b.reportId),
          protocolHash: sha(b.protocolHash),
          tool: choice(b.tool, ["ROB2", "ROBINS-I"]),
          domains: list(
            b.domains,
            (d) => {
              const z = record(d, ["name", "judgement", "locator"]);
              return {
                name: text(z.name),
                judgement: text(z.judgement),
                locator: validateGeneralEvidenceLocator(z.locator),
              };
            },
            20,
          ),
          reviewer: text(b.reviewer),
          reason: text(b.reason),
        };
      },
      2000,
    ),
  };
  for (const [key, items] of [
    ["protocols", result.protocols.map((p) => `${p.protocolId}:${p.version}`)],
    ["papers", result.papers.map((p) => p.reportId)],
    ["measurements", result.measurements.map((m) => m.measurementId)],
    ["decisions", result.decisions.map((d) => d.decisionId)],
    ["jobs", result.jobs.map((j) => j.jobId)],
  ] as const)
    if (new Set(items).size !== items.length)
      throw new Error(`Duplicate ${key} identities`);
  return result;
}
