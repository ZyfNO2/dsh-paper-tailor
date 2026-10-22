import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ResearchBootstrapStore,
  requireResearch,
  type MutationContext,
} from "./research-bootstrap-store.ts";
import { GeneralEvidenceReader } from "./general-evidence-service.ts";
import {
  assertGeneralSourceAccess,
  generalSourceAllowed,
} from "./general-source-access.ts";
import {
  digest,
  emptyFoundations,
  validateFoundations,
  protocolSpec,
  runSpec,
  record,
  text,
  id,
  sha,
  integer,
  choice,
  list,
  finite,
  type FoundationState,
  type ProtocolRevision,
  type Measurement,
  type ScreeningDecision,
  type ResearchJob,
  type BiasAssessment,
} from "../contracts/research-foundations.ts";
import {
  validateGeneralEvidenceLocator,
  type GeneralEvidenceLocator,
} from "../contracts/general-evidence.ts";

export interface FoundationActor {
  identity: string;
  human: boolean;
}
export interface FoundationCommand {
  operationId: string;
  baseRevision: number;
  researchId: string;
  action: string;
  payload: unknown;
}
export const normalizeDOI = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const s = text(v, "DOI", 300)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
  if (!/^10\.\d{4,9}\/\S+$/.test(s)) throw new Error("Invalid DOI");
  return s;
};
export function currentProtocol(
  f: FoundationState,
): ProtocolRevision | undefined {
  return f.protocols.findLast((p) => p.status === "frozen");
}
export function latestDecisions(
  f: FoundationState,
  protocolHash: string,
): ScreeningDecision[] {
  const active = new Map<string, ScreeningDecision>();
  for (const d of f.decisions.filter((d) => d.protocolHash === protocolHash))
    active.set(`${d.reportId}:${d.stage}`, d);
  return [...active.values()];
}
export function prismaCounts(f: FoundationState, protocolHash: string) {
  const ds = latestDecisions(f, protocolHash),
    first = ds.filter((d) => d.stage === "title_abstract"),
    full = ds.filter((d) => d.stage === "full_text");
  const included = full.filter((d) => d.decision === "include");
  const reasons: Record<string, number> = {};
  for (const d of full.filter((d) => d.decision === "exclude"))
    reasons[d.criterion] = (reasons[d.criterion] ?? 0) + 1;
  return {
    recordsIdentified: f.papers.reduce((n, p) => n + p.acquisitions.length, 0),
    duplicateRecords: f.papers.reduce(
      (n, p) => n + Math.max(0, p.acquisitions.length - 1),
      0,
    ),
    uniqueReports: f.papers.length,
    titleAbstractScreened: first.filter((d) =>
      ["include", "exclude"].includes(d.decision),
    ).length,
    titleAbstractExcluded: first.filter((d) => d.decision === "exclude").length,
    fullTextAssessed: full.filter((d) =>
      ["include", "exclude"].includes(d.decision),
    ).length,
    fullTextAwaiting: full.filter((d) => d.decision === "awaiting").length,
    fullTextExcluded: full.filter((d) => d.decision === "exclude").length,
    includedReports: included.length,
    includedStudies: new Set(
      included.map(
        (d) => f.papers.find((p) => p.reportId === d.reportId)!.studyId,
      ),
    ).size,
    pendingReports: f.papers.filter(
      (p) =>
        !full.some(
          (d) =>
            d.reportId === p.reportId &&
            ["include", "exclude"].includes(d.decision),
        ) &&
        !first.some(
          (d) => d.reportId === p.reportId && d.decision === "exclude",
        ),
    ).length,
    exclusionReasons: reasons,
  };
}

/** All mutations use the existing cross-process lock, CAS and durable receipts. */
export class ResearchFoundationsService {
  readonly store: ResearchBootstrapStore;
  constructor(store: ResearchBootstrapStore) {
    this.store = store;
  }
  snapshot(researchId: string) {
    const state = this.store.readStateOrEmpty(),
      research = requireResearch(state, id(researchId)),
      f = structuredClone(research.foundations ?? emptyFoundations()),
      p = currentProtocol(f);
    const unavailableMeasurementIds: string[] = [];
    f.measurements = f.measurements.filter((m) => {
      try {
        this.assertMeasurement(researchId, m);
        return true;
      } catch {
        unavailableMeasurementIds.push(m.measurementId);
        return false;
      }
    });
    f.bias = f.bias.filter((b) =>
      b.domains.every((d) => {
        try {
          this.assertLocator(researchId, d.locator);
          return true;
        } catch {
          return false;
        }
      }),
    );
    f.analyses = f.analyses.filter((a) =>
      a.spec.measurementIds.every((mid) =>
        f.measurements.some((m) => m.measurementId === mid),
      ),
    );
    f.publications = f.publications.filter((p) =>
      p.sourceIds.every(
        (sid) =>
          research.general && generalSourceAllowed(research.general, sid),
      ),
    );
    return {
      revision: state.revision,
      researchId,
      researchTitle: research.title,
      foundations: f,
      unavailableMeasurementIds,
      currentProtocolHash: p?.hash ?? null,
      availableSources:
        research.general?.sources
          .filter((s) => generalSourceAllowed(research.general!, s.sourceId))
          .map((s) => ({
            sourceId: s.sourceId,
            filename: s.filename,
            sha256: s.sha256,
          })) ?? [],
      staleMeasurementIds: f.measurements
        .filter((m) => m.protocolHash !== p?.hash)
        .map((m) => m.measurementId),
      prisma:
        p?.spec.mode === "systematic_review" ? prismaCounts(f, p.hash) : null,
      boundary:
        "Located source values and integrity checks are not independent scientific validation.",
    };
  }
  assertLocator(researchId: string, locator: GeneralEvidenceLocator) {
    const state = this.store.readStateOrEmpty(),
      r = requireResearch(state, researchId);
    if (!r.general)
      throw new Error(
        "Located measurements require registered general-research sources; import the material first",
      );
    const result = new GeneralEvidenceReader(
      this.store,
      researchId,
      state,
    ).assertLocator(locator);
    if (result.reasons.length)
      throw new Error(`Evidence is stale: ${result.reasons.join("; ")}`);
    return result;
  }
  assertMeasurement(researchId: string, m: Measurement) {
    const origin = this.assertLocator(researchId, m.locator),
      r = requireResearch(this.store.readStateOrEmpty(), researchId);
    if (
      !r.foundations?.papers
        .find((p) => p.reportId === m.reportId)
        ?.sourceIds.includes(origin.sourceId)
    )
      throw new Error("Measurement source/report binding is no longer valid");
    return origin;
  }
  command(input: FoundationCommand, actor: FoundationActor) {
    record(input, [
      "operationId",
      "baseRevision",
      "researchId",
      "action",
      "payload",
    ]);
    id(input.operationId);
    integer(input.baseRevision);
    id(input.researchId);
    text(actor.identity);
    const action = text(input.action, "action", 100);
    // Slow reads are checked again under the store lock before publication.
    return this.store.mutate({
      operationId: input.operationId,
      baseRevision: input.baseRevision,
      researchId: input.researchId,
      kind: `foundation_${action}`,
      requestPayload: {
        researchId: input.researchId,
        action,
        payload: input.payload,
        actor: actor.identity,
        human: actor.human,
      },
      apply: (context) => {
        const r = requireResearch(context.state, input.researchId),
          f = r.foundations ?? emptyFoundations();
        let result: Record<string, unknown>;
        const human = () => {
          if (!actor.human)
            throw new Error(
              "Human action required to freeze protocols, decide eligibility or authorize execution",
            );
        };
        const frozen = (hash: unknown) => {
          const p = currentProtocol(f);
          if (!p || p.hash !== hash)
            throw new Error("Current frozen protocol required");
          return p;
        };
        if (action === "save_protocol") {
          const v = record(input.payload, [
            "protocolId",
            "status",
            "reason",
            "spec",
          ]);
          const protocolId = id(v.protocolId),
            status = choice(v.status, ["draft", "frozen"]);
          if (status === "frozen") human();
          const spec = protocolSpec(v.spec),
            previous = f.protocols.findLast((p) => p.protocolId === protocolId),
            version = (previous?.version ?? 0) + 1,
            parentHash = previous?.hash ?? null;
          const p: ProtocolRevision = {
            protocolId,
            version,
            parentHash,
            status,
            spec,
            hash: digest({ protocolId, version, parentHash, status, spec }),
            reason: text(v.reason),
            actor: actor.identity,
            createdAt: context.now(),
          };
          f.protocols.push(p);
          result = { protocolId, version, hash: p.hash };
        } else if (action === "register_paper") {
          const v = record(input.payload, [
            "title",
            "doi",
            "aliases",
            "studyId",
            "provider",
            "query",
            "responseHash",
            "acquisitionId",
          ]);
          const title = text(v.title),
            doi = normalizeDOI(v.doi),
            studyId = v.studyId === null ? null : id(v.studyId);
          if (studyId !== null) human();
          let p = doi ? f.papers.find((p) => p.doi === doi) : undefined;
          const acquisition = {
            provider: text(v.provider),
            query: text(v.query),
            retrievedAt: context.now(),
            responseHash: sha(v.responseHash),
          };
          const aliases = list(v.aliases, (x) => text(x), 100);
          if (p) {
            p.acquisitions.push(acquisition);
            p.aliases = [...new Set([...p.aliases, ...aliases])];
            if (studyId && p.studyId !== studyId)
              throw new Error("Existing study identity cannot silently change");
          } else {
            const suffix = randomUUID();
            p = {
              paperId: `paper-${suffix}`,
              reportId: `report-${suffix}`,
              studyId: studyId ?? `study-${suffix}`,
              title,
              doi,
              aliases,
              sourceIds: [],
              acquisitions: [acquisition],
            };
            f.papers.push(p);
          }
          result = {
            paperId: p.paperId,
            reportId: p.reportId,
            studyId: p.studyId,
            approximateCandidates: f.papers
              .filter(
                (x) =>
                  x.reportId !== p!.reportId &&
                  x.title.toLowerCase() === title.toLowerCase(),
              )
              .map((x) => x.reportId),
          };
        } else if (action === "link_report_sources") {
          human();
          const v = record(input.payload, ["reportId", "sourceIds"]);
          const paper = f.papers.find((p) => p.reportId === id(v.reportId));
          if (!paper || !r.general)
            throw new Error("Registered report and source registry required");
          const sourceIds = list(v.sourceIds, id, 100);
          for (const sid of sourceIds) {
            assertGeneralSourceAccess(r.general, sid);
            if (!r.general.sources.some((s) => s.sourceId === sid))
              throw new Error("Source does not belong to this research");
          }
          paper.sourceIds = [...new Set(sourceIds)];
          result = { reportId: paper.reportId };
        } else if (action === "record_measurement") {
          const v = record(input.payload, [
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
          ]);
          const p = frozen(v.protocolHash);
          const reportId = id(v.reportId);
          if (!f.papers.some((x) => x.reportId === reportId))
            throw new Error("Report not registered");
          const locator = validateGeneralEvidenceLocator(v.locator);
          const origin = this.assertLocator(input.researchId, locator);
          if (
            !f.papers
              .find((p) => p.reportId === reportId)!
              .sourceIds.includes(origin.sourceId)
          )
            throw new Error("Source is not bound to this report by a human");
          const m: Measurement = {
            measurementId: context.mint("measurement"),
            reportId,
            protocolHash: p.hash,
            outcome: text(v.outcome),
            value: finite(v.value),
            unit: text(v.unit),
            n: v.n === null ? null : integer(v.n, 1),
            nMeaning: text(v.nMeaning),
            uncertainty: v.uncertainty as Measurement["uncertainty"],
            split: text(v.split),
            method: text(v.method),
            timepoint: text(v.timepoint),
            locator,
            verifiedAt: context.now(),
          };
          const sourceNumbers =
            "quote" in locator
              ? (
                  locator.quote.match(
                    /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g,
                  ) ?? []
                ).map(Number)
              : locator.kind === "table"
                ? (locator.interpreted ?? locator.raw).filter(
                    (x): x is number => typeof x === "number",
                  )
                : locator.kind === "calculation"
                  ? [locator.value]
                  : [];
          if (!sourceNumbers.includes(m.value))
            throw new Error(
              "Measurement value is not present in its exact source locator; register a separate calculation for derived values",
            );
          if (!p.spec.outcomes.includes(m.outcome))
            throw new Error("Outcome not in protocol");
          f.measurements.push(m);
          result = { measurementId: m.measurementId };
        } else if (action === "screen") {
          const v = record(input.payload, [
            "reportId",
            "protocolHash",
            "stage",
            "decision",
            "reason",
            "criterion",
            "confidence",
            "supersedes",
          ]);
          const p = frozen(v.protocolHash);
          if (p.spec.mode !== "systematic_review")
            throw new Error("Review protocol required");
          const reportId = id(v.reportId);
          if (!f.papers.some((x) => x.reportId === reportId))
            throw new Error("Unknown report");
          const stage = choice(v.stage, ["title_abstract", "full_text"]),
            decision = choice(v.decision, [
              "include",
              "exclude",
              "awaiting",
              "conflict",
            ]);
          if (["include", "exclude"].includes(decision)) human();
          const previous = latestDecisions(f, p.hash).find(
              (d) => d.reportId === reportId && d.stage === stage,
            ),
            supersedes = v.supersedes === null ? null : id(v.supersedes);
          if ((previous?.decisionId ?? null) !== supersedes)
            throw new Error("Decision revision conflict");
          if (
            stage === "full_text" &&
            !latestDecisions(f, p.hash).some(
              (d) =>
                d.reportId === reportId &&
                d.stage === "title_abstract" &&
                d.decision === "include",
            )
          )
            throw new Error(
              "Full-text screening requires title/abstract inclusion",
            );
          const criterion = text(v.criterion);
          if (decision === "exclude" && !p.spec.exclusion.includes(criterion))
            throw new Error("Exclusion must cite a frozen protocol criterion");
          const d: ScreeningDecision = {
            decisionId: context.mint("screen"),
            reportId,
            protocolHash: p.hash,
            stage,
            decision,
            reason: text(v.reason),
            criterion,
            actor: actor.identity,
            confidence: v.confidence === null ? null : finite(v.confidence),
            supersedes,
            createdAt: context.now(),
          };
          f.decisions.push(d);
          result = { decisionId: d.decisionId };
          if (stage === "title_abstract" && decision !== "include") {
            const downstream = latestDecisions(f, p.hash).find(
              (x) => x.reportId === reportId && x.stage === "full_text",
            );
            if (downstream)
              f.decisions.push({
                ...downstream,
                decisionId: context.mint("screen"),
                decision: "conflict",
                reason:
                  "Upstream title/abstract decision changed; full-text eligibility requires review",
                actor: actor.identity,
                confidence: null,
                supersedes: downstream.decisionId,
                createdAt: context.now(),
              });
          }
        } else if (action === "record_bias") {
          human();
          const v = record(input.payload, [
            "reportId",
            "protocolHash",
            "tool",
            "domains",
            "reason",
          ]);
          const p = frozen(v.protocolHash);
          const reportId = id(v.reportId);
          if (!f.papers.some((x) => x.reportId === reportId))
            throw new Error("Unknown report");
          const domains = list(
            v.domains,
            (x) => {
              const d = record(x, ["name", "judgement", "locator"]);
              const locator = validateGeneralEvidenceLocator(d.locator);
              const origin = this.assertLocator(input.researchId, locator);
              if (
                !f.papers
                  .find((p) => p.reportId === reportId)!
                  .sourceIds.includes(origin.sourceId)
              )
                throw new Error(
                  "Bias evidence source is not bound to this report",
                );
              return {
                name: text(d.name),
                judgement: text(d.judgement),
                locator,
              };
            },
            20,
          );
          if (!domains.length)
            throw new Error("Bias assessment requires located domains");
          const tool = choice(v.tool, ["ROB2", "ROBINS-I"]),
            names = [
              ...Array.from(
                { length: tool === "ROB2" ? 5 : 7 },
                (_, i) => `D${i + 1}`,
              ),
              "Overall",
            ];
          const judgements =
            tool === "ROB2"
              ? ["Low", "Some concerns", "High"]
              : ["Low", "Moderate", "Serious", "Critical", "No information"];
          if (
            domains.length !== names.length ||
            new Set(domains.map((d) => d.name)).size !== domains.length ||
            domains.some(
              (d) =>
                !names.includes(d.name) || !judgements.includes(d.judgement),
            )
          )
            throw new Error(
              "Provide every canonical bias domain and Overall with the selected tool judgement labels",
            );
          const b: BiasAssessment = {
            reportId,
            protocolHash: p.hash,
            tool,
            domains,
            reviewer: actor.identity,
            reason: text(v.reason),
          };
          f.bias.push(b);
          result = { reportId };
        } else if (action === "create_job") {
          human();
          const spec = runSpec(input.payload),
            p = frozen(spec.protocolHash);
          if (p.spec.mode !== "experiment")
            throw new Error("Experiment protocol required");
          if (
            p.spec.metric !== "mse" ||
            p.spec.unit !== "squared_y" ||
            p.spec.split !== "test" ||
            p.spec.direction !== "minimize"
          )
            throw new Error(
              "linear-regression-v1 requires test mse in squared_y, minimize",
            );
          if (
            f.jobs.filter((j) => j.spec.protocolHash === p.hash).length >=
            p.spec.maxAttempts
          )
            throw new Error("Frozen attempt budget exhausted");
          const job: ResearchJob = {
            jobId: context.mint("job"),
            operationId: input.operationId,
            specHash: digest(spec),
            spec,
            status: "queued",
            attempt: 1,
            externalId: null,
            pid: null,
            processStart: null,
            createdAt: context.now(),
            updatedAt: context.now(),
            error: null,
            metrics: null,
            artifacts: [],
            token: randomUUID(),
          };
          f.jobs.push(job);
          result = { jobId: job.jobId };
        } else throw new Error(`Unsupported foundations action: ${action}`);
        r.foundations = validateFoundations(f);
        r.updatedAt = context.now();
        return { changed: true, result };
      },
    });
  }
  /** Trusted runtime callback; never registered as an Agent-supplied mutation tool. */
  updateJob(
    researchId: string,
    jobId: string,
    operationId: string,
    update: (
      job: ResearchJob,
      context: MutationContext,
      f: FoundationState,
    ) => void,
  ) {
    const revision = this.store.readStateOrEmpty().revision;
    return this.store.mutate({
      operationId,
      baseRevision: revision,
      researchId,
      kind: "foundation_runtime",
      requestPayload: { researchId, jobId, operationId },
      apply: (c) => {
        const r = requireResearch(c.state, researchId),
          f = r.foundations;
        if (!f) throw new Error("Foundations not initialized");
        const j = f.jobs.find((j) => j.jobId === jobId);
        if (!j) throw new Error("Unknown job");
        update(j, c, f);
        j.updatedAt = c.now();
        r.foundations = validateFoundations(f);
        r.updatedAt = c.now();
        return { changed: true, result: { jobId, status: j.status } };
      },
    });
  }
  assetRoot(researchId: string): string {
    return path.join(
      this.store.workspaceRoot,
      ".dsh",
      "research",
      "foundation-assets",
      id(researchId),
    );
  }
}
