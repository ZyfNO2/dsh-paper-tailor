import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { apply } from "../../packages/evolver/src/adapters/dsh/research-foundations-host.ts";
import { ResearchBootstrapStore } from "../../packages/evolver/src/application/research-bootstrap-store.ts";
import { GeneralResearchService } from "../../packages/evolver/src/application/general-research-service.ts";

test("native route uses connection and workspace boundaries; browser owns freeze and Agent cannot authorize jobs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-foundations-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ResearchBootstrapStore(root),
    researchId = new GeneralResearchService(store).create({
      operationId: "create",
      baseRevision: 0,
      title: "Host test",
      question: "Verify native authority",
      domains: [],
      methods: ["algorithm"],
      entryMode: "existing_data",
    }).result.researchId;
  let route: any, rejection: number | undefined;
  const tools: any[] = [];
  const registry = {
    list: () => [{ path: root, sessionIds: ["session-one"] }],
  };
  const ctx = {
    tools: { register: (tool: unknown) => tools.push(tool) },
    on: () => undefined,
    get: (name: string) =>
      name === "connection"
        ? { requestRejection: () => rejection }
        : name === "webServer"
          ? {
              register: (r: unknown) => {
                route = r;
                return () => undefined;
              },
            }
          : name === "workspaceRegistry"
            ? registry
            : undefined,
  };
  apply(ctx as never);
  assert.equal(route.kind, "prefix");
  assert.equal(tools.length, 3);
  const request = (
    method: string,
    payload?: unknown,
    session = "session-one",
  ) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = Readable.from(
        payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))],
      ) as any;
      req.method = method;
      req.url = `/evolver/research-foundations${method === "POST" ? "/actions" : ""}?sessionId=${session}&researchId=${researchId}`;
      req.headers = { "content-type": "application/json" };
      const res = {
        statusCode: 0,
        headersSent: false,
        setHeader() {},
        end(value: string) {
          resolve({ status: res.statusCode, body: JSON.parse(value) });
        },
      };
      const timeout = setTimeout(
        () => reject(new Error("Host route did not finish")),
        10000,
      );
      timeout.unref();
      route.handler(req, res);
    });
  rejection = 403;
  assert.equal((await request("GET")).status, 403);
  rejection = undefined;
  assert.equal(
    (await request("GET", undefined, "foreign-session")).status,
    400,
  );
  const read = await request("GET");
  assert.equal(read.status, 200);
  assert.equal(read.body.researchId, researchId);
  const spec = {
    mode: "experiment",
    question: "Synthetic regression test",
    sources: [],
    inclusion: [],
    exclusion: [],
    outcomes: ["mse"],
    metric: "mse",
    unit: "squared_y",
    split: "test",
    direction: "minimize",
    maxAttempts: 3,
    timeoutSeconds: 10,
    maxOutputBytes: 1048576,
  };
  const freeze = await request("POST", {
    action: "save_protocol",
    operationId: "freeze-ui",
    baseRevision: store.readStateOrEmpty().revision,
    payload: {
      protocolId: "main",
      status: "frozen",
      reason: "User freezes this plan",
      spec,
    },
  });
  assert.equal(freeze.status, 200, JSON.stringify(freeze.body));
  const hash = freeze.body.result.result.hash;
  assert.equal(
    (
      await request("POST", {
        action: "submit_job",
        jobId: "unknown",
        authorize: false,
      })
    ).status,
    400,
  );
  const writeTool = tools.find(
    (x) => x.name === "evolver_update_research_foundations",
  );
  assert.ok(writeTool, "native tool is discoverable");
  await assert.rejects(
    async () =>
      writeTool.execute(
        {
          researchId,
          operationId: "agent-freeze",
          baseRevision: store.readStateOrEmpty().revision,
          action: "save_protocol",
          payloadJson: JSON.stringify({
            protocolId: "main",
            status: "frozen",
            reason: "Agent cannot grant human authority",
            spec,
          }),
        },
        { agent: { id: "session-one" } },
      ),
    /Human action/,
  );
  await assert.rejects(
    async () =>
      writeTool.execute(
        {
          researchId,
          operationId: "agent-job",
          baseRevision: store.readStateOrEmpty().revision,
          action: "create_job",
          payloadJson: JSON.stringify({
            backend: "portable_cpu",
            profile: "linear-regression-v1",
            variant: "baseline",
            seed: 1,
            image: null,
            hostId: null,
            protocolHash: hash,
          }),
        },
        { agent: { id: "session-one" } },
      ),
    /invalid arguments/,
  );
  assert.equal(
    (
      await request("POST", {
        action: "save_protocol",
        operationId: "forge-owner",
        baseRevision: store.readStateOrEmpty().revision,
        payload: {
          protocolId: "main",
          status: "draft",
          reason: "invalid",
          spec,
        },
        human: true,
      })
    ).status,
    400,
  );
});
