import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ResearchBootstrapStore } from "../../application/research-bootstrap-store.ts";
import {
  ResearchFoundationsService,
  type FoundationCommand,
} from "../../application/research-foundations-service.ts";
import {
  ResearchExecutionRuntime,
  type RuntimeOptions,
} from "../../application/research-execution-runtime.ts";
import { ResearchArtifacts } from "../../application/research-artifacts.ts";
import {
  LiteratureConnector,
  saveSearchSnapshot,
} from "../../application/research-literature.ts";
import {
  record,
  id,
  text,
  choice,
} from "../../contracts/research-foundations.ts";

export const name = "evolver-research-foundations";
export const inject = ["webServer", "connection", "workspaceRegistry", "tools"];
interface WorkspaceRegistry {
  list(): Array<{ path: string; sessionIds: string[] }>;
}
export interface FoundationsHostConfig {
  workspaceRegistry?: WorkspaceRegistry;
  storeFactory?: (root: string) => ResearchBootstrapStore;
  runtime?: RuntimeOptions;
  openalexKey?: string;
  semanticScholarKey?: string;
  grobidEndpoint?: string;
  paperqaEnabled?: boolean;
  rscript?: string;
  latexmk?: string;
  statisticsImage?: string;
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    bytes += b.length;
    if (bytes > 512 * 1024) throw new Error("Request body exceeds 512 KiB");
    chunks.push(b);
  }
  const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Object body required");
  return v;
}
export function apply(ctx: Context, config: FoundationsHostConfig = {}) {
  const registry =
    config.workspaceRegistry ??
    (ctx.get("workspaceRegistry") as WorkspaceRegistry);
  const connection = ctx.get("connection") as {
    requestRejection(req: IncomingMessage): number | undefined;
  };
  const web = ctx.get("webServer") as {
    register(route: {
      kind: string;
      path: string;
      handler(req: IncomingMessage, res: ServerResponse): void;
    }): () => void;
  };
  if (
    typeof registry?.list !== "function" ||
    typeof connection?.requestRejection !== "function" ||
    typeof web?.register !== "function"
  )
    throw new Error(
      "Foundations requires native authenticated workspace services",
    );
  const scope = (sessionId: string) => {
    id(sessionId);
    const workspace = registry
      .list()
      .find((w) => w.sessionIds.includes(sessionId));
    if (!workspace) throw new Error("Session has no registered workspace");
    return new ResearchFoundationsService(
      config.storeFactory?.(workspace.path) ??
        new ResearchBootstrapStore(workspace.path),
    );
  };
  const runtime = (s: ResearchFoundationsService) =>
    new ResearchExecutionRuntime(s, config.runtime);
  const artifacts = (s: ResearchFoundationsService) =>
    new ResearchArtifacts(s, {
      python: config.runtime?.python,
      rscript: config.rscript,
      latexmk: config.latexmk,
      statisticsImage: config.statisticsImage,
      docker: config.runtime?.docker,
    });
  const actor = (exec: ToolRunContext) => {
    const a = exec.agent as { id?: string; sessionId?: string } | undefined;
    const sessionId = a?.id ?? a?.sessionId;
    if (!sessionId) throw new Error("Live workspace Agent required");
    return { service: scope(sessionId), identity: sessionId, human: false };
  };
  const output = {
    schema: { type: "object" as const, additionalProperties: true },
    render: (_a: unknown, v: unknown) => [
      { type: "text" as const, text: JSON.stringify(v, null, 2) },
    ],
  };
  ctx.tools.register(
    defineTool({
      name: "evolver_read_research_foundations",
      description:
        "Read this research protocol, located measurements, screening decisions, jobs and artifact records. Stale protocol and semantic support boundaries are explicit.",
      parameters: { researchId: { type: "string", required: true } },
      output,
      execute: (args: unknown, exec: ToolRunContext) =>
        actor(exec).service.snapshot(
          (args as { researchId: string }).researchId,
        ),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: "evolver_update_research_foundations",
      description:
        "Save a draft protocol, register literature metadata, add a precisely located measurement, or propose an awaiting/conflict screening record. Human actions freeze protocols, make final eligibility decisions and authorize execution. payloadJson must follow the action schema; arbitrary commands/paths/hosts are refused.",
      parameters: {
        researchId: { type: "string", required: true },
        operationId: { type: "string", required: true },
        baseRevision: { type: "number", required: true },
        action: {
          type: "string",
          enum: [
            "save_protocol",
            "register_paper",
            "record_measurement",
            "screen",
          ],
          required: true,
        },
        payloadJson: { type: "string", required: true },
      },
      output,
      execute: (raw: unknown, exec: ToolRunContext) => {
        const a = actor(exec),
          v = record(raw, [
            "researchId",
            "operationId",
            "baseRevision",
            "action",
            "payloadJson",
          ]);
        return a.service.command(
          {
            researchId: v.researchId,
            operationId: v.operationId,
            baseRevision: v.baseRevision,
            action: v.action,
            payload: JSON.parse(
              text(v.payloadJson, "payload JSON", 256 * 1024),
            ),
          } as FoundationCommand,
          a,
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: "evolver_search_research_literature",
      description:
        "Search a fixed academic metadata provider and preserve a bounded query/response snapshot. Metadata is not full text or verified evidence. Provider credentials and quota are host-owned.",
      parameters: {
        researchId: { type: "string", required: true },
        provider: {
          type: "string",
          enum: ["openalex", "crossref", "europepmc", "semantic_scholar"],
          required: true,
        },
        query: { type: "string", required: true },
        page: { type: "string" },
      },
      output,
      execute: async (raw: unknown, exec: ToolRunContext) => {
        const a = actor(exec),
          v = record(raw, ["researchId", "provider", "query", "page"]);
        const snapshot = await new LiteratureConnector(config).search(
          choice(v.provider, [
            "openalex",
            "crossref",
            "europepmc",
            "semantic_scholar",
          ]),
          text(v.query),
          typeof v.page === "string" ? v.page : "*",
        );
        return saveSearchSnapshot(a.service, id(v.researchId), snapshot);
      },
    }),
  );
  const send = (res: ServerResponse, status: number, value: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(value));
  };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) {
        send(res, rejection, { error: "AUTH_REQUIRED" });
        return;
      }
      const url = new URL(req.url ?? "", "http://localhost");
      try {
        const sessionId = id(url.searchParams.get("sessionId")),
          service = scope(sessionId),
          researchId = id(url.searchParams.get("researchId"));
        if (
          url.pathname === "/evolver/research-foundations" &&
          req.method === "GET"
        ) {
          send(res, 200, {
            ...service.snapshot(researchId),
            capabilities: {
              ...runtime(service).doctor(),
              grobid: !!config.grobidEndpoint,
              paperqa: config.paperqaEnabled === true,
            },
          });
          return;
        }
        if (
          url.pathname === "/evolver/research-foundations/artifacts" &&
          req.method === "GET"
        ) {
          const kind = url.searchParams.get("kind"),
            key = id(url.searchParams.get("key")),
            name = text(url.searchParams.get("name"), "name", 200),
            hash = text(url.searchParams.get("sha256"));
          const bytes =
            kind === "jobs"
              ? runtime(service).artifact(researchId, key, name, hash)
              : artifacts(service).read(
                  researchId,
                  choice(kind, [
                    "figures",
                    "analyses",
                    "reviews",
                    "reports",
                    "parses",
                  ]),
                  key,
                  name,
                  hash,
                );
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`,
          );
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.end(bytes);
          return;
        }
        if (
          url.pathname !== "/evolver/research-foundations/actions" ||
          req.method !== "POST"
        ) {
          send(res, 405, { error: "METHOD_NOT_ALLOWED" });
          return;
        }
        if (
          !/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")
        )
          throw new Error("JSON content type required");
        const v = await body(req),
          action = text(v.action, "action", 100);
        let result: unknown;
        if (action === "search_literature") {
          record(v, ["action", "provider", "query", "page"]);
          result = saveSearchSnapshot(
            service,
            researchId,
            await new LiteratureConnector(config).search(
              choice(v.provider, [
                "openalex",
                "crossref",
                "europepmc",
                "semantic_scholar",
              ]),
              text(v.query),
              typeof v.page === "string" ? v.page : "*",
            ),
          );
        } else if (action === "parse_source" || action === "query_papers") {
          record(v, [
            "action",
            "sourceId",
            "sourceIds",
            "question",
            "authorize",
          ]);
          if (v.authorize !== true)
            throw new Error("Explicit human authorization required");
          if (action === "parse_source") {
            if (!config.grobidEndpoint)
              throw new Error("GROBID endpoint is not configured");
            result = await artifacts(service).parse(
              researchId,
              id(v.sourceId),
              config.grobidEndpoint,
            );
          } else {
            if (config.paperqaEnabled !== true)
              throw new Error("PaperQA worker is not enabled/configured");
            result = artifacts(service).queryPapers(
              researchId,
              v.sourceIds as string[],
              text(v.question),
            );
          }
        } else if (
          [
            "submit_job",
            "cancel_job",
            "reconcile_job",
            "generate_figure",
            "analyze",
            "compile_report",
            "export_review",
            "rank_screening",
            "verify_citations",
            "render_review",
          ].includes(action)
        ) {
          record(v, [
            "action",
            "jobId",
            "parentId",
            "spec",
            "authorize",
            "tool",
          ]);
          if (action !== "reconcile_job" && v.authorize !== true)
            throw new Error("Explicit human authorization required");
          if (action === "submit_job")
            result = runtime(service).submit(researchId, id(v.jobId));
          else if (action === "cancel_job")
            result = runtime(service).cancel(researchId, id(v.jobId));
          else if (action === "reconcile_job")
            result = runtime(service).reconcile(researchId, id(v.jobId));
          else if (action === "generate_figure")
            result = artifacts(service).figure(
              researchId,
              id(v.jobId),
              v.parentId == null ? null : id(v.parentId),
            );
          else if (action === "analyze")
            result = artifacts(service).analyze(researchId, v.spec);
          else if (action === "compile_report")
            result = artifacts(service).manuscript(researchId);
          else if (action === "export_review")
            result = artifacts(service).reviewExport(researchId);
          else if (action === "verify_citations")
            result = await artifacts(service).verifyCitations(
              researchId,
              new LiteratureConnector(config),
            );
          else if (action === "render_review")
            result = artifacts(service).renderReview(
              researchId,
              choice(v.tool, ["PRISMA", "ROB2", "ROBINS-I"]),
            );
          else result = artifacts(service).rank(researchId);
        } else {
          record(v, ["action", "operationId", "baseRevision", "payload"]);
          result = service.command(
            {
              researchId,
              action,
              operationId: v.operationId as string,
              baseRevision: v.baseRevision as number,
              payload: v.payload,
            },
            { identity: sessionId, human: true },
          );
        }
        send(res, 200, {
          ok: true,
          result,
          revision: service.store.readStateOrEmpty().revision,
        });
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    })().catch(() => {
      if (!res.headersSent)
        send(res, 500, { error: "FOUNDATIONS_INTERNAL_ERROR" });
    });
  };
  const disposers = [
    web.register({
      kind: "prefix",
      path: "/evolver/research-foundations",
      handler,
    }),
  ];
  ctx.on("dispose", () => {
    for (const d of disposers.reverse()) d();
  });
}
