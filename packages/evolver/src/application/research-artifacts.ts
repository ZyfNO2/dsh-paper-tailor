import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  ResearchFoundationsService,
  currentProtocol,
  prismaCounts,
  latestDecisions,
} from "./research-foundations-service.ts";
import {
  ResearchExecutionRuntime,
  checkedDirectory,
  filesAt,
  writeAtomic,
  fileHash,
} from "./research-execution-runtime.ts";
import {
  digest,
  id,
  text,
  analysisSpec,
  validateFoundations,
  type AnalysisRecord,
  type FigureBundle,
  type ArtifactFile,
} from "../contracts/research-foundations.ts";
import { requireResearch } from "./research-bootstrap-store.ts";
import { GeneralMaterialStore } from "./general-material-store.ts";
import { assertGeneralSourceAccess } from "./general-source-access.ts";
import { parseWithGrobid, LiteratureConnector } from "./research-literature.ts";

const worker = (name: string) =>
  fileURLToPath(new URL(`../../../../workers/${name}`, import.meta.url));
const csv = (s: string | number) => '"' + String(s).replace(/"/g, '""') + '"';
function execute(
  command: string,
  args: string[],
  cwd: string,
  timeout = 90000,
  input?: string,
) {
  const r = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    input,
    windowsHide: true,
  });
  if (r.error || r.status !== 0)
    throw new Error(
      `${path.basename(command)}: ${r.error?.message ?? r.stderr.slice(-2000)}`,
    );
  return r.stdout;
}
const tex = (s: string) =>
  s.replace(
    /[\\{}$&#%_^~]/g,
    (c) =>
      ({
        "\\": "\\textbackslash{}",
        "{": "\\{",
        "}": "\\}",
        $: "\\$",
        "&": "\\&",
        "#": "\\#",
        "%": "\\%",
        _: "\\_",
        "^": "\\textasciicircum{}",
        "~": "\\textasciitilde{}",
      })[c]!,
  );

/** Reproducibility publication is separate from computation and happens only on success. */
export class ResearchArtifacts {
  readonly service: ResearchFoundationsService;
  readonly options: {
    python?: string;
    rscript?: string;
    latexmk?: string;
    statisticsImage?: string;
    docker?: string;
  };
  constructor(
    service: ResearchFoundationsService,
    options: {
      python?: string;
      rscript?: string;
      latexmk?: string;
      statisticsImage?: string;
      docker?: string;
    } = {},
  ) {
    this.service = service;
    this.options = options;
  }
  private root(researchId: string, kind: string, key: string) {
    return checkedDirectory(
      this.service.store.workspaceRoot,
      path.join(
        ".dsh",
        "research",
        "foundation-assets",
        id(researchId),
        kind,
        id(key),
      ),
    );
  }
  private publish(
    researchId: string,
    operationId: string,
    payload: Record<string, unknown>,
    apply: (
      f: ReturnType<ResearchFoundationsService["snapshot"]>["foundations"],
    ) => void,
  ) {
    return this.service.store.mutate({
      researchId,
      operationId,
      baseRevision: this.service.store.readStateOrEmpty().revision,
      kind: "foundation_artifact",
      requestPayload: payload,
      apply: (c) => {
        const r = requireResearch(c.state, researchId);
        if (!r.foundations) throw new Error("Foundations missing");
        apply(r.foundations);
        r.foundations = validateFoundations(r.foundations);
        r.updatedAt = c.now();
        return { changed: true, result: payload };
      },
    });
  }
  figure(researchId: string, jobId: string, parentId: string | null = null) {
    const before = this.service.snapshot(researchId),
      job = before.foundations.jobs.find((j) => j.jobId === jobId);
    if (!job || job.status !== "succeeded" || !job.metrics)
      throw new Error("Completed measured job required");
    if (
      parentId &&
      !before.foundations.figures.some(
        (f) => f.figureId === parentId && f.jobId === jobId,
      )
    )
      throw new Error("Figure parent must belong to the same run");
    const runtime = new ResearchExecutionRuntime(this.service);
    for (const a of job.artifacts)
      runtime.artifact(researchId, jobId, a.name, a.sha256);
    const figureId = `figure-${randomUUID()}`,
      root = this.root(researchId, "figures", figureId),
      inputHash = digest({
        jobId,
        metrics: job.metrics,
        artifacts: job.artifacts,
      });
    fs.writeFileSync(
      path.join(root, "data.csv"),
      `variant,mse\n${csv(job.spec.variant)},${job.metrics.mse}\n`,
    );
    fs.copyFileSync(
      worker("research-figure.py"),
      path.join(root, "generate.py"),
    );
    writeAtomic(path.join(root, "spec.json"), {
      schemaVersion: 1,
      jobId,
      inputHash,
      parentId,
      caption:
        "Synthetic regression execution fixture; not a paper reproduction",
    });
    execute(
      this.options.python ?? (process.platform === "win32" ? "python" : "python3"),
      [path.join(root, "generate.py")],
      root,
    );
    const env = JSON.parse(
      fs.readFileSync(path.join(root, "environment.json"), "utf8"),
    );
    fs.writeFileSync(
      path.join(root, "env.lock"),
      `python==${env.python}\nmatplotlib==${env.matplotlib}\n`,
    );
    writeAtomic(path.join(root, "provenance.json"), {
      jobId,
      inputHash,
      sourceArtifacts: job.artifacts,
      generatorHash: fileHash(path.join(root, "generate.py")),
      environment: env,
    });
    const record: FigureBundle = {
      figureId,
      jobId,
      parentId,
      inputHash,
      files: filesAt(root, 32 * 1024 * 1024),
      createdAt: new Date().toISOString(),
    };
    this.publish(
      researchId,
      `publish-${figureId}`,
      { figureId, inputHash },
      (f) => {
        if (
          digest(f.jobs.find((j) => j.jobId === jobId)?.metrics) !==
          digest(job.metrics)
        )
          throw new Error("Run changed during generation");
        f.figures.push(record);
      },
    );
    return record;
  }
  analyze(researchId: string, raw: unknown) {
    const spec = analysisSpec(raw),
      snapshot = this.service.snapshot(researchId),
      f = snapshot.foundations,
      p = currentProtocol(f);
    if (
      !p ||
      p.hash !== spec.protocolHash ||
      p.spec.mode !== "systematic_review"
    )
      throw new Error("Current frozen review protocol required");
    if (
      spec.measurementIds.length < 2 ||
      new Set(spec.measurementIds).size !== spec.measurementIds.length
    )
      throw new Error("Two or more unique effects required");
    const rows = spec.measurementIds.map((mid) => {
      const m = f.measurements.find((m) => m.measurementId === mid);
      if (
        !m ||
        m.protocolHash !== p.hash ||
        m.unit !== spec.unit ||
        m.outcome !== spec.outcome ||
        m.split !== spec.split
      )
        throw new Error(
          "Incompatible effect identity, unit, outcome, split or protocol",
        );
      if (
        !latestDecisions(f, p.hash).some(
          (d) =>
            d.reportId === m.reportId &&
            d.stage === "full_text" &&
            d.decision === "include",
        )
      )
        throw new Error("Synthesis requires full-text inclusion");
      this.service.assertMeasurement(researchId, m);
      if (
        !m.uncertainty ||
        m.uncertainty.kind === "sd" ||
        m.uncertainty.value <= 0
      )
        throw new Error(
          "Generic effect requires explicitly reported positive SE or variance",
        );
      const studyId = f.papers.find((p) => p.reportId === m.reportId)!.studyId;
      return {
        measurementId: m.measurementId,
        studyId,
        yi: m.value,
        vi:
          m.uncertainty.kind === "se"
            ? m.uncertainty.value ** 2
            : m.uncertainty.value,
      };
    });
    if (new Set(rows.map((r) => r.studyId)).size !== rows.length)
      throw new Error(
        "Dependent effects/shared studies require a different prespecified model",
      );
    if (spec.publicationBias && rows.length < 10)
      throw new Error(
        "Publication-bias diagnostics require at least 10 independent studies",
      );
    const analysisId = `analysis-${randomUUID()}`,
      root = this.root(researchId, "analyses", analysisId),
      inputHash = digest({ spec, rows });
    fs.writeFileSync(
      path.join(root, "data.csv"),
      "measurementId,studyId,yi,vi\n" +
        rows
          .map((r) =>
            [r.measurementId, r.studyId, r.yi, r.vi].map(csv).join(","),
          )
          .join("\n") +
        "\n",
    );
    fs.copyFileSync(worker("metafor-analysis.R"), path.join(root, "analyze.R"));
    writeAtomic(path.join(root, "spec.json"), { spec, inputHash, rows });
    if (this.options.statisticsImage) {
      if (!/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(this.options.statisticsImage))
        throw new Error("Statistics image requires immutable digest");
      execute(
        this.options.docker ?? "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--memory",
          "1g",
          "--cpus",
          "1",
          "--pids-limit",
          "128",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=64m",
          "--mount",
          `type=bind,src=${root},dst=/analysis`,
          this.options.statisticsImage,
          "Rscript",
          "--vanilla",
          "/analysis/analyze.R",
          "/analysis/data.csv",
          "/analysis",
          spec.method,
          String(spec.sensitivity),
          String(spec.publicationBias),
        ],
        root,
      );
    } else {
      execute(
        this.options.rscript ?? "Rscript",
        [
          "--vanilla",
          path.join(root, "analyze.R"),
          path.join(root, "data.csv"),
          root,
          spec.method,
          String(spec.sensitivity),
          String(spec.publicationBias),
        ],
        root,
      );
    }
    const result = JSON.parse(
      fs.readFileSync(path.join(root, "results.json"), "utf8"),
    );
    if (result.k !== rows.length || !Number.isFinite(result.estimate))
      throw new Error("Statistics worker output invalid");
    const entry: AnalysisRecord = {
      analysisId,
      spec,
      inputHash,
      files: filesAt(root, 32 * 1024 * 1024),
      createdAt: new Date().toISOString(),
    };
    this.publish(
      researchId,
      `publish-${analysisId}`,
      { analysisId, inputHash },
      (current) => {
        if (
          currentProtocol(current)?.hash !== spec.protocolHash ||
          digest(
            current.measurements.filter((m) =>
              spec.measurementIds.includes(m.measurementId),
            ),
          ) !==
            digest(
              f.measurements.filter((m) =>
                spec.measurementIds.includes(m.measurementId),
              ),
            )
        )
          throw new Error("Analysis inputs changed during computation");
        current.analyses.push(entry);
      },
    );
    return entry;
  }
  reviewExport(researchId: string) {
    const f = this.service.snapshot(researchId).foundations,
      p = currentProtocol(f);
    if (!p || p.spec.mode !== "systematic_review")
      throw new Error("Frozen review protocol required");
    const hash = digest({
        protocol: p.hash,
        papers: f.papers,
        decisions: f.decisions,
        bias: f.bias,
      }),
      root = this.root(researchId, "reviews", hash),
      counts = prismaCounts(f, p.hash);
    writeAtomic(path.join(root, "prisma.json"), {
      protocolHash: p.hash,
      ...counts,
    });
    fs.writeFileSync(
      path.join(root, "screening.csv"),
      "reportId,stage,decision,criterion,reason,actor,protocolHash\n" +
        f.decisions
          .filter((d) => d.protocolHash === p.hash)
          .map((d) =>
            [
              d.reportId,
              d.stage,
              d.decision,
              d.criterion,
              d.reason,
              d.actor,
              d.protocolHash,
            ]
              .map(csv)
              .join(","),
          )
          .join("\n") +
        "\n",
    );
    const active = latestDecisions(f, p.hash);
    writeAtomic(path.join(root, "decisions.json"), {
      history: f.decisions,
      active,
    });
    const boxes = [
      `Records identified: ${counts.recordsIdentified}`,
      `Duplicate records: ${counts.duplicateRecords}`,
      `Reports screened: ${counts.titleAbstractScreened}`,
      `Reports excluded: ${counts.titleAbstractExcluded}`,
      `Full text assessed: ${counts.fullTextAssessed}`,
      `Full text excluded: ${counts.fullTextExcluded}`,
      `Included reports: ${counts.includedReports}`,
      `Included studies: ${counts.includedStudies}`,
      `Awaiting/unresolved reports: ${counts.pendingReports}`,
    ];
    fs.writeFileSync(
      path.join(root, "prisma.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${boxes.length * 60 + 50}" role="img" aria-label="Review flow counts"><rect width="100%" height="100%" fill="white"/>${boxes.map((s, i) => `<rect x="20" y="${i * 60 + 10}" width="560" height="45" rx="4" fill="#edf3f5"/><text x="35" y="${i * 60 + 38}" font-family="sans-serif" font-size="16">${s}</text>`).join("")}</svg>`,
    );
    fs.writeFileSync(
      path.join(root, "bias.csv"),
      "reportId,tool,domain,judgement,reviewer,reason\n" +
        f.bias
          .filter((b) => b.protocolHash === p.hash)
          .flatMap((b) =>
            b.domains.map((d) =>
              [b.reportId, b.tool, d.name, d.judgement, b.reviewer, b.reason]
                .map(csv)
                .join(","),
            ),
          )
          .join("\n") +
        "\n",
    );
    const sought = active.filter(
      (d) => d.stage === "title_abstract" && d.decision === "include",
    ).length;
    const template: Record<string, string | number> = {
      previous_studies: 0,
      previous_reports: 0,
      database_results: counts.recordsIdentified,
      register_results: 0,
      duplicates: counts.duplicateRecords,
      excluded_automatic: 0,
      excluded_other: 0,
      records_screened: counts.titleAbstractScreened,
      records_excluded: counts.titleAbstractExcluded,
      dbr_sought_reports: sought,
      dbr_notretrieved_reports: counts.fullTextAwaiting,
      dbr_assessed: counts.fullTextAssessed,
      dbr_excluded:
        Object.entries(counts.exclusionReasons)
          .map(([reason, n]) => `${reason.replace(/[;,]/g, " ")}, ${n}`)
          .join("; ") || "None, 0",
      new_studies: counts.includedStudies,
      new_reports: counts.includedReports,
    };
    fs.writeFileSync(
      path.join(root, "prisma-template.csv"),
      "data,n\n" +
        Object.entries(template)
          .map(([key, value]) => [key, value].map(csv).join(","))
          .join("\n") +
        "\n",
    );
    fs.copyFileSync(
      worker("prisma-flow.R"),
      path.join(root, "render-prisma.R"),
    );
    for (const tool of ["ROB2", "ROBINS-I"] as const) {
      const names = [
        ...Array.from(
          { length: tool === "ROB2" ? 5 : 7 },
          (_, i) => `D${i + 1}`,
        ),
        "Overall",
      ];
      const latest = new Map(
        f.bias
          .filter((b) => b.protocolHash === p.hash && b.tool === tool)
          .map((b) => [b.reportId, b]),
      );
      if (latest.size)
        fs.writeFileSync(
          path.join(root, `robvis-${tool}.csv`),
          ["Study", ...names].map(csv).join(",") +
            "\n" +
            [...latest.values()]
              .map((b) =>
                [
                  b.reportId,
                  ...names.map(
                    (name) => b.domains.find((d) => d.name === name)!.judgement,
                  ),
                ]
                  .map(csv)
                  .join(","),
              )
              .join("\n") +
            "\n",
        );
    }
    fs.copyFileSync(worker("robvis.R"), path.join(root, "render-bias.R"));
    const files = filesAt(root);
    this.publish(
      researchId,
      `review-${hash}`,
      { reviewId: hash },
      (current) => {
        if (!current.publications.some((p) => p.artifactId === hash))
          current.publications.push({
            artifactId: hash,
            kind: "reviews",
            sourceIds: [
              ...new Set(
                f.bias.flatMap((b) =>
                  b.domains.map(
                    (d) =>
                      this.service.assertLocator(researchId, d.locator)
                        .sourceId,
                  ),
                ),
              ),
            ],
            protocolHash: p.hash,
            inputHash: hash,
            files,
            createdAt: new Date().toISOString(),
          });
      },
    );
    return {
      reviewId: hash,
      counts,
      files,
      boundary:
        "Counts derived from registered decisions. This summary is not a claim of PRISMA checklist compliance.",
    };
  }
  verifyClaims(researchId: string) {
    const f = this.service.snapshot(researchId).foundations,
      p = currentProtocol(f);
    return {
      claims: f.measurements.map((m) => {
        let locatorStatus = "locator_valid";
        try {
          this.service.assertMeasurement(researchId, m);
        } catch {
          locatorStatus = "locator_invalid";
        }
        const quote = "quote" in m.locator ? m.locator.quote : null;
        const numberConsistent =
          quote === null
            ? "not_checked"
            : new RegExp(
                  `(^|[^\\d.])${String(m.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d.])`,
                ).test(quote)
              ? "literal_value_present"
              : "needs_review";
        return {
          measurementId: m.measurementId,
          reportId: m.reportId,
          protocolCurrent: m.protocolHash === p?.hash,
          locatorStatus,
          numberConsistent,
          doi: f.papers.find((p) => p.reportId === m.reportId)?.doi ?? null,
          metadataStatus: "not_checked",
          supportStatus: "needs_human_review",
        };
      }),
      boundary:
        "Literal matching checks location and number spelling only, never entailment, causality or scientific validity",
    };
  }
  async verifyCitations(
    researchId: string,
    connector = new LiteratureConnector(),
  ) {
    const f = this.service.snapshot(researchId).foundations;
    if (f.papers.length > 100)
      throw new Error("Citation verification batch limit is 100 reports");
    const checks = [];
    for (const paper of f.papers) {
      if (!paper.doi) {
        checks.push({ reportId: paper.reportId, status: "missing_doi" });
        continue;
      }
      try {
        checks.push({
          reportId: paper.reportId,
          ...(await connector.doi(paper.doi)),
        });
      } catch (e) {
        checks.push({
          reportId: paper.reportId,
          status: "unavailable",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    const key = `citations-${randomUUID()}`,
      root = this.root(researchId, "reports", key),
      inputHash = digest(
        f.papers.map((p) => ({ reportId: p.reportId, doi: p.doi })),
      );
    writeAtomic(path.join(root, "citation-checks.json"), {
      inputHash,
      checks,
      claims: this.verifyClaims(researchId),
      checkedAt: new Date().toISOString(),
      boundary:
        "Metadata identity and source location do not establish semantic support",
    });
    const files = filesAt(root);
    this.publish(
      researchId,
      `publish-${key}`,
      { citationReportId: key, inputHash },
      (current) => {
        if (
          digest(
            current.papers.map((p) => ({ reportId: p.reportId, doi: p.doi })),
          ) !== inputHash
        )
          throw new Error("Citation inputs changed during checks");
        current.publications.push({
          artifactId: key,
          kind: "reports",
          protocolHash: currentProtocol(current)?.hash ?? null,
          inputHash,
          sourceIds: f.measurements.map(
            (m) => this.service.assertMeasurement(researchId, m).sourceId,
          ),
          files,
          createdAt: new Date().toISOString(),
        });
      },
    );
    return { reportId: key, files, checks };
  }
  renderReview(researchId: string, tool: "PRISMA" | "ROB2" | "ROBINS-I") {
    const exported = this.reviewExport(researchId);
    if (tool === "PRISMA" && exported.counts.pendingReports > 0)
      throw new Error(
        "Finalize eligibility decisions before rendering the completed PRISMA flow",
      );
    const key = `review-${randomUUID()}`,
      root = this.root(researchId, "reviews", key),
      source = this.root(researchId, "reviews", exported.reviewId);
    const csvName =
        tool === "PRISMA" ? "prisma-template.csv" : `robvis-${tool}.csv`,
      script = tool === "PRISMA" ? "prisma-flow.R" : "robvis.R";
    if (!fs.existsSync(path.join(source, csvName)))
      throw new Error(
        "No complete assessment table for the selected bias tool",
      );
    fs.copyFileSync(path.join(source, csvName), path.join(root, csvName));
    fs.copyFileSync(worker(script), path.join(root, "render.R"));
    const output = tool === "PRISMA" ? "prisma2020.svg" : `bias-${tool}.pdf`,
      args = [
        "--vanilla",
        path.join(root, "render.R"),
        path.join(root, csvName),
        path.join(root, output),
      ];
    if (tool !== "PRISMA") args.push(tool);
    execute(this.options.rscript ?? "Rscript", args, root);
    const files = filesAt(root),
      inputHash = digest({ reviewId: exported.reviewId, tool }),
      f = this.service.snapshot(researchId).foundations;
    this.publish(
      researchId,
      `publish-${key}`,
      { reviewId: key, inputHash },
      (current) => {
        current.publications.push({
          artifactId: key,
          kind: "reviews",
          protocolHash: currentProtocol(current)?.hash ?? null,
          inputHash,
          sourceIds: [
            ...new Set(
              f.bias.flatMap((b) =>
                b.domains.map(
                  (d) =>
                    this.service.assertLocator(researchId, d.locator).sourceId,
                ),
              ),
            ),
          ],
          files,
          createdAt: new Date().toISOString(),
        });
      },
    );
    return { reviewId: key, files };
  }
  manuscript(researchId: string) {
    const snapshot = this.service.snapshot(researchId),
      f = snapshot.foundations,
      p = currentProtocol(f);
    if (!p) throw new Error("Frozen protocol required");
    const reportId = `report-${randomUUID()}`,
      root = this.root(researchId, "reports", reportId),
      verification = this.verifyClaims(researchId);
    const jobs = f.jobs.filter(
      (j) => j.status === "succeeded" && j.spec.protocolHash === p.hash,
    );
    const runtime = new ResearchExecutionRuntime(this.service);
    for (const job of jobs)
      for (const a of job.artifacts)
        runtime.artifact(researchId, job.jobId, a.name, a.sha256);
    const lines = jobs.map(
      (j) =>
        `${tex(j.spec.variant)}: test MSE ${tex(String(j.metrics?.mse))}. Synthetic acceptance fixture; not a scientific finding.\\par`,
    );
    for (const m of f.measurements.filter((m) => m.protocolHash === p.hash))
      lines.push(
        `${tex(m.outcome)}: ${tex(String(m.value))} ${tex(m.unit)}. Source: ${tex(f.papers.find((p) => p.reportId === m.reportId)?.doi ?? m.reportId)}. Claim support requires human review.\\par`,
      );
    const currentMeasurements = f.measurements.filter(
      (m) => m.protocolHash === p.hash,
    );
    const citedReports = new Set(currentMeasurements.map((m) => m.reportId));
    const bibliography = f.papers.filter((p) => citedReports.has(p.reportId));
    fs.writeFileSync(
      path.join(root, "references.bib"),
      bibliography
        .map(
          (p) =>
            `@misc{${p.reportId},\n  title={${tex(p.title)}},\n  ${p.doi ? `doi={${tex(p.doi)}},` : ""}\n  note={Metadata identity and scientific support require review}\n}`,
        )
        .join("\n\n"),
    );
    const illustrations: string[] = [];
    for (const job of jobs) {
      const figure = f.figures.findLast((x) => x.jobId === job.jobId),
        pdf = figure?.files.find((a) => a.name === "figure.pdf");
      if (figure && pdf) {
        const name = `figure-${illustrations.length + 1}.pdf`;
        fs.writeFileSync(
          path.join(root, name),
          this.read(
            researchId,
            "figures",
            figure.figureId,
            pdf.name,
            pdf.sha256,
          ),
        );
        illustrations.push(
          `\\begin{figure}[ht]\\centering\\includegraphics[width=.8\\linewidth]{${name}}\\caption{Synthetic execution fixture: ${tex(job.spec.variant)}}\\label{fig:${figure.figureId}}\\end{figure}\\par See Figure~\\ref{fig:${figure.figureId}}.\\par`,
        );
      }
    }
    fs.writeFileSync(
      path.join(root, "measurements.csv"),
      "outcome,value,unit,reportId\n" +
        currentMeasurements
          .map((m) =>
            [m.outcome, m.value, m.unit, m.reportId].map(csv).join(","),
          )
          .join("\n") +
        "\n",
    );
    const source = `\\documentclass{article}\n\\usepackage{fontspec}\n\\usepackage{graphicx}\n\\usepackage[margin=1in]{geometry}\n\\begin{document}\n\\section*{DSH Research Evidence Report}\nProtocol: ${tex(p.hash)}\\par\n${tex(p.spec.question)}\\par\n\\section*{Recorded observations}\n${lines.join("\n") || "No completed observations.\\par"}\n${illustrations.join("\n")}\n${bibliography.length ? "Source records: " + bibliography.map((p) => `\\cite{${p.reportId}}`).join(", ") + ".\n\\bibliographystyle{plain}\n\\bibliography{references}" : ""}\n\\section*{Limitations}\nMachine-assisted draft. Source integrity is not scientific verification. Synthetic fixtures are not paper reproductions. Semantic support and study validity require review.\n\\end{document}\n`;
    fs.writeFileSync(path.join(root, "manuscript.tex"), source);
    writeAtomic(path.join(root, "verification.json"), verification);
    writeAtomic(path.join(root, "manifest.json"), {
      researchId,
      protocolHash: p.hash,
      jobIds: jobs.map((j) => j.jobId),
      sourceHash: digest(source),
      createdAt: new Date().toISOString(),
    });
    execute(
      this.options.latexmk ?? "latexmk",
      [
        "-xelatex",
        "-no-shell-escape",
        "-interaction=nonstopmode",
        "-halt-on-error",
        "manuscript.tex",
      ],
      root,
    );
    if (!fs.existsSync(path.join(root, "manuscript.pdf")))
      throw new Error("Compiler did not produce a PDF");
    const files = filesAt(root, 32 * 1024 * 1024),
      inputHash = digest({
        protocol: p.hash,
        jobs: jobs.map((j) => j.specHash),
        claims: verification,
      });
    this.publish(
      researchId,
      `publish-${reportId}`,
      { reportId, inputHash },
      (current) => {
        if (currentProtocol(current)?.hash !== p.hash)
          throw new Error("Protocol changed during compilation");
        current.publications.push({
          artifactId: reportId,
          kind: "reports",
          sourceIds: [
            ...new Set(
              f.measurements.map(
                (m) => this.service.assertMeasurement(researchId, m).sourceId,
              ),
            ),
          ],
          protocolHash: p.hash,
          inputHash,
          files,
          createdAt: new Date().toISOString(),
        });
      },
    );
    return { reportId, files, verification };
  }
  read(
    researchId: string,
    kind: "figures" | "analyses" | "reviews" | "reports" | "parses",
    key: string,
    name: string,
    expectedHash: string,
  ) {
    const f = this.service.snapshot(researchId).foundations;
    const entry =
      kind === "figures"
        ? f.figures.find((x) => x.figureId === key)
        : kind === "analyses"
          ? f.analyses.find((x) => x.analysisId === key)
          : f.publications.find((x) => x.artifactId === key && x.kind === kind);
    if (!entry?.files.some((a) => a.name === name && a.sha256 === expectedHash))
      throw new Error("Artifact is not registered");
    const root = this.root(researchId, kind, key);
    if (!/^[\w.-]+$/.test(name) || name === ".." || name === ".")
      throw new Error("Unsafe artifact path");
    const p = path.join(root, name),
      s = fs.lstatSync(p);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.size > 32 * 1024 * 1024 ||
      fileHash(p) !== expectedHash
    )
      throw new Error("Artifact hash mismatch");
    return fs.readFileSync(p);
  }
  private source(researchId: string, sourceId: string) {
    const state = this.service.store.readStateOrEmpty(),
      r = requireResearch(state, researchId);
    if (!r.general) throw new Error("General source registry required");
    assertGeneralSourceAccess(r.general, id(sourceId));
    const source = r.general.sources.find((s) => s.sourceId === sourceId);
    if (!source) throw new Error("Source not registered");
    return {
      source,
      bytes: new GeneralMaterialStore(this.service.store.workspaceRoot).readRaw(
        source,
      ),
    };
  }
  async parse(researchId: string, sourceId: string, endpoint: string) {
    const { source, bytes } = this.source(researchId, sourceId);
    if (source.mediaType !== "application/pdf")
      throw new Error("GROBID requires a registered PDF");
    const result = await parseWithGrobid(bytes, endpoint);
    this.source(researchId, sourceId);
    const key = digest({
        sourceId,
        sourceSha256: source.sha256,
        tei: result.tei,
      }),
      root = this.root(researchId, "parses", key);
    fs.writeFileSync(path.join(root, "source.tei.xml"), result.tei);
    writeAtomic(path.join(root, "provenance.json"), {
      sourceId,
      sourceSha256: source.sha256,
      parser: "GROBID",
      boundary: result.boundary,
    });
    const files = filesAt(root, 32 * 1024 * 1024);
    this.publish(researchId, `parse-${key}`, { parseId: key }, (f) => {
      if (!f.publications.some((p) => p.artifactId === key))
        f.publications.push({
          artifactId: key,
          kind: "parses",
          sourceIds: [sourceId],
          protocolHash: null,
          inputHash: source.sha256,
          files,
          createdAt: new Date().toISOString(),
        });
    });
    return { parseId: key, files, boundary: result.boundary };
  }
  queryPapers(researchId: string, sourceIds: string[], question: string) {
    if (
      !Array.isArray(sourceIds) ||
      sourceIds.length < 1 ||
      sourceIds.length > 25 ||
      new Set(sourceIds).size !== sourceIds.length
    )
      throw new Error("Select 1–25 unique admitted sources");
    text(question, "question", 4000);
    const key = `qa-${randomUUID()}`,
      root = this.root(researchId, "qa", key),
      paths = sourceIds.map((sid) => {
        const { source, bytes } = this.source(researchId, sid);
        const extension =
          source.mediaType === "application/pdf"
            ? ".pdf"
            : source.mediaType.startsWith("text/")
              ? ".txt"
              : null;
        if (!extension)
          throw new Error("PaperQA adapter accepts admitted PDFs/text only");
        const target = path.join(root, id(sid) + extension);
        fs.writeFileSync(target, bytes);
        return target;
      });
    try {
      const output = execute(
        this.options.python ?? (process.platform === "win32" ? "python" : "python3"),
        [worker("paperqa-query.py")],
        root,
        180000,
        JSON.stringify({ paths, question }),
      );
      for (const sourceId of sourceIds) this.source(researchId, sourceId);
      return {
        answer: JSON.parse(output),
        boundary:
          "Model synthesis for selected sources; no automatic verified claim publication",
      };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  rank(researchId: string) {
    const snapshot = this.service.snapshot(researchId),
      f = snapshot.foundations,
      p = currentProtocol(f);
    if (!p || p.spec.mode !== "systematic_review")
      throw new Error("Review protocol required");
    const decisions = latestDecisions(f, p.hash);
    const records = f.papers.map((p) => {
      const d = decisions.find(
        (d) => d.reportId === p.reportId && d.stage === "title_abstract",
      );
      return {
        reportId: p.reportId,
        title: p.title,
        label:
          d?.decision === "include" ? 1 : d?.decision === "exclude" ? 0 : null,
      };
    });
    const output = execute(
      this.options.python ?? (process.platform === "win32" ? "python" : "python3"),
      [worker("asreview-rank.py")],
      this.service.store.workspaceRoot,
      90000,
      JSON.stringify({ records }),
    );
    const parsed = JSON.parse(output);
    if (
      !Array.isArray(parsed.rankedReportIds) ||
      parsed.rankedReportIds.some(
        (id: string) =>
          !records.some((r) => r.reportId === id && r.label === null),
      )
    )
      throw new Error("Invalid ranking response");
    return { ...parsed, protocolHash: p.hash };
  }
}
