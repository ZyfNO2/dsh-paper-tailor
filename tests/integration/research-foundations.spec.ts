import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ResearchBootstrapStore } from "../../packages/evolver/src/application/research-bootstrap-store.ts";
import { GeneralResearchService } from "../../packages/evolver/src/application/general-research-service.ts";
import { GeneralEvidenceService } from "../../packages/evolver/src/application/general-evidence-service.ts";
import { GeneralDataService } from "../../packages/evolver/src/application/general-data-service.ts";
import {
  ResearchFoundationsService,
  prismaCounts,
} from "../../packages/evolver/src/application/research-foundations-service.ts";
import {
  ResearchExecutionRuntime,
  fileHash,
  processStart,
} from "../../packages/evolver/src/application/research-execution-runtime.ts";
import { ResearchArtifacts } from "../../packages/evolver/src/application/research-artifacts.ts";
import {
  LiteratureConnector,
  parseWithGrobid,
} from "../../packages/evolver/src/application/research-literature.ts";
import {
  digest,
  validateFoundations,
  type ProtocolSpec,
} from "../../packages/evolver/src/contracts/research-foundations.ts";

const actor = { identity: "human:test", human: true };
const spec: ProtocolSpec = {
  mode: "experiment",
  question:
    "Can a declared regression model improve a fixed synthetic baseline?",
  sources: ["synthetic fixture"],
  inclusion: [],
  exclusion: [],
  outcomes: ["mse"],
  metric: "mse",
  unit: "squared_y",
  split: "test",
  direction: "minimize",
  maxAttempts: 5,
  timeoutSeconds: 10,
  maxOutputBytes: 1048576,
};
const review: ProtocolSpec = {
  ...spec,
  mode: "systematic_review",
  question: "Which reports meet the frozen criteria?",
  sources: ["crossref"],
  inclusion: ["independent controlled measurement"],
  exclusion: ["wrong population"],
  outcomes: ["mean_effect"],
  metric: "mean_effect",
  unit: "units",
  split: "reported",
};
function setup(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-foundations-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ResearchBootstrapStore(root),
    researchId = new GeneralResearchService(store).create({
      operationId: "create",
      baseRevision: 0,
      title: "Foundations test",
      question: "Test scoped scientific state",
      domains: [],
      methods: ["algorithm"],
      entryMode: "existing_data",
    }).result.researchId;
  const service = new ResearchFoundationsService(store);
  let seq = 0;
  const write = () => ({
    operationId: `write-${++seq}`,
    baseRevision: store.readStateOrEmpty().revision,
    researchId,
  });
  const command = (action: string, payload: unknown) =>
    service.command({ ...write(), action, payload }, actor);
  const freeze = (s = spec) =>
    command("save_protocol", {
      protocolId: "main",
      status: "frozen",
      reason: "Prespecified test plan",
      spec: s,
    }).result.hash as string;
  const paper = (doi = "10.1234/example", studyId: string | null = null) =>
    command("register_paper", {
      title: "Example report",
      doi,
      aliases: [],
      studyId,
      provider: "fixture",
      query: "test",
      responseHash: digest(doi),
    }).result.reportId as string;
  const source = (content = "Mean effect: 1.2 units. SE 0.3. Sample n=20.") => {
    const imported = new GeneralDataService(store).importMaterial({
      ...write(),
      filename: "source.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from(content).toString("base64"),
      nature: "literature",
      description: "Explicit source fixture",
      purpose: "Test exact source location",
      previousSourceId: null,
    });
    const s = store
      .readStateOrEmpty()
      .researches[0].general!.sources.find(
        (s) => s.sourceId === imported.result.sourceId,
      )!;
    const paper = service.snapshot(researchId).foundations.papers.at(-1);
    if (paper)
      command("link_report_sources", {
        reportId: paper.reportId,
        sourceIds: [s.sourceId],
      });
    return {
      kind: "text" as const,
      sourceId: s.sourceId,
      sourceSha256: s.sha256,
      startByte: 0,
      endByte: Buffer.byteLength(content),
      quote: content,
    };
  };
  const job = (hash: string, variant = "candidate", backend = "portable_cpu") =>
    command("create_job", {
      backend,
      profile: "linear-regression-v1",
      variant,
      seed: 20261022,
      image:
        backend === "portable_cpu" ? null : "python@sha256:" + "a".repeat(64),
      hostId: null,
      protocolHash: hash,
    }).result.jobId as string;
  return {
    root,
    store,
    researchId,
    service,
    write,
    command,
    freeze,
    paper,
    source,
    job,
  };
}
const pause = () => new Promise((r) => setTimeout(r, 50));
async function wait(
  runtime: ResearchExecutionRuntime,
  researchId: string,
  jobId: string,
) {
  let j = runtime.job(researchId, jobId);
  const deadline = Date.now() + 15000;
  while (["queued", "running"].includes(j.status) && Date.now() < deadline) {
    await pause();
    j = runtime.reconcile(researchId, jobId);
  }
  return j;
}

test("legacy workspaces stay readable; immutable protocols enforce CAS, idempotency and human freeze", (t) => {
  const f = setup(t);
  assert.equal(
    f.service.snapshot(f.researchId).foundations.protocols.length,
    0,
  );
  const request = {
    ...f.write(),
    action: "save_protocol",
    payload: {
      protocolId: "main",
      status: "frozen",
      reason: "First frozen plan",
      spec,
    },
  };
  assert.throws(
    () => f.service.command(request, { identity: "agent", human: false }),
    /Human action/,
  );
  const saved = f.service.command(request, actor);
  assert.equal(f.service.command(request, actor).replayed, true);
  assert.throws(
    () =>
      f.service.command(
        {
          ...request,
          payload: { ...request.payload, reason: "Different semantics" },
        },
        actor,
      ),
    /different|IDEMPOTENCY/,
  );
  assert.throws(
    () =>
      f.service.command({ ...request, operationId: "stale-command" }, actor),
    /revision/,
  );
  const old = f.service.snapshot(f.researchId).foundations.protocols[0];
  const next = f.freeze({ ...spec, question: "A revised question" });
  assert.notEqual(next, saved.result.hash);
  assert.deepEqual(
    f.service.snapshot(f.researchId).foundations.protocols[0],
    old,
  );
  const forged = structuredClone(f.service.snapshot(f.researchId).foundations);
  forged.protocols[0].spec.question = "Forged";
  assert.throws(() => validateFoundations(forged), /hash/);
});

test("DOI aliases deduplicate acquisitions; same-title reports remain distinct unless identity is explicit", (t) => {
  const f = setup(t);
  const first = f.paper("https://doi.org/10.1234/EXAMPLE"),
    second = f.paper("10.1234/example");
  assert.equal(first, second);
  const third = f.paper(null as unknown as string);
  assert.notEqual(first, third);
  const papers = f.service.snapshot(f.researchId).foundations.papers;
  assert.equal(papers.length, 2);
  assert.equal(papers[0].acquisitions.length, 2);
});

test("measurements require exact live source bytes; protocol changes mark them stale", (t) => {
  const f = setup(t),
    hash = f.freeze(review),
    reportId = f.paper(),
    locator = f.source();
  const payload = {
    reportId,
    protocolHash: hash,
    outcome: "mean_effect",
    value: 1.2,
    unit: "units",
    n: 20,
    nMeaning: "participants",
    uncertainty: { kind: "se", value: 0.3 },
    split: "reported",
    method: "source reported mean difference",
    timepoint: "endpoint",
    locator,
  };
  assert.throws(
    () =>
      f.command("record_measurement", {
        ...payload,
        locator: { ...locator, quote: "invented quote" },
      }),
    /quote|original|range/i,
  );
  assert.throws(
    () => f.command("record_measurement", { ...payload, value: Infinity }),
    /finite/,
  );
  f.command("record_measurement", payload);
  assert.equal(
    f.service.snapshot(f.researchId).foundations.measurements.length,
    1,
  );
  f.freeze({ ...review, question: "Revised eligibility question" });
  assert.equal(f.service.snapshot(f.researchId).staleMeasurementIds.length, 1);
  const report = new ResearchArtifacts(f.service).verifyClaims(f.researchId);
  assert.equal(report.claims[0].numberConsistent, "literal_value_present");
  assert.equal(report.claims[0].supportStatus, "needs_human_review");
});

test("screening has two stages, immutable reasons and reversible decision history; PRISMA counts distinguish reports and studies", (t) => {
  const f = setup(t),
    hash = f.freeze(review),
    reportId = f.paper();
  let latest: string | null = null;
  const decision = (
    stage: string,
    value: string,
    criterion = "independent controlled measurement",
  ) =>
    f.command("screen", {
      reportId,
      protocolHash: hash,
      stage,
      decision: value,
      reason: "Human reviewed original eligibility",
      criterion,
      confidence: null,
      supersedes: latest,
    });
  assert.throws(() => decision("full_text", "include"), /title\/abstract/);
  decision("title_abstract", "include");
  decision("full_text", "awaiting");
  latest = f.service
    .snapshot(f.researchId)
    .foundations.decisions.at(-1)!.decisionId;
  assert.equal(
    prismaCounts(f.service.snapshot(f.researchId).foundations, hash)
      .includedReports,
    0,
  );
  assert.throws(
    () => decision("full_text", "exclude", "not prespecified"),
    /criterion/,
  );
  decision("full_text", "include");
  const state = f.service.snapshot(f.researchId).foundations,
    counts = prismaCounts(state, hash);
  assert.equal(counts.includedStudies, 1);
  assert.equal(counts.fullTextAwaiting, 0);
  assert.equal(state.decisions.length, 3);
  const exportRecord = new ResearchArtifacts(f.service).reviewExport(
    f.researchId,
  );
  assert.ok(exportRecord.files.some((a) => a.name === "screening.csv"));
});

test("real CPU baseline/candidate/ablation execute; new Host instance collects without duplicate launch; figures and PDF rebuild", async (t) => {
  const f = setup(t),
    hash = f.freeze(),
    runtime = new ResearchExecutionRuntime(f.service);
  const jobs = [];
  for (const variant of ["baseline", "candidate", "ablation"]) {
    const jobId = f.job(hash, variant);
    runtime.submit(f.researchId, jobId);
    const next = new ResearchExecutionRuntime(
      new ResearchFoundationsService(new ResearchBootstrapStore(f.root)),
    );
    next.submit(f.researchId, jobId);
    const job = await wait(next, f.researchId, jobId);
    assert.equal(job.status, "succeeded", job.error ?? "");
    assert.ok(job.artifacts.some((a) => a.name === "metrics.json"));
    jobs.push(job);
  }
  assert.ok(jobs[0].metrics!.mse > 20);
  assert.ok(jobs[1].metrics!.mse < 0.02);
  assert.ok(jobs[2].metrics!.mse > 1);
  const measured = jobs[1].artifacts.find((a) => a.name === "metrics.json")!;
  assert.ok(
    runtime.artifact(
      f.researchId,
      jobs[1].jobId,
      measured.name,
      measured.sha256,
    ).length,
  );
  const originalMetrics = fs.readFileSync(
    path.join(runtime.jobRoot(f.researchId, jobs[1].jobId), "metrics.json"),
  );
  fs.appendFileSync(
    path.join(runtime.jobRoot(f.researchId, jobs[1].jobId), "metrics.json"),
    " ",
  );
  assert.throws(
    () =>
      runtime.artifact(
        f.researchId,
        jobs[1].jobId,
        measured.name,
        measured.sha256,
      ),
    /changed/,
  );
  fs.writeFileSync(
    path.join(runtime.jobRoot(f.researchId, jobs[1].jobId), "metrics.json"),
    originalMetrics,
  );
  const artifacts = new ResearchArtifacts(f.service);
  const figure = artifacts.figure(f.researchId, jobs[0].jobId);
  assert.ok(figure.files.some((a) => a.name === "figure.pdf"));
  assert.ok(figure.files.some((a) => a.name === "env.lock"));
  if (spawnSync("latexmk", ["-v"], { stdio: "ignore" }).status === 0) {
    const manuscript = artifacts.manuscript(f.researchId);
    assert.ok(manuscript.files.some((a) => a.name === "manuscript.pdf"));
  }
});

test("durable worker cancellation terminates the running child and does not publish successful metrics", async (t) => {
  const f = setup(t),
    hash = f.freeze(),
    profile = path.join(f.root, "profile");
  fs.mkdirSync(profile);
  const original = fileURLToPath(
    new URL("../../fixtures/portable-regression-v1/", import.meta.url),
  );
  for (const n of ["runner.py", "evaluate.py", "worker.py", "data.csv"])
    fs.copyFileSync(path.join(original, n), path.join(profile, n));
  fs.writeFileSync(
    path.join(profile, "runner.py"),
    "import time\ntime.sleep(20)\n" +
      fs.readFileSync(path.join(profile, "runner.py"), "utf8"),
  );
  const runtime = new ResearchExecutionRuntime(f.service, {
      profileRoot: profile,
    }),
    jobId = f.job(hash);
  runtime.submit(f.researchId, jobId);
  await new Promise((r) => setTimeout(r, 200));
  const pid = runtime.job(f.researchId, jobId).pid!;
  runtime.cancel(f.researchId, jobId);
  const job = await wait(runtime, f.researchId, jobId);
  assert.equal(job.status, "cancelled");
  assert.equal(job.metrics, null);
  await pause();
  if (fs.existsSync("/proc/self/stat")) assert.equal(processStart(pid), null);
});

test("container spec fails closed on mutable images and command injection; missing Docker is a failed job, never fake success", (t) => {
  const f = setup(t),
    hash = f.freeze();
  assert.throws(
    () =>
      f.command("create_job", {
        backend: "docker",
        profile: "linear-regression-v1",
        variant: "baseline",
        seed: 1,
        image: "python:latest",
        hostId: null,
        protocolHash: hash,
      }),
    /digest/,
  );
  assert.throws(
    () =>
      f.command("create_job", {
        backend: "portable_cpu",
        profile: "linear-regression-v1",
        variant: "baseline",
        seed: 1,
        image: null,
        hostId: null,
        protocolHash: hash,
        command: "touch /tmp/unsafe",
      }),
    /allowed fields/,
  );
  const jobId = f.job(hash, "baseline", "docker"),
    runtime = new ResearchExecutionRuntime(f.service, {
      docker: path.join(f.root, "missing-docker"),
    });
  assert.throws(() => runtime.submit(f.researchId, jobId), /failed/);
  assert.equal(runtime.job(f.researchId, jobId).status, "failed");
});

test("meta-analysis rejects missing variance, dependent studies and incompatible outcomes before invoking R", (t) => {
  const f = setup(t),
    hash = f.freeze(review),
    artifacts = new ResearchArtifacts(f.service),
    reportId = f.paper(),
    locator = f.source();
  const m = {
    reportId,
    protocolHash: hash,
    outcome: "mean_effect",
    value: 1.2,
    unit: "units",
    n: 20,
    nMeaning: "participants",
    uncertainty: null,
    split: "reported",
    method: "reported effect",
    timepoint: "endpoint",
    locator,
  };
  f.command("screen", {
    reportId,
    protocolHash: hash,
    stage: "title_abstract",
    decision: "include",
    reason: "Human inclusion",
    criterion: "independent controlled measurement",
    confidence: null,
    supersedes: null,
  });
  f.command("screen", {
    reportId,
    protocolHash: hash,
    stage: "full_text",
    decision: "include",
    reason: "Human inclusion",
    criterion: "independent controlled measurement",
    confidence: null,
    supersedes: null,
  });
  f.command("record_measurement", m);
  f.command("record_measurement", {
    ...m,
    uncertainty: { kind: "se", value: 0.3 },
  });
  const ids = f.service
    .snapshot(f.researchId)
    .foundations.measurements.map((m) => m.measurementId);
  const input = {
    protocolHash: hash,
    measurementIds: ids,
    measure: "GEN",
    method: "REML",
    outcome: "mean_effect",
    unit: "units",
    split: "reported",
    sensitivity: true,
    publicationBias: false,
  };
  assert.throws(() => artifacts.analyze(f.researchId, input), /SE or variance/);
  f.command("record_measurement", {
    ...m,
    uncertainty: { kind: "se", value: 0.3 },
  });
  const dependentIds = f.service
    .snapshot(f.researchId)
    .foundations.measurements.slice(-2)
    .map((m) => m.measurementId);
  assert.throws(
    () =>
      artifacts.analyze(f.researchId, {
        ...input,
        measurementIds: dependentIds,
      }),
    /Dependent effects/,
  );
  assert.throws(
    () => artifacts.analyze(f.researchId, { ...input, unit: "different" }),
    /Incompatible/,
  );
});

test("revocation hides located observations and denies previously registered report downloads", (t) => {
  const f = setup(t),
    hash = f.freeze(review),
    reportId = f.paper(),
    locator = f.source();
  f.command("record_measurement", {
    reportId,
    protocolHash: hash,
    outcome: "mean_effect",
    value: 1.2,
    unit: "units",
    n: 20,
    nMeaning: "participants",
    uncertainty: { kind: "se", value: 0.3 },
    split: "reported",
    method: "reported effect",
    timepoint: "endpoint",
    locator,
  });
  const artifacts = new ResearchArtifacts(f.service);
  const exported = artifacts.reviewExport(f.researchId);
  const item =
    exported.files.find((x) => x.name === "screening-history.json") ??
    exported.files[0];
  // Compile with a real DOI citation as well as the numeric source, when TeX exists.
  if (spawnSync("latexmk", ["-v"], { stdio: "ignore" }).status === 0) {
    const report = artifacts.manuscript(f.researchId);
    assert.ok(report.files.some((x) => x.name === "manuscript.pdf"));
    assert.ok(report.files.some((x) => x.name === "references.bib"));
    const access = new GeneralEvidenceService(f.store);
    access.setAccess(
      {
        ...f.write(),
        sourceId: locator.sourceId,
        allowed: false,
        reason: "Human withdrawal",
      },
      actor.identity,
    );
    assert.equal(
      f.service.snapshot(f.researchId).foundations.measurements.length,
      0,
    );
    assert.equal(
      f.service.snapshot(f.researchId).unavailableMeasurementIds.length,
      1,
    );
    const pdf = report.files.find((x) => x.name === "manuscript.pdf")!;
    assert.throws(
      () =>
        artifacts.read(
          f.researchId,
          "reports",
          report.reportId,
          pdf.name,
          pdf.sha256,
        ),
      /not registered/,
    );
    // Existing scope history remains auditable; it does not grant evidence access.
    assert.ok(
      artifacts.read(
        f.researchId,
        "reviews",
        exported.reviewId,
        item.name,
        item.sha256,
      ).length,
    );
  }
});

test("connectors preserve query/cursor and responses; GROBID rejects XML entities; rate-limit errors stay errors", async () => {
  const fetcher = (async (url: URL | string) => {
    assert.match(String(url), /api.crossref.org/);
    return new Response(
      JSON.stringify({
        message: {
          items: [{ title: ["Example"], DOI: "10.1234/ABC" }],
          "next-cursor": "next",
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const result = await new LiteratureConnector({ fetch: fetcher }).search(
    "crossref",
    "test query",
  );
  assert.equal(result.hits[0].doi, "10.1234/abc");
  assert.equal(result.nextPage, "next");
  assert.match(result.responseHash, /^[a-f0-9]{64}$/);
  await assert.rejects(
    () =>
      new LiteratureConnector({
        fetch: (async () =>
          new Response("", {
            status: 429,
            headers: { "retry-after": "10" },
          })) as typeof fetch,
      }).search("openalex", "test"),
    /429.*10/,
  );
  await assert.rejects(
    () =>
      parseWithGrobid(
        new Uint8Array([1]),
        "http://localhost:8070",
        (async () =>
          new Response("<!DOCTYPE TEI><TEI/>", {
            status: 200,
          })) as typeof fetch,
      ),
    /unsafe TEI/,
  );
});

test("R/metafor reference analysis is an explicit external gate", (t) => {
  const available =
    spawnSync(
      "Rscript",
      [
        "--vanilla",
        "-e",
        "quit(status=if(requireNamespace('metafor',quietly=TRUE))0 else 1)",
      ],
      { stdio: "ignore" },
    ).status === 0;
  if (!available) {
    t.skip(
      "R/metafor is not installed; production worker remains unavailable rather than substituted",
    );
    return;
  }
  const f = setup(t),
    root = path.join(f.root, "r");
  fs.mkdirSync(root);
  fs.writeFileSync(
    path.join(root, "data.csv"),
    "studyId,yi,vi\na,1,1\nb,2,1\nc,3,1\n",
  );
  const script = fileURLToPath(
    new URL("../../workers/metafor-analysis.R", import.meta.url),
  );
  const run = spawnSync(
    "Rscript",
    [
      "--vanilla",
      script,
      path.join(root, "data.csv"),
      root,
      "FE",
      "true",
      "false",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(
    fs.readFileSync(path.join(root, "results.json"), "utf8"),
  );
  assert.ok(Math.abs(result.estimate - 2) < 1e-10);
  assert.ok(Math.abs(result.se - Math.sqrt(1 / 3)) < 1e-10);
});
