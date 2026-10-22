import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { digest, text } from "../contracts/research-foundations.ts";
import {
  normalizeDOI,
  ResearchFoundationsService,
} from "./research-foundations-service.ts";
import { checkedDirectory, writeAtomic } from "./research-execution-runtime.ts";

export interface LiteratureHit {
  title: string;
  doi: string | null;
  aliases: string[];
  url: string | null;
}
export interface SearchSnapshot {
  schemaVersion: 1;
  provider: "openalex" | "crossref" | "europepmc" | "semantic_scholar";
  query: string;
  page: string;
  retrievedAt: string;
  responseHash: string;
  hits: LiteratureHit[];
  nextPage: string | null;
  raw: unknown;
}
type Fetch = typeof fetch;
async function boundedResponse(
  response: Response,
  max = 4 * 1024 * 1024,
): Promise<string> {
  if (!response.ok)
    throw new Error(
      `Provider HTTP ${response.status}; retry-after=${response.headers.get("retry-after") ?? "unspecified"}`,
    );
  if (Number(response.headers.get("content-length") ?? 0) > max)
    throw new Error("Provider response exceeds size limit");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty provider response");
  let count = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      count += r.value.byteLength;
      if (count > max) throw new Error("Provider response exceeds size limit");
      chunks.push(r.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}
/** Fixed provider URLs. Credentials are host-owned, omitted from snapshots and logs. */
export class LiteratureConnector {
  readonly options: {
    openalexKey?: string;
    semanticScholarKey?: string;
    fetch?: Fetch;
  };
  constructor(
    options: {
      openalexKey?: string;
      semanticScholarKey?: string;
      fetch?: Fetch;
    } = {},
  ) {
    this.options = options;
  }
  async search(
    provider: SearchSnapshot["provider"],
    query: string,
    page = "*",
  ): Promise<SearchSnapshot> {
    text(query, "query", 2000);
    if (page.length > 2000 || /[\r\n]/.test(page))
      throw new Error("Invalid cursor");
    let url: URL;
    const headers: Record<string, string> = { accept: "application/json" };
    if (provider === "openalex") {
      url = new URL("https://api.openalex.org/works");
      url.searchParams.set("search", query);
      url.searchParams.set("per-page", "25");
      url.searchParams.set("cursor", page);
      if (this.options.openalexKey)
        url.searchParams.set("api_key", this.options.openalexKey);
    } else if (provider === "crossref") {
      url = new URL("https://api.crossref.org/works");
      url.searchParams.set("query", query);
      url.searchParams.set("rows", "25");
      url.searchParams.set("cursor", page);
    } else if (provider === "europepmc") {
      url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
      url.searchParams.set("query", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("pageSize", "25");
      url.searchParams.set("cursorMark", page);
    } else if (provider === "semantic_scholar") {
      url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
      url.searchParams.set("query", query);
      url.searchParams.set("limit", "25");
      url.searchParams.set("fields", "title,externalIds,url");
      url.searchParams.set("offset", page === "*" ? "0" : String(Number(page)));
      if (page !== "*" && !/^\d{1,6}$/.test(page))
        throw new Error("Invalid offset");
      if (this.options.semanticScholarKey)
        headers["x-api-key"] = this.options.semanticScholarKey;
    } else throw new Error("Unsupported provider");
    const body = await boundedResponse(
      await (this.options.fetch ?? fetch)(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      }),
    );
    const raw = JSON.parse(body),
      rows =
        provider === "openalex"
          ? raw.results
          : provider === "crossref"
            ? raw.message?.items
            : provider === "europepmc"
              ? raw.resultList?.result
              : raw.data;
    if (!Array.isArray(rows) || rows.length > 100)
      throw new Error("Provider schema mismatch");
    const hits: LiteratureHit[] = rows.map((r: Record<string, unknown>) => {
      const title =
        provider === "crossref" ? (r.title as string[])?.[0] : r.title;
      const ids = r.externalIds as { DOI?: string } | undefined;
      const doi = normalizeDOI(
        provider === "semantic_scholar" ? ids?.DOI : (r.doi ?? r.DOI),
      );
      const alias = r.id ?? r.paperId;
      return {
        title: text(title, "title", 4000),
        doi,
        aliases: alias ? [String(alias)] : [],
        url:
          typeof r.url === "string"
            ? r.url
            : typeof r.URL === "string"
              ? r.URL
              : null,
      };
    });
    const next =
      provider === "openalex"
        ? raw.meta?.next_cursor
        : provider === "crossref"
          ? raw.message?.["next-cursor"]
          : provider === "europepmc"
            ? raw.nextCursorMark
            : raw.next;
    return {
      schemaVersion: 1,
      provider,
      query,
      page,
      retrievedAt: new Date().toISOString(),
      responseHash: createHash("sha256").update(body).digest("hex"),
      hits,
      nextPage:
        hits.length && next != null && String(next) !== page
          ? String(next)
          : null,
      raw,
    };
  }
  async doi(doi: string) {
    const normalized = normalizeDOI(doi);
    if (!normalized) throw new Error("DOI required");
    const raw = JSON.parse(
      await boundedResponse(
        await (this.options.fetch ?? fetch)(
          `https://api.crossref.org/works/${encodeURIComponent(normalized)}`,
          { redirect: "error", signal: AbortSignal.timeout(20000) },
        ),
      ),
    );
    if (normalizeDOI(raw.message?.DOI) !== normalized)
      throw new Error("DOI metadata mismatch");
    return {
      doi: normalized,
      title: raw.message?.title?.[0] ?? null,
      status: "metadata_matched",
      boundary: "Metadata identity does not establish claim support",
    };
  }
}
export function saveSearchSnapshot(
  service: ResearchFoundationsService,
  researchId: string,
  snapshot: SearchSnapshot,
) {
  service.snapshot(researchId);
  const root = checkedDirectory(
    service.store.workspaceRoot,
    path.join(".dsh", "research", "foundation-assets", researchId, "searches"),
  );
  const hash = digest(snapshot),
    file = path.join(root, `${hash}.json`);
  if (!fs.existsSync(file)) writeAtomic(file, snapshot);
  return {
    snapshotId: hash,
    sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    hits: snapshot.hits,
    nextPage: snapshot.nextPage,
    provider: snapshot.provider,
    query: snapshot.query,
    responseHash: snapshot.responseHash,
  };
}
/** GROBID returns candidate structure, never automatically verified Measurement records. */
export async function parseWithGrobid(
  pdf: Uint8Array,
  endpoint: string,
  fetcher: Fetch = fetch,
) {
  if (pdf.byteLength > 25 * 1024 * 1024 || !pdf.byteLength)
    throw new Error("PDF size limit");
  const url = new URL(endpoint);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid host-owned parser endpoint");
  url.pathname =
    url.pathname.replace(/\/$/, "") + "/api/processFulltextDocument";
  const form = new FormData();
  form.set(
    "input",
    new Blob([Uint8Array.from(pdf)], { type: "application/pdf" }),
    "source.pdf",
  );
  form.set("teiCoordinates", "ref");
  form.set("segmentSentences", "1");
  const tei = await boundedResponse(
    await fetcher(url, {
      method: "POST",
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(90000),
    }),
    16 * 1024 * 1024,
  );
  if (/<!DOCTYPE|<!ENTITY/i.test(tei) || !/<(?:\w+:)?TEI\b/.test(tei))
    throw new Error("Invalid or unsafe TEI");
  return {
    sourceSha256: createHash("sha256").update(pdf).digest("hex"),
    tei,
    parser: "GROBID",
    status: "structure_extracted",
    boundary:
      "Coordinates/structure require source reconciliation; extraction is not scientific verification",
  };
}
