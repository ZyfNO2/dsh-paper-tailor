import { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { KnowledgeError, type KnowledgeConfig } from '../../contracts/knowledge.ts';
import { KnowledgeService, type KnowledgeActor } from '../../application/knowledge-service.ts';

export interface KnowledgeToolConfig {
  /** Paths are supplied by trusted Host configuration, never by a tool payload. */
  repoRoot: string;
  libraryRoot: string;
  configPath: string;
}

function actorFor(exec: ToolRunContext, config: KnowledgeConfig): KnowledgeActor {
  const agent = exec.agent as { id?: string; sessionId?: string } | undefined;
  const sessionId = agent?.id ?? agent?.sessionId;
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new KnowledgeError('OWNER_MISMATCH', 'Caller context must provide a non-empty session owner');
  }
  // This first increment is deliberately task-pinned in trusted config. It does not
  // read task identity or scope from user-supplied tool arguments.
  return {
    sessionId: sessionId.trim(),
    taskId: config.policy.allowedTaskIds[0],
    usageScopes: [...config.policy.usageScopes],
  };
}

const refSchema = {
  type: 'object',
  required: true,
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    sha256: { type: 'string', required: true },
  },
} as const;

export function applyKnowledgeTools(ctx: Context, toolConfig: KnowledgeToolConfig): KnowledgeService {
  const repoRoot = path.resolve(toolConfig.repoRoot);
  const configPath = path.resolve(toolConfig.configPath);
  const relativeConfig = path.relative(repoRoot, configPath);
  if (relativeConfig === '..' || relativeConfig.startsWith(`..${path.sep}`) || path.isAbsolute(relativeConfig)) {
    throw new KnowledgeError('POLICY_DENIED', 'Knowledge config must be inside the trusted repository workspace');
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as KnowledgeConfig;
  const service = new KnowledgeService({ repoRoot, libraryRoot: toolConfig.libraryRoot, config });
  ctx.on('dispose', () => service.dispose());

  ctx.tools.register(defineTool({
    name: 'evolver_import_knowledge_sources',
    description: 'Import only the host-pinned UTF-8 TXT/Markdown source list. No caller-supplied paths or network fetches are accepted.',
    parameters: { commandId: { type: 'string', required: true, description: 'Idempotency key' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: (args: unknown, exec: ToolRunContext) => service.importConfiguredSources((args as { commandId: string }).commandId, actorFor(exec, service.config)),
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_build_knowledge_snapshot',
    description: 'Build an immutable snapshot and deterministic keyword index from currently allowed source versions.',
    parameters: {
      commandId: { type: 'string', required: true, description: 'Idempotency key' },
      usageScope: { type: 'string', required: true, description: 'A scope in the host-frozen knowledge policy' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: (args: unknown, exec: ToolRunContext) => {
      const actor = actorFor(exec, service.config);
      const input = args as { commandId: string; usageScope: string };
      return service.buildSnapshot(input.commandId, actor, input.usageScope);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_retrieve_evidence',
    description: 'Retrieve an immutable EvidencePack from a permitted snapshot with fixed keyword ranking and context limits.',
    parameters: {
      commandId: { type: 'string', required: true, description: 'Idempotency key' },
      query: {
        type: 'object', required: true, additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          snapshotRef: refSchema,
          usageScope: { type: 'string', required: true },
          topK: { type: 'number', required: true },
          maxContextTokens: { type: 'number', required: true },
          filters: {
            type: 'object', required: false, additionalProperties: false,
            properties: {
              paperIds: { type: 'array', items: { type: 'string' } },
              sourceGroups: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: (args: unknown, exec: ToolRunContext) => {
      const input = args as { commandId: string; query: Record<string, unknown> };
      return service.retrieveEvidence(input.commandId, actorFor(exec, service.config), input.query);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_update_wiki',
    description: 'Publish a provisional Wiki revision from structured claims. The Host computes and stores the draft hash; every supported claim must cite a chunk in the selected EvidencePack.',
    parameters: {
      commandId: { type: 'string', required: true },
      update: {
        type: 'object', required: true, additionalProperties: false,
        properties: {
          pageId: { type: 'string', required: true },
          pageType: { type: 'string', required: true, enum: ['method', 'mechanism', 'compatibility', 'experiment'] },
          title: { type: 'string', required: true },
          baseRevisionRef: { ...refSchema, required: false },
          evidencePackRef: refSchema,
          claims: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: (args: unknown, exec: ToolRunContext) => {
      const input = args as { commandId: string; update: Record<string, unknown> };
      const update = { ...input.update, baseRevisionRef: input.update.baseRevisionRef ?? null };
      return service.updateWiki(input.commandId, actorFor(exec, service.config), update);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_invalidate_knowledge',
    description: 'Mark source dependencies stale or revoke a source. Revocation blocks reads even from historical snapshots.',
    parameters: {
      commandId: { type: 'string', required: true },
      changedSourceRefs: { type: 'array', required: true, items: refSchema },
      reason: { type: 'string', required: true },
      revoke: { type: 'boolean', required: false },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: (args: unknown, exec: ToolRunContext) => {
      const { commandId, ...payload } = args as { commandId: string; changedSourceRefs: unknown[]; reason: string; revoke?: boolean };
      return service.invalidateKnowledge(commandId, actorFor(exec, service.config), payload);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_lint_knowledge',
    description: 'Read-only structural and dependency lint for the latest Wiki pages visible in this snapshot.',
    parameters: { snapshotRef: refSchema },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: (args: unknown, exec: ToolRunContext) => service.getLintReport((args as { snapshotRef: unknown }).snapshotRef, actorFor(exec, service.config)),
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_get_paper',
    description: 'Read source metadata only when the paper is included in the selected permitted snapshot.',
    parameters: { paperId: { type: 'string', required: true }, snapshotRef: refSchema },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: (args: unknown, exec: ToolRunContext) => {
      const input = args as { paperId: string; snapshotRef: unknown };
      return service.getPaper(input.paperId, input.snapshotRef, actorFor(exec, service.config));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_get_wiki',
    description: 'Read a provisional Wiki revision and its cited excerpts only through a permitted snapshot.',
    parameters: { pageId: { type: 'string', required: true }, snapshotRef: refSchema },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: (args: unknown, exec: ToolRunContext) => {
      const input = args as { pageId: string; snapshotRef: unknown };
      return service.getWiki(input.pageId, input.snapshotRef, actorFor(exec, service.config));
    },
  }));

  return service;
}

