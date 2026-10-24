import { ResearchCoreError } from './index.ts';

/** Wire contract version, independent of persisted research schema versions. */
export const MCP_CONTRACT_VERSION = '1.0.0';
export interface WireSchema {
  type?: string | string[];
  properties?: Record<string, WireSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: WireSchema;
  anyOf?: WireSchema[];
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  pattern?: string;
  description?: string;
}
const str: WireSchema = { type: 'string' }, bool: WireSchema = { type: 'boolean' }, integer: WireSchema = { type: 'integer', minimum: 0 };
const hash: WireSchema = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const nullable = (schema: WireSchema): WireSchema => ({ anyOf: [schema, { type: 'null' }] });
const array = (items: WireSchema): WireSchema => ({ type: 'array', items });
const object = (properties: Record<string, WireSchema>, required = Object.keys(properties), additionalProperties = false): WireSchema => ({ type: 'object', properties, required, additionalProperties });
const domain: WireSchema = { type: 'object', additionalProperties: true, description: 'Native domain object: original domain validators remain authoritative. Nested schema is not yet published as a closed wire contract.' };
const strings = array(str);
const plan = object({ planId: str, revision: integer, ideaId: str, baseline: str, variable: str, fixedConditions: strings, split: str, seedPolicy: str, metric: str, metricUnit: str, budget: str, stopCondition: str, status: { const: 'draft' }, contentHash: hash, updatedAt: str });
const assignment = object({ assignmentId: str, planId: str, planRevision: integer, planHash: hash, role: { const: 'engineer' }, reviewMode: { const: 'self_review' }, status: { const: 'prepared' }, expectedOutputs: strings, createdAt: str });
const idea = object({ ideaId: str, revision: integer, title: str, hypothesis: str, change: str, mechanism: str, falsifier: str, sourceIds: strings, status: { enum: ['candidate', 'selected'] }, updatedAt: str });
const sourcePin = object({ sourceId: str, revision: integer, sha256: hash });
const pins = object({ planId: str, ideaId: str, ideaRevision: integer, ideaHash: hash, profileRevision: integer, sources: array(sourcePin) });
const material = object({ source: domain, text: nullable(str), coverage: str, message: str, image: bool }, ['source', 'text', 'coverage']);
const mutation = (result: WireSchema): WireSchema => object({ result, revision: integer, replayed: bool, projectId: str });
const nativeMutation = object({ result: domain, revision: integer, replayed: bool, researchId: nullable(str) }, ['result', 'revision', 'replayed'], true);
const template = object({ runId: { type: 'null' }, assignmentId: str, planId: str, planRevision: integer, planHash: hash, execution: { const: 'unknown' }, recordKind: { const: 'external_reported' }, split: str, configHash: { type: 'null' }, metricsFile: { type: 'null' }, failureQuote: { type: 'null' }, metrics: array(object({ name: str, unit: str, value: { type: 'null' }, row: { type: 'null' }, column: { type: 'null' } })) });
const bootstrapContext = object({ authority: { const: 'bootstrap' }, actor: object({ actorId: str, kind: { const: 'agent' }, source: { const: 'mcp' } }), workspace: domain, revision: integer, activeResearchId: nullable(str), researches: array(object({ researchId: str, title: str, counts: object({ externalResults: integer, resultReviews: integer, experimentPlans: integer, assignments: integer, experimentRuns: integer, experimentReviews: integer, sources: integer, knowledge: integer, nodes: integer }) })), next: str });
const prototypeContext = object({ projectId: nullable(str), revision: nullable(integer), goal: nullable(str), counts: object({ sources: integer, knowledge: integer, ideas: integer, plans: integer, assignments: integer, runs: integer, reviews: integer, searches: integer }), offset: integer, limit: integer, searches: array(domain), needsMigration: bool, sources: array(domain), ideas: array(idea), plans: array(plan), assignments: array(assignment), reviews: array(domain), legacy: object({ researchCount: integer, authoritativeSession: bool }) });
export const MCP_ERROR_SCHEMA = object({ ok: { const: false }, code: str, message: str }, ['ok', 'code', 'message'], true);

/** Each tool has a real outer contract. Polymorphic native bridges remain explicitly extensible. */
export const MCP_OUTPUT_SCHEMAS: Record<string, WireSchema> = {
  create_research_idea: mutation(object({ ideaId: str })),
  create_experiment_plan: mutation(object({ planId: str, contentHash: hash })),
  export_assignment: mutation(object({ assignmentId: str, planHash: hash })),
  record_experiment_result: mutation(object({ runId: str, created: bool })),
  submit_research_review: mutation(object({ reviewId: str, reviewMode: { const: 'self_review' } })),
  import_material: mutation(object({ sourceId: str, sha256: hash, created: bool })),
  upsert_knowledge: mutation(object({ cardId: str, cardRevision: integer })),
  search_papers: mutation(object({ status: { const: 'search_incomplete' }, reason: str })),
  read_paper: material,
  search_wiki: object({ revision: integer, total: integer, offset: integer, items: array(domain) }),
  get_assignment: object({ schemaVersion: { const: 1 }, projectId: str, goal: str, constraints: strings, assignment, idea, plan, sources: array(material), authority: { const: 'bootstrap' }, sourcePins: pins, nativeIdea: domain, instructions: strings, manifestTemplate: template, templateNote: str }, ['schemaVersion', 'projectId', 'goal', 'constraints', 'assignment', 'idea', 'plan', 'sources', 'instructions', 'manifestTemplate', 'templateNote']),
  get_research_context: { type: 'object', anyOf: [bootstrapContext, prototypeContext] },
  get_research_tree: object({ revision: integer, nodes: array(object({ id: str, kind: str, title: str })), edges: array(object({ from: str, to: str, relation: str })) }),
  external_cycle_action: object({ ok: { const: true } }, ['ok'], true),
  cycle_query: object({ schemaVersion: { const: 1 } }, ['schemaVersion'], true),
  paper_query: { type: 'object', anyOf: [object({ schemaVersion: { const: 2 }, scope: { const: 'workspace-files' }, workspace: domain, papers: array(domain), runs: array(domain) }), object({ id: str, sha256: hash, pages: strings, status: { const: 'provisional' }, boundary: str }, ['id', 'sha256', 'pages', 'status', 'boundary'], true)] },
  paper_action: object({ id: str, sha256: hash, pages: strings }, ['id', 'sha256', 'pages'], true),
  foundation_query: object({ researchId: str, revision: integer }, ['researchId', 'revision'], true),
  foundation_action: object({ ok: { const: true }, result: {}, revision: integer }),
  workspace_query: { ...domain, description: 'Route-dependent native projection. Object envelope only; nested route schemas remain an explicit contract gap.' },
  workspace_action: nativeMutation,
  register_external_result: nativeMutation,
  review_external_results: nativeMutation,
};

/** Validate only the JSON Schema keywords emitted above; not a general-purpose schema engine. */
export function validateWireOutput(value: unknown, schema: WireSchema, label = 'output'): void {
  const fail = (detail: string): never => { throw new ResearchCoreError('SCHEMA_VIOLATION', `${label}: ${detail}`); };
  if (schema.anyOf && !schema.anyOf.some(branch => { try { validateWireOutput(value, branch, label); return true; } catch (error) { if (!(error instanceof ResearchCoreError)) throw error; return false; } })) fail('does not match any declared output variant');
  if (Object.hasOwn(schema, 'const') && value !== schema.const) fail(`expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) fail('unsupported enum value');
  const matches = (type: string) => type === 'null' ? value === null : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(matches)) fail(`expected ${schema.type}`);
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) fail(`must be >= ${schema.minimum}`);
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) fail('pattern mismatch');
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) fail(`missing ${key}`);
    for (const [key, child] of Object.entries(record)) {
      const property = schema.properties?.[key];
      if (property) validateWireOutput(child, property, `${label}.${key}`);
      else if (schema.additionalProperties === false) fail(`unexpected ${key}`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((child, i) => validateWireOutput(child, schema.items!, `${label}[${i}]`));
}
