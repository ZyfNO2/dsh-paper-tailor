/**
 * One real P5 extraction through the host model route, end to end.
 *
 * Why this exists
 * ---------------
 * The research tools (evolver_discover_papers and friends) are the real product
 * surface, but they take a fully-formed request: a protocolRef, an inputRefs
 * array, a budget, and a TaskBrief. Building those by hand in a chat session is
 * error-prone and tells you nothing about whether the model route works, because
 * a malformed request fails before any model call happens.
 *
 * This tool assembles the request the same way the trusted driver does - reading
 * the fixture's own protocol, budget and input manifest - and then runs one real
 * discovery operation. It exists to answer exactly one question per call: does
 * the model return a schema-valid extraction over the frozen input?
 *
 * What it deliberately does NOT do
 * --------------------------------
 * It does not relax the schema, retry more than the budget allows, or convert a
 * rejection into a pass. If the model returns something malformed, the second
 * attempt is spent and the operation fails, and that failure is reported as-is.
 * A recorded failure is the measurement; hiding it would destroy the point.
 *
 * It is a diagnostic, not a gate. It writes only under artifacts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';

import { validateResearchBudget } from '../../contracts/research.ts';
import { InputAccessGuard, type ResearchModelPort } from '../../domain/paper-discovery.ts';
import { ResearchService, type ResearchCallerActor } from '../../application/research-service.ts';
import { DshSdkModelPort } from './dsh-sdk-port.ts';

export const name = 'evolver-live-extract';
export const inject: string[] = [];
export const provide: string[] = [];

export interface LiveExtractConfig {
  provider: string;
  model: string;
  fixturesRoot: string;
  storageRoot: string;
  skillRoot: string;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

export function apply(ctx: Context, config: LiveExtractConfig): void {
  // `ctx.get`, not `ctx.llm`: an undeclared service read throws. See the inject
  // note in adapters/dsh/index.ts.
  const hostLlm = ctx.get('llm');

  ctx.tools.register(
    defineTool({
      name: 'evolver_live_extract',
      description:
        'Run ONE real P5 discovery over the frozen corpus through the host model route, ' +
        'assembling the request the way the trusted driver does. Reports the raw outcome, ' +
        'including a rejection, so a model failure is visible rather than retried away.',
      parameters: {
        paperIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paper ids to extract. Defaults to the first three real papers of the corpus.',
        },
        maxCalls: {
          type: 'number',
          description:
            'Model-call budget for this sample. Diagnostic use only: the trusted runner fixes the budget from the frozen protocol and does not accept a caller override, so a widened budget here cannot be mistaken for a protocol run.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [
          { type: 'text', text: `live extract: ${JSON.stringify(value, null, 2)}` },
        ],
      },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const a = (args ?? {}) as { paperIds?: string[]; maxCalls?: number };

        if (!hostLlm || typeof (hostLlm as { stream?: unknown }).stream !== 'function') {
          return {
            ok: false,
            stage: 'host_llm_service',
            detail: 'this context exposes no llm.stream service',
          };
        }

        const port: ResearchModelPort = new DshSdkModelPort({
          provider: config.provider,
          model: config.model,
          llm: hostLlm as never,
          label: 'live extract',
        });

        const policy = readJson(path.join(config.fixturesRoot, 'isolation', 'readable-roots.json')) as {
          readableRoots: string[];
          deniedPaths: string[];
        };
        const repoRoot = path.resolve(config.fixturesRoot, '..', '..');
        const guard = new InputAccessGuard({
          readableRoots: policy.readableRoots.map((p) => path.resolve(repoRoot, p)),
          deniedPaths: policy.deniedPaths.map((p) => path.resolve(repoRoot, p)),
        });

        const manifest = readJson(path.join(config.fixturesRoot, 'inputs', 'manifest.json')) as {
          entries: Array<{ paperId: string; sourceGroup?: string; sections: Array<{ section: string; file: string }> }>;
        };
        const realIds = manifest.entries.filter((e) => !String(e.sourceGroup ?? '').startsWith('synthetic:')).map((e) => e.paperId);
        const paperIds = a.paperIds?.length ? a.paperIds : realIds.slice(0, 3);

        const selected = manifest.entries.filter((e) => paperIds.includes(e.paperId));
        if (selected.length !== paperIds.length) {
          return {
            ok: false,
            stage: 'input_selection',
            detail: `requested ${paperIds.join(',')} but the corpus does not contain all of them`,
            available: realIds,
          };
        }

        const publicProtocol = readJson(path.join(config.fixturesRoot, 'protocol', 'public.json'));
        const baseBudget = (publicProtocol.budgets as { basic?: Record<string, unknown> }).basic ?? {};
        const budget = validateResearchBudget({
          ...baseBudget,
          ...(typeof a.maxCalls === 'number' ? { maxCalls: a.maxCalls } : {}),
        });

        // The service resolves input refs through the registry and re-reads the
        // frozen text from it, so it is built here exactly as research-tools.ts
        // builds it rather than being stubbed: a stub would make the extraction
        // run against text the service never validated.
        const { CorpusRegistry } = await import('../../domain/paper-discovery.ts');
        const registry = new CorpusRegistry(config.fixturesRoot, guard);

        const service = new ResearchService({
          storageRoot: config.storageRoot,
          guard,
          fixturesRoot: config.fixturesRoot,
          ports: { discovery: port, synthesis: port },
        });

        const actor: ResearchCallerActor = {
          sessionId: `live-extract-${Date.now()}`,
          agentId: 'evolver-live-extract',
        };

        // Input refs come from the registry, not from this file. The registry owns
        // the id grammar and the document hash for each registered paper, and the
        // service rejects a ref whose hash does not match. Hand-building refs here
        // produced a POLICY_DENIED and then a SOURCE_MISMATCH, both of which are
        // the service correctly refusing caller-invented input.
        const registered = registry.inputRefs();
        const inputRefs = paperIds
          .map((id) => registered.find((r) => r.id.endsWith(`/${id}`)))
          .filter((r): r is NonNullable<typeof r> => Boolean(r));
        if (inputRefs.length !== paperIds.length) {
          return {
            ok: false,
            stage: 'input_selection',
            detail: `the registry has no input ref for: ${paperIds.filter((id) => !inputRefs.some((r) => r.id.endsWith(`/${id}`))).join(',')}`,
            registered: registered.map((r) => r.id),
          };
        }

        const started = Date.now();
        try {
          const out = await service.discoverPapers(
            {
              commandId: `live-extract-${Date.now()}`,
              protocolRef: {
                id: publicProtocol.protocolId as string,
                version: (publicProtocol.version as number) ?? 1,
                publicHash: publicProtocol.publicHash as string,
              },
              evalInvocationId: `live-${Date.now()}`,
              sampleKey: 'LIVE-P5-PROBE',
              budget,
              inputRefs: inputRefs as never,
            },
            actor,
            {
              registry,
              publicProtocol,
              skillText: fs.readFileSync(path.join(config.skillRoot, 'paper-discovery', 'SKILL.md'), 'utf8'),
              port,
            },
          );

          const result = (out as { result?: Record<string, unknown> }).result;
          return {
            ok: true,
            stage: 'completed',
            route: `${config.provider}/${config.model}`,
            ms: Date.now() - started,
            budget,
            paperIds,
            identifications: Array.isArray(result?.identifications) ? (result.identifications as unknown[]).length : 0,
            baselineCards: Array.isArray(result?.baselineCards) ? (result.baselineCards as unknown[]).length : 0,
            moduleCards: Array.isArray(result?.moduleCards) ? (result.moduleCards as unknown[]).length : 0,
            result,
          };
        } catch (err) {
          const code = (err as { code?: string }).code ?? 'UNKNOWN';
          return {
            ok: false,
            stage: 'rejected',
            route: `${config.provider}/${config.model}`,
            ms: Date.now() - started,
            paperIds,
            errorCode: code,
            detail: String((err as Error).message).slice(0, 600),
          };
        }
      },
    })
  );
}
