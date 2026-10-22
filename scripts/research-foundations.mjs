#!/usr/bin/env node
/** Operator CLI: all workspace paths come from the invoking human, never an Agent tool. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ResearchBootstrapStore } from "../packages/evolver/src/application/research-bootstrap-store.ts";
import { GeneralResearchService } from "../packages/evolver/src/application/general-research-service.ts";
import { ResearchFoundationsService } from "../packages/evolver/src/application/research-foundations-service.ts";
import { ResearchExecutionRuntime } from "../packages/evolver/src/application/research-execution-runtime.ts";
import { ResearchArtifacts } from "../packages/evolver/src/application/research-artifacts.ts";

const [command, ...argv] = process.argv.slice(2);
const value = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
if (
  !["doctor", "demo", "read", "command", "reconcile", "cancel"].includes(
    command,
  ) ||
  !value("--workspace")
) {
  console.error(
    "usage: node scripts/research-foundations.mjs doctor|demo|read|command|reconcile|cancel --workspace PATH [--research ID] [--job ID] [--request JSON_FILE] [--runtime CONFIG_FILE]",
  );
  process.exit(2);
}
const root = path.resolve(value("--workspace"));
fs.mkdirSync(root, { recursive: true });
const store = new ResearchBootstrapStore(root),
  service = new ResearchFoundationsService(store);
const options = value("--runtime")
  ? JSON.parse(fs.readFileSync(value("--runtime"), "utf8"))
  : {};
const runtime = new ResearchExecutionRuntime(service, options);
if (command === "doctor")
  console.log(JSON.stringify(runtime.doctor(), null, 2));
else if (command === "read")
  console.log(JSON.stringify(service.snapshot(value("--research")), null, 2));
else if (command === "command") {
  const req = JSON.parse(fs.readFileSync(value("--request"), "utf8"));
  console.log(
    JSON.stringify(
      service.command(req, { identity: "operator:cli", human: true }),
      null,
      2,
    ),
  );
} else if (command === "reconcile" || command === "cancel")
  console.log(
    JSON.stringify(
      runtime[command](value("--research"), value("--job")),
      null,
      2,
    ),
  );
else {
  const researchId = new GeneralResearchService(store).create({
    operationId: `demo-${randomUUID()}`,
    baseRevision: store.readStateOrEmpty().revision,
    title: "Synthetic regression runtime acceptance",
    question:
      "Can the portable profile execute and preserve reproducible artifacts?",
    domains: [],
    methods: ["algorithm"],
    entryMode: "existing_data",
  }).result.researchId;
  const command = (action, payload) =>
    service.command(
      {
        operationId: `demo-${randomUUID()}`,
        baseRevision: store.readStateOrEmpty().revision,
        researchId,
        action,
        payload,
      },
      { identity: "operator:cli", human: true },
    ).result;
  const p = command("save_protocol", {
    protocolId: "portable-regression",
    status: "frozen",
    reason: "Explicit synthetic engineering acceptance run",
    spec: {
      mode: "experiment",
      question:
        "Compare baseline, fitted model and intercept ablation on frozen synthetic test data",
      sources: ["fixtures/portable-regression-v1"],
      inclusion: [],
      exclusion: [],
      outcomes: ["mse"],
      metric: "mse",
      unit: "squared_y",
      split: "test",
      direction: "minimize",
      maxAttempts: 3,
      timeoutSeconds: 30,
      maxOutputBytes: 1024 * 1024,
    },
  });
  const jobs = [];
  for (const variant of ["baseline", "candidate", "ablation"]) {
    const { jobId } = command("create_job", {
      backend: "portable_cpu",
      profile: "linear-regression-v1",
      variant,
      seed: 20261022,
      image: null,
      hostId: null,
      protocolHash: p.hash,
    });
    runtime.submit(researchId, jobId);
    const deadline = Date.now() + 35000;
    let job;
    do {
      await new Promise((r) => setTimeout(r, 100));
      job = runtime.reconcile(researchId, jobId);
    } while (job.status === "running" && Date.now() < deadline);
    if (job.status !== "succeeded")
      throw new Error(`Demo job ${jobId}: ${job.status} ${job.error}`);
    jobs.push(job);
  }
  const artifacts = new ResearchArtifacts(service, { python: options.python }),
    figure = artifacts.figure(researchId, jobs[1].jobId);
  const report = artifacts.manuscript(researchId);
  console.log(
    JSON.stringify(
      {
        researchId,
        inputNature: "synthetic",
        jobs: jobs.map((j) => ({
          jobId: j.jobId,
          variant: j.spec.variant,
          status: j.status,
          metrics: j.metrics,
        })),
        figureId: figure.figureId,
        reportId: report.reportId,
        workspace: root,
      },
      null,
      2,
    ),
  );
}
