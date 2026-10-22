import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

test("foundations UI loads native scope and requires explicit protocol freeze before computing", async (t) => {
  const cache = path.resolve("node_modules/.cache/foundations-ui-test");
  fs.mkdirSync(cache, { recursive: true });
  const outfile = path.join(cache, "panel.mjs");
  buildSync({
    entryPoints: [
      "packages/evolver-ui/src/client/general/ResearchFoundationsPanel.tsx",
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    external: ["react", "react-dom", "react/jsx-runtime"],
    outfile,
  });
  const { ResearchFoundationsPanel } = await import(
    pathToFileURL(outfile).href
  );
  const dom = new JSDOM('<div id="root"></div>', { url: "https://localhost/" });
  const old = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const calls: Array<{ url: string; body?: any }> = [];
  const snapshot = {
    revision: 1,
    researchId: "research-test",
    foundations: {
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
    },
    availableSources: [],
    currentProtocolHash: null,
    staleMeasurementIds: [],
    prisma: null,
    capabilities: {
      python: { available: true },
      docker: { available: false },
      rscript: { available: false },
      remoteHosts: [],
    },
  };
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    return new Response(
      JSON.stringify(
        init?.method === "POST"
          ? {
              ok: true,
              result: { result: { hash: "a".repeat(64) } },
              revision: 2,
            }
          : snapshot,
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("root")!);
  t.after(async () => {
    await act(async () => root.unmount());
    Object.assign(globalThis, old);
    dom.window.close();
  });
  await act(async () => {
    root.render(
      React.createElement(ResearchFoundationsPanel, {
        sessionId: "session-one",
        researchId: "research-test",
      }),
    );
  });
  const details = dom.window.document.querySelector("details")!;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new dom.window.Event("toggle", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.ok(
    calls.some(
      (c) =>
        c.url.includes("sessionId=session-one") &&
        c.url.includes("researchId=research-test"),
    ),
  );
  assert.ok(dom.window.document.body.textContent?.includes("确认并冻结新版本"));
  assert.equal(calls.filter((c) => c.body?.action === "create_job").length, 0);
  const freeze = [...dom.window.document.querySelectorAll("button")].find(
    (b) => b.textContent === "确认并冻结新版本",
  )!;
  assert.equal(freeze.disabled, true, "a change reason is required");
  const experiment = [...dom.window.document.querySelectorAll("button")].find(
    (b) => b.textContent === "实验运行",
  )!;
  await act(async () => {
    experiment.click();
  });
  const run = [...dom.window.document.querySelectorAll("button")].find(
    (b) => b.textContent === "授权并运行一次",
  )!;
  assert.equal(
    run.disabled,
    true,
    "no frozen protocol means no execution grant",
  );
  assert.ok(dom.window.document.body.textContent?.includes("不代表论文复现"));
});
