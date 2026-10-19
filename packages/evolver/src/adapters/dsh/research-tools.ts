/**
 * DSH tool registration for the paper-only phases. Additive: the P0-P4 evolver tools are
 * untouched, and no research entry accepts a caller-supplied owner, status, score, or path.
 */

import { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ResearchError, type ArtifactRef, type CardRef, type ResearchTaskBrief } from '../../contracts/research.ts';
import { CorpusRegistry, InputAccessGuard, UnavailableModelPort, type ResearchModelPort } from '../../domain/paper-discovery.ts';
import type { SynthesisDraft } from '../../domain/research-synthesis.ts';
import { ResearchService, type ResearchCallerActor } from '../../application/research-service.ts';
import { resolveRepoPath } from './repo-root.ts';

export interface ResearchToolConfig {
  storageRoot: string;
  fixturesRoot: string;
  skillRoot: string;
  publicProtocolPath?: string;
  discoveryPort?: ResearchModelPort;
  synthesisPort?: ResearchModelPort;
}

function resolveActor(ctx: Context, exec: ToolRunContext): ResearchCallerActor {
  // Aligned with the plugin entry's resolveActor (adapters/dsh/index.ts): the
  // owning Session id comes from the invoking Agent only. There is deliberately
  // no `ctx.currentSessionId` fallback 閳?no DSH context property of that name
  // exists (an undeclared property read throws `cannot get property ... without
  // inject`), so a missing owner must be REJECTED, not attributed to a made-up
  // session. Typecheck (F2) exposed this dead fallback; the behaviour now
  // matches the documented plugin-entry decision.
  void ctx;
  const agent = exec.agent as { id?: string; sessionId?: string } | undefined;
  const sessionId = agent?.id ?? agent?.sessionId;
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new ResearchError('OWNER_MISMATCH', 'Caller context must provide a non-empty session owner');
  }
  return { sessionId: sessionId.trim(), agentId: agent?.id };
}

function readSkill(skillRoot: string, name: string): string {
  const file = path.join(skillRoot, name, 'SKILL.md');
  if (!fs.existsSync(file)) throw new ResearchError('DEPENDENCY_NOT_READY', `Skill "${name}" is not installed at ${file}`);
  return fs.readFileSync(file, 'utf8');
}

const objectSchema = { type: 'object', additionalProperties: true } as const;

export function applyResearchTools(ctx: Context, config: ResearchToolConfig): ResearchService {
  // `fixturesRoot`, `skillRoot` and `publicProtocolPath` come from trusted host
  // configuration and are written repo-relative by the shipped bundle patch (so it
  // contains no absolute path). Resolve them against the REPOSITORY, not the process
  // working directory: the host may be launched from anywhere, and a `cwd`-relative
  // reading made the shipped profile work only when the shell happened to sit in the
  // checkout.
  const fixturesRoot = resolveRepoPath(config.fixturesRoot);
  const skillRoot = resolveRepoPath(config.skillRoot);
  const publicProtocolPath = config.publicProtocolPath === undefined ? undefined : resolveRepoPath(config.publicProtocolPath);
  const policyPath = path.join(fixturesRoot, 'isolation', 'readable-roots.json');
  if (!fs.existsSync(policyPath)) {
    throw new ResearchError('DEPENDENCY_NOT_READY', `Paper-only isolation policy missing at ${policyPath}`);
  }
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as { readableRoots: string[]; deniedPaths: string[] };
  const repoRoot = path.resolve(fixturesRoot, '..', '..');
  const guard = new InputAccessGuard({
    readableRoots: policy.readableRoots.map((p) => path.resolve(repoRoot, p)),
    deniedPaths: policy.deniedPaths.map((p) => path.resolve(repoRoot, p)),
  });
  const registry = new CorpusRegistry(fixturesRoot, guard);
  const publicProtocol = JSON.parse(fs.readFileSync(publicProtocolPath ?? path.join(fixturesRoot, 'protocol', 'public.json'), 'utf8')) as Record<string, unknown>;
  const service = new ResearchService({
    storageRoot: config.storageRoot,
    guard,
    fixturesRoot,
    publicProtocolPath,
    ports: {
      discovery: config.discoveryPort ?? new UnavailableModelPort(),
      synthesis: config.synthesisPort ?? new UnavailableModelPort(),
    },
  });

  ctx.tools.register(
    defineTool({
      name: 'evolver_discover_papers',
      description:
        'P5 Discover: extract field-level evidenced research identification and proposed research cards from the frozen local inputs. Returns a receipt and keeps the session until the operation reaches a terminal state.',
      parameters: {
        commandId: { type: 'string', required: true, description: 'Idempotency key within the owning session' },
        protocolRef: { type: 'object', required: true, additionalProperties: true, description: 'paper-only-v1 protocol reference' },
        evalInvocationId: { type: 'string', required: true, description: 'Bounded invocation established by the trusted driver' },
        sampleKey: { type: 'string', required: true, description: 'Frozen evaluation sample' },
        budget: { type: 'object', required: true, additionalProperties: true, description: 'Call and time budget' },
        inputRefs: { type: 'array', required: true, items: objectSchema, description: 'Host-registered input references' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { receipt: objectSchema, operation: objectSchema, result: objectSchema },
        },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: `Discover accepted: ${JSON.stringify(value, null, 2)}` }],
      },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const actor = resolveActor(ctx, exec);
        const a = args as { inputRefs: ArtifactRef[] } & Parameters<ResearchService['discoverPapers']>[0];
        return service.discoverPapers(a, actor, {
          registry,
          publicProtocol,
          skillText: readSkill(skillRoot, 'paper-discovery'),
          port: config.discoveryPort,
        });
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: 'evolver_synthesize_research',
      description:
        'P6 Synthesize: judge mechanism-only compatibility over cards published by a succeeded P5 operation and emit candidates plus a research proposal. No training or code adaptation is implied.',
      parameters: {
        commandId: { type: 'string', required: true, description: 'Idempotency key within the owning session' },
        protocolRef: { type: 'object', required: true, additionalProperties: true, description: 'paper-only-v1 protocol reference' },
        evalInvocationId: { type: 'string', required: true, description: 'Bounded invocation established by the trusted driver' },
        sampleKey: { type: 'string', required: true, description: 'Frozen evaluation sample' },
        budget: { type: 'object', required: true, additionalProperties: true, description: 'Call and time budget' },
        taskBrief: { type: 'object', required: true, additionalProperties: true, description: 'ResearchTaskBrief' },
        cardRefs: { type: 'array', required: true, items: objectSchema, description: 'Card references with producer operation ids' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { receipt: objectSchema, operation: objectSchema, result: objectSchema } },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: `Synthesize result: ${JSON.stringify(value, null, 2)}` }],
      },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const actor = resolveActor(ctx, exec);
        const a = args as { taskBrief: ResearchTaskBrief; cardRefs: CardRef[]; draft?: SynthesisDraft } & Parameters<
          ResearchService['synthesizeResearch']
        >[0];
        const skillText = readSkill(skillRoot, 'research-synthesis');
        // The service builds the synthesis prompt itself from the published cards it
        // resolves, and requires publicProtocol + skillText to do so. Passing a
        // hand-built `prompt` here both left those two required inputs missing and
        // risked describing cards the service never loaded, so the live branch now
        // passes exactly what the trusted driver passes.
        return service.synthesizeResearch(
          { ...a },
          actor,
          config.synthesisPort
            ? { registry, publicProtocol, skillText, port: config.synthesisPort }
            : { registry, draft: a.draft, publicProtocol, skillText }
        );
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: 'evolver_rank_research',
      description:
        'P7 Rank: deterministic scoring-policy-v1 triage of a P6 candidate set into eligible / conditional / not_rankable / excluded. Makes no model call and never modifies P6 artifacts.',
      parameters: {
        commandId: { type: 'string', required: true, description: 'Idempotency key within the owning session' },
        protocolRef: { type: 'object', required: true, additionalProperties: true, description: 'paper-only-v1 protocol reference' },
        evalInvocationId: { type: 'string', required: true, description: 'Bounded invocation established by the trusted driver' },
        sampleKey: { type: 'string', required: true, description: 'Frozen evaluation sample' },
        budget: { type: 'object', required: true, additionalProperties: true, description: 'Must request zero model calls' },
        candidateSetRef: { type: 'object', required: true, additionalProperties: true, description: 'Published P6 result reference' },
        scoringPolicyRef: { type: 'object', required: true, additionalProperties: true, description: 'Versioned scoring policy reference' },
        sourceOperationId: { type: 'string', required: true, description: 'Succeeded P6 operation id' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { receipt: objectSchema, operation: objectSchema, result: objectSchema } },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: `Ranking: ${JSON.stringify(value, null, 2)}` }],
      },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const actor = resolveActor(ctx, exec);
        const a = args as Parameters<ResearchService['rankResearch']>[0];
        const cardsById = new Map();
        const evidenceIds = new Set<string>();
        for (const operation of service.listOperations()) {
          if (operation.phase !== 'p5_discover' || operation.status !== 'succeeded') continue;
          const body = JSON.parse(fs.readFileSync(path.resolve(config.storageRoot, operation.resultRefs[0].id), 'utf8')) as {
            evidenceSpans: Array<{ id: string }>;
            baselineCards: Array<Record<string, unknown>>;
            moduleCards: Array<Record<string, unknown>>;
          };
          body.evidenceSpans.forEach((s) => evidenceIds.add(s.id));
          for (const card of [...body.baselineCards, ...body.moduleCards]) {
            cardsById.set(card.id as string, card);
          }
        }
        return service.rankResearch(a, actor, {
          scoringPolicy: publicProtocol.scoringPolicy as Record<string, unknown>,
          resolvableEvidenceIds: evidenceIds,
          cardsById,
        });
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: 'evolver_get_research_operation',
      description: 'Read a research operation descriptor. Reading consumes no model budget and is owner-checked.',
      parameters: { operationId: { type: 'string', required: true, description: 'Research operation id' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const actor = resolveActor(ctx, exec);
        return service.getResearchOperation((args as { operationId: string }).operationId, actor);
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: 'evolver_stop_research_operation',
      description: 'Idempotently stop a research operation. Stopping is never gated by remaining budget.',
      parameters: {
        operationId: { type: 'string', required: true, description: 'Operation to stop' },
        commandId: { type: 'string', required: true, description: 'Stop command id, in its own namespace' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const actor = resolveActor(ctx, exec);
        const a = args as { operationId: string; commandId: string };
        return service.stopResearchOperation(a.operationId, a.commandId, actor);
      },
    })
  );

  return service;
}
