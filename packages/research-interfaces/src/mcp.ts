import { BootstrapError } from '../../evolver/src/contracts/research-bootstrap.ts';
import { CycleError } from '../../evolver/src/contracts/research-cycle.ts';
import { searchFailure } from '../../research-core/src/legacy-search.ts';
import { ResearchCoreError } from '../../research-contracts/src/index.ts';
import { ResearchCore } from '../../research-core/src/index.ts';
import { activeStore } from '../../research-core/src/active-store.ts';
import { readLegacyWorkbench, legacyResearchAction } from './legacy-domain.ts';
import { legacyQuery } from './legacy-queries.ts';
import { legacyAsyncResearchAction } from '../../research-core/src/legacy-async-actions.ts';
import { foundationSnapshot, foundationAction } from '../../research-core/src/legacy-foundations.ts';
import { paperLibraryProjection, readWorkspacePaper, paperLibraryAction } from '../../research-core/src/legacy-papers.ts';
import { readWorkspaceCycle } from '../../research-core/src/legacy-cycle.ts';
import { externalCycleAction } from '../../research-core/src/external-cycle.ts';
import { randomUUID } from 'node:crypto';
import { MCP_CONTRACT_VERSION, MCP_OUTPUT_SCHEMAS, MCP_ERROR_SCHEMA, validateWireOutput } from '../../research-contracts/src/mcp-output.ts';

const requestedWorkspace = process.argv.find((arg, index) => process.argv[index - 1] === '--workspace');
if (!requestedWorkspace && !process.argv.includes('--describe')) {
  process.stderr.write('research mcp requires --workspace\n');
  process.exit(1);
}
const workspaceDir: string = requestedWorkspace!;

const core = new ResearchCore();
const configuredAgentId = process.env.RESEARCH_AGENT_ID;
if (configuredAgentId !== undefined && !/^[A-Za-z0-9._:-]{1,120}$/.test(configuredAgentId)) throw new Error('RESEARCH_AGENT_ID must be a stable bounded client identifier');
const actor = { actorId: `mcp:${configuredAgentId ?? randomUUID()}`, kind: 'agent' as const, source: 'mcp' as const };
const tools = [
  { name: 'external_cycle_action', description: 'Claim an explicitly user-authorized role handoff, read its pinned inputs, publish/submit the assigned output or report its first failure. Does not spawn an Agent or grant human approval. Uses this MCP process identity; configure RESEARCH_AGENT_ID outside tool arguments for reconnects.', inputSchema: { type: 'object', required: ['researchId', 'payload'], properties: { researchId: { type: 'string' }, payload: { type: 'object', additionalProperties: true } }, additionalProperties: false } },
  { name: 'cycle_query', description: 'Read registered cycle state or a pinned artifact; historical Team records are not live members and current source access still applies.', inputSchema: { type: 'object', required: ['researchId'], properties: { researchId: { type: 'string' }, runId: { type: 'string' }, ref: { type: 'object', required: ['id', 'sha256'], properties: { id: { type: 'string' }, sha256: { type: 'string' } }, additionalProperties: false } }, additionalProperties: false } },
  { name: 'paper_query', description: 'Read the original paper library or one paper with exact page text, Wiki and Research Components. Extracted knowledge is provisional.', inputSchema: { type: 'object', properties: { paperId: { type: 'string' } }, additionalProperties: false } },
  { name: 'paper_action', description: 'Import a local source encoded as base64, or publish Wiki/components against the current paper revision. Original validators require exact page quotations; no fabricated evidence or human approval.', inputSchema: { type: 'object', required: ['payload'], properties: { payload: { type: 'object', additionalProperties: true } }, additionalProperties: false } },
  { name: 'foundation_query', description: 'Read the current protocol, located measurements, jobs and screening records. Does not execute a worker.', inputSchema: { type: 'object', required: ['researchId'], properties: { researchId: { type: 'string' } }, additionalProperties: false } },
  { name: 'foundation_action', description: 'Save a draft foundation record or search a fixed literature provider. Human protocol freezing, final screening and execution remain unavailable to agents; actor/config cannot be supplied in payload.', inputSchema: { type: 'object', required: ['researchId', 'payload'], properties: { researchId: { type: 'string' }, payload: { type: 'object', additionalProperties: true } }, additionalProperties: false } },
  { name: 'workspace_query', description: 'Read actual Bootstrap research objects, graph, sources, Wiki tasks and evidence using the workbench domain services. Prototype archive access requires reauthorized sources.', inputSchema: { type: 'object', required: ['route', 'params'], properties: { route: { type: 'string', enum: ['external-results', 'literature-searches', 'research', 'graph', 'wiki', 'wiki-task', 'data', 'knowledge-graph', 'export', 'package', 'prototype-history', 'calculation', 'inference', 'report', 'takeover'] }, params: { type: 'object', additionalProperties: true } }, additionalProperties: false } },
  { name: 'workspace_action', description: 'Write a draft into the same Bootstrap aggregate used by the original workbench. Human approval/execution/access actions are refused.', inputSchema: { type: 'object', required: ['operationId', 'baseRevision', 'payload'], properties: { operationId: { type: 'string' }, baseRevision: { type: 'integer' }, payload: { type: 'object', additionalProperties: true } }, additionalProperties: false } },
  { name: 'read_paper', description: 'Read a verified imported text source. PDF without a parser reports needs_parser.', inputSchema: { type: 'object', required: ['sourceId'], properties: { sourceId: { type: 'string' } }, additionalProperties: false } },
  { name: 'search_wiki', description: 'Search current knowledge revisions.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, additionalProperties: false } },
  { name: 'upsert_knowledge', description: 'Save a versioned Wiki card with verified UTF-8 byte citations.', inputSchema: { type: 'object', required: ['operationId', 'baseRevision', 'kind', 'title', 'body', 'sourceIds', 'unknowns', 'citations'], properties: { operationId: { type: 'string' }, baseRevision: { type: 'integer' }, cardId: { type: 'string' }, cardRevision: { type: 'integer' }, kind: { type: 'string', enum: ['brief', 'method', 'evaluation'] }, title: { type: 'string' }, body: { type: 'string' }, sourceIds: { type: 'array', items: { type: 'string' } }, unknowns: { type: 'array', items: { type: 'string' } }, citations: { type: 'array', items: { type: 'object' } } }, additionalProperties: false } },
  { name: 'register_external_result', description: 'Register a workspace-relative external CSV/result/failure file in active Bootstrap research. Checks actual cells, run id, units, conditions and node match; never claims local execution. Agents cannot supply human clarification or read hidden managed stores.', inputSchema: { type: 'object', required: ['operationId','baseRevision','researchId','relativePath','nature','label','values','conditions'], properties: { operationId:{type:'string'},baseRevision:{type:'integer'},researchId:{type:'string'},relativePath:{type:'string'},nature:{type:'string',enum:['simulation','user_result']},label:{type:'string'},externalRunId:{type:'string'},values:{type:'array',items:{type:'object'}},conditions:{type:'array',items:{type:'object'}},failureQuote:{type:'string'} }, additionalProperties:false } },
  { name: 'review_external_results', description: 'Publish the actual external client suggestion over registered reports, with pinned input/source versions. Always self_review with unverified model identity; never approves or executes future actions.', inputSchema: { type:'object',required:['operationId','baseRevision','researchId','reportIds','judgment','boundary','support','counterEvidence','gaps','nextActions'],properties:{operationId:{type:'string'},baseRevision:{type:'integer'},researchId:{type:'string'},reportIds:{type:'array',items:{type:'string'}},judgment:{type:'string',enum:['support','counter','insufficient','mixed']},boundary:{type:'string'},support:{type:'string'},counterEvidence:{type:'string'},gaps:{type:'string'},nextActions:{type:'array',items:{type:'object'}}},additionalProperties:false } },
  { name: 'get_assignment', description: 'Read frozen plan, source pins, instructions, and the run-manifest template.', inputSchema: { type: 'object', required: ['assignmentId'], properties: { assignmentId: { type: 'string' } }, additionalProperties: false } },
  { name: 'get_research_context', description: 'Read the project summary and paginated objects (default limit 20, max 100).', inputSchema: { type: 'object', properties: { offset: { type: 'integer' }, limit: { type: 'integer' } }, additionalProperties: false } },
  { name: 'get_research_tree', description: 'Read idea, plan, run and review links.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'import_material', description: 'Copy a workspace file into the research project.', inputSchema: { type: 'object', required: ['operationId', 'baseRevision', 'filePath'], properties: { operationId: { type: 'string' }, baseRevision: { type: 'integer' }, filePath: { type: 'string' } }, additionalProperties: false } },
  { name: 'create_research_idea', description: 'Save a sourced candidate. Saving does not select it.', inputSchema: { type: 'object', required: ['operationId', 'baseRevision', 'title', 'hypothesis', 'change', 'mechanism', 'falsifier', 'sourceIds'], properties: { operationId: { type: 'string' }, baseRevision: { type: 'integer' }, title: { type: 'string' }, hypothesis: { type: 'string' }, change: { type: 'string' }, mechanism: { type: 'string' }, falsifier: { type: 'string' }, sourceIds: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } },
  { name: 'create_experiment_plan', description: 'Save a draft plan. Draft is not an assignment.', inputSchema: { type: 'object', required: ['operationId', 'baseRevision', 'ideaId', 'baseline', 'variable', 'fixedConditions', 'split', 'seedPolicy', 'metric', 'metricUnit', 'budget', 'stopCondition'], properties: { operationId: { type: 'string' }, baseRevision: { type: 'integer' }, ideaId: { type: 'string' }, baseline: { type: 'string' }, variable: { type: 'string' }, fixedConditions: { type: 'array', items: { type: 'string' } }, split: { type: 'string' }, seedPolicy: { type: 'string' }, metric: { type: 'string' }, metricUnit: { type: 'string' }, budget: { type: 'string' }, stopCondition: { type: 'string' } }, additionalProperties: false } },
  { name: 'export_assignment', description: 'Freeze an approved plan into a self-review assignment.', inputSchema: { type: 'object', required: ['operationId', 'baseRevision', 'planId'], properties: { operationId: { type: 'string' }, baseRevision: { type: 'integer' }, planId: { type: 'string' } }, additionalProperties: false } },
  { name: 'record_experiment_result', description: 'Import a run manifest and check metric cells against the file.', inputSchema: { type: 'object', required: ['operationId', 'baseRevision', 'manifestPath'], properties: { operationId: { type: 'string' }, baseRevision: { type: 'integer' }, manifestPath: { type: 'string' } }, additionalProperties: false } },
  { name: 'submit_research_review', description: 'Save a self-review. This is not an independent review and does not approve the result.', inputSchema: { type: 'object', required: ['operationId', 'baseRevision', 'runIds', 'judgment', 'reason', 'nextStep'], properties: { operationId: { type: 'string' }, baseRevision: { type: 'integer' }, runIds: { type: 'array', items: { type: 'string' } }, judgment: { type: 'string', enum: ['supported', 'contradicted', 'inconclusive'] }, reason: { type: 'string' }, nextStep: { type: 'string' } }, additionalProperties: false } },
  { name: 'search_papers', description: 'Record a literature search. Without credentials the status is search_incomplete.', inputSchema: { type: 'object', required: ['operationId', 'baseRevision', 'query'], properties: { operationId: { type: 'string' }, baseRevision: { type: 'integer' }, query: { type: 'string' } }, additionalProperties: false } },
].map(tool => {
  const outputSchema = MCP_OUTPUT_SCHEMAS[tool.name];
  if (!outputSchema) throw new ResearchCoreError('SCHEMA_VIOLATION', `Missing output schema for ${tool.name}`);
  return { ...tool, outputSchema, _meta: { 'dsh.research/contractVersion': MCP_CONTRACT_VERSION } };
});

if (process.argv.includes('--describe')) {
  process.stdout.write(JSON.stringify({ contractVersion: MCP_CONTRACT_VERSION, schemaDialect: 'https://json-schema.org/draft/2020-12/schema', errorSchema: MCP_ERROR_SCHEMA, tools }, null, 2) + '\n');
  process.exit(0);
}

function callTool(name: string, args: Record<string, unknown>): unknown {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new ResearchCoreError('NOT_FOUND', `unknown tool ${name}`);
  // Legacy callers may submit actor; ignore it, then validate the declared input.
  const { actor: ignoredActor, ...input } = args;
  validateInput(input, tool.inputSchema, 'arguments');
  const claimedActor = 'actor' in args ? args.actor : undefined;
  const common = { workspaceDir, operationId: String(args.operationId ?? ''), actor, claimedActor, baseRevision: Number(args.baseRevision) };
  if (name === 'external_cycle_action') return externalCycleAction(workspaceDir, args.researchId as string, args.payload as Record<string, unknown>, actor);
  if (name === 'cycle_query') {
    const params = new URLSearchParams(); if (args.runId) params.set('runId', args.runId as string);
    if (args.ref) { const ref = args.ref as { id: string; sha256: string }; params.set('id', ref.id); params.set('sha256', ref.sha256); }
    return readWorkspaceCycle(workspaceDir, args.researchId as string, params, actor);
  }
  if (name === 'paper_query') return args.paperId ? readWorkspacePaper(workspaceDir, args.paperId as string).json : paperLibraryProjection(workspaceDir);
  if (name === 'paper_action') return paperLibraryAction(workspaceDir, args.payload as Record<string, unknown>);
  if (name === 'foundation_query') return foundationSnapshot(workspaceDir, args.researchId as string, undefined, false);
  if (name === 'foundation_action') return foundationAction(workspaceDir, args.researchId as string, args.payload as Record<string, unknown>, actor);
  if (name === 'workspace_query') {
    const params = args.params as Record<string, unknown>;
    if (Object.values(params).some((v) => typeof v !== 'string')) throw new ResearchCoreError('INVALID_INPUT', 'query parameter values must be strings');
    return legacyQuery(workspaceDir, args.route as string, new URLSearchParams(params as Record<string, string>)).json;
  }
  if (name === 'workspace_action') {
    const payload = args.payload as Record<string, unknown>;
    return legacyAsyncResearchAction(workspaceDir, { ...payload, operationId: args.operationId, baseRevision: args.baseRevision }, actor);
  }
  if (name === 'get_research_context' && activeStore(workspaceDir)) {
    const view = readLegacyWorkbench(workspaceDir);
    return { authority: 'bootstrap', actor, workspace: view.workspace, revision: view.bootstrap.revision, activeResearchId: view.bootstrap.activeResearchId,
      researches: view.bootstrap.researches.map((r) => ({ researchId: r.researchId, title: r.title, counts: { externalResults: r.general?.metricReports.filter(report => report.match).length ?? 0, resultReviews: r.general?.resultReviews.length ?? 0, experimentPlans: r.general?.externalLoop?.plans.length ?? 0, assignments: r.general?.externalLoop?.assignments.length ?? 0, experimentRuns: r.general?.externalLoop?.runs.length ?? 0, experimentReviews: r.general?.externalLoop?.reviews.length ?? 0, sources: r.general?.sources.length ?? 0, knowledge: r.general?.knowledge.length ?? 0, nodes: r.general?.graph.nodes.length ?? r.graph?.nodes.length ?? 0 } })),
      next: 'Use workspace_action for native candidate/Wiki writes. Shared import_material/read_paper/search_wiki and create_experiment_plan/export_assignment/get_assignment/record_experiment_result/submit_research_review target the selected Bootstrap general research; user approval stays CLI/HTTP. Other prototype writes remain disabled.' };
  }
  if (name === 'read_paper') return core.readMaterial(workspaceDir, args.sourceId as string);
  if (name === 'search_wiki') return core.searchWiki(workspaceDir, args.query as string | undefined, args.offset as number | undefined, args.limit as number | undefined);
  if (name === 'register_external_result' || name === 'review_external_results') return legacyResearchAction(workspaceDir, { ...args, type: name }, actor);
  if (name === 'get_assignment') return core.assignmentBundle(workspaceDir, args.assignmentId as string);
  if (name === 'upsert_knowledge') return core.upsertKnowledge({ ...(input as unknown as Parameters<ResearchCore['upsertKnowledge']>[0]), ...common });
  if (name === 'get_research_context') {
    const context = core.context(workspaceDir);
    const offset = args.offset === undefined ? 0 : args.offset as number;
    const limit = args.limit === undefined ? 20 : args.limit as number;
    if (offset < 0 || limit < 1 || limit > 100) throw new ResearchCoreError('INVALID_INPUT', 'offset >= 0 and limit 1–100 required');
    const page = <T>(items: T[] | undefined) => (items ?? []).slice(offset, offset + limit);
    return {
      projectId: context.project?.projectId ?? null,
      revision: context.project?.revision ?? null,
      goal: context.project?.goal ?? null,
      counts: {
        sources: context.project?.sources.length ?? 0,
        knowledge: context.project?.knowledge.length ?? 0,
        ideas: context.project?.ideas.length ?? 0,
        plans: context.project?.plans.length ?? 0,
        assignments: context.project?.assignments.length ?? 0,
        runs: context.project?.runs.length ?? 0,
        reviews: context.project?.reviews.length ?? 0,
        searches: context.project?.searches.length ?? 0,
      },
      offset, limit,
      searches: page(context.project?.searches),
      needsMigration: context.needsMigration,
      sources: page(context.project?.sources),
      ideas: page(context.project?.ideas),
      plans: page(context.project?.plans),
      assignments: page(context.project?.assignments),
      reviews: page(context.project?.reviews),
      legacy: { researchCount: context.legacy.researchCount, authoritativeSession: context.legacy.legacyAdapter.authoritative },
    };
  }
  if (name === 'get_research_tree') return core.tree(workspaceDir);
  if (name === 'import_material') return core.importMaterial({ ...common, filePath: String(args.filePath), allowAbsolute: false });
  if (name === 'create_research_idea') return core.createIdea({ ...common, title: String(args.title), hypothesis: String(args.hypothesis), change: String(args.change), mechanism: String(args.mechanism), falsifier: String(args.falsifier), sourceIds: args.sourceIds as string[] });
  if (name === 'create_experiment_plan') return core.createPlan({ ...common, ideaId: String(args.ideaId), baseline: String(args.baseline), variable: String(args.variable), fixedConditions: args.fixedConditions as string[], split: String(args.split), seedPolicy: String(args.seedPolicy), metric: String(args.metric), metricUnit: String(args.metricUnit), budget: String(args.budget), stopCondition: String(args.stopCondition) });
  if (name === 'export_assignment') return core.exportAssignment({ ...common, planId: String(args.planId) });
  if (name === 'record_experiment_result') return core.recordRun({ ...common, manifestPath: String(args.manifestPath) });
  if (name === 'submit_research_review') return core.submitReview({ ...common, runIds: args.runIds as string[], judgment: args.judgment as 'supported' | 'contradicted' | 'inconclusive', reason: String(args.reason), nextStep: String(args.nextStep) });
  if (name === 'search_papers') return core.searchPapers({ ...common, query: String(args.query) });
  throw new ResearchCoreError('NOT_FOUND', `unknown tool ${name}`);
}

function validateInput(value: unknown, schema: { type: string; required?: readonly string[]; properties?: object; items?: object; additionalProperties?: boolean; enum?: readonly string[] }, label: string): void {
  const valid = schema.type === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value)
    : schema.type === 'array' ? Array.isArray(value) : schema.type === 'integer' ? Number.isSafeInteger(value) : typeof value === schema.type;
  if (!valid) throw new ResearchCoreError('INVALID_INPUT', `${label} must be ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value as string)) throw new ResearchCoreError('INVALID_INPUT', `${label} has an unsupported value`);
  if (schema.type === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) throw new ResearchCoreError('INVALID_INPUT', `${label}.${key} is required`);
    const properties = (schema.properties ?? {}) as Record<string, Parameters<typeof validateInput>[1]>;
    for (const [key, item] of Object.entries(obj)) {
      if (properties[key]) validateInput(item, properties[key], `${label}.${key}`);
      else if (schema.additionalProperties === false) throw new ResearchCoreError('INVALID_INPUT', `${label}.${key} is not allowed`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => validateInput(item, schema.items as Parameters<typeof validateInput>[1], `${label}[${i}]`));
}

let legacyFraming = false;
function writeMessage(message: unknown): void {
  const json = JSON.stringify(message);
  process.stdout.write(legacyFraming ? `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}` : `${json}\n`);
}

function reply(id: unknown, result: unknown): void {
  writeMessage({ jsonrpc: '2.0', id, result });
}

async function handle(message: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }): Promise<void> {
  if (message.method === 'notifications/initialized' || message.id === undefined) return;
  if (message.method === 'initialize') {
    reply(message.id, { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'research-core', version: '0.1.0' } });
    return;
  }
  if (message.method === 'tools/list') {
    reply(message.id, { tools });
    return;
  }
  if (message.method === 'tools/call') {
    try {
      const value = await callTool(message.params?.name ?? '', message.params?.arguments ?? {});
      // Validate exactly the wire value: undefined optional properties disappear
      // during JSON serialization. Never substitute an empty fallback response.
      const json = JSON.stringify(value);
      if (json === undefined) throw new ResearchCoreError('SCHEMA_VIOLATION', `output of ${message.params?.name}: missing JSON result`);
      const wireValue: unknown = JSON.parse(json);
      validateWireOutput(wireValue, MCP_OUTPUT_SCHEMAS[message.params?.name ?? ''], `output of ${message.params?.name}`);
      reply(message.id, { content: [{ type: 'text', text: json }], structuredContent: wireValue, isError: false });
    } catch (error) {
      const code = error instanceof ResearchCoreError || error instanceof BootstrapError || error instanceof CycleError ? error.code : 'INVALID_INPUT';
      const text = error instanceof Error ? error.message : String(error);
      const failure = { ok: false, code, message: text, ...searchFailure(error) };
      reply(message.id, { content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure, isError: true });
    }
    return;
  }
  writeMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length > 1_000_000) {
    writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'message exceeds 1 MB' } });
    buffer = Buffer.alloc(0); return;
  }
  for (;;) {
    if (!buffer.length) return;
    legacyFraming = buffer.subarray(0, Math.min(buffer.length, 15)).toString().toLowerCase().startsWith('content-length:');
    if (!legacyFraming && buffer[0] === 67 && buffer.length < 15) return;
    if (!legacyFraming) {
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const body = buffer.subarray(0, end).toString('utf8').trim();
      buffer = buffer.subarray(end + 1);
      if (body) parseMessage(body);
      continue;
    }
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const length = Number(buffer.subarray(0, headerEnd).toString('utf8').match(/Content-Length:\s*(\d+)/i)?.[1]);
    if (!Number.isSafeInteger(length)) {
      buffer = Buffer.alloc(0);
      return;
    }
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString('utf8');
    buffer = buffer.subarray(start + length);
    parseMessage(body);
  }
});

function parseMessage(body: string): void {
  let message;
  try { message = JSON.parse(body); }
  catch { writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON' } }); return; }
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
    writeMessage({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'invalid request' } }); return;
  }
  void handle(message);
}
