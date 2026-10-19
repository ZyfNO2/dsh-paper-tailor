/**
 * In-host full-chain diagnostic runner tool.
 *
 * `evolver_live_extract` only performs one P5 discovery. That is not enough for a
 * closing run: the diagnostic is a 12-case P5 -> P6 -> P7 chain with per-case
 * budgets, card-chain binding and an independent verifier, and the CLI entry
 * point reaches a model by forking a second DSH launcher, which has no connector
 * for the routes this project uses.
 *
 * This tool runs that same chain inside the host, over the host's own model
 * service, and writes a report the shared verifier can check.
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineTool, type Context, type ToolRunContext } from '@deepseek-ai/dsh-tools';

export interface HostDiagnosticConfig {
  provider: string;
  model: string;
  reasoningEffort?: string;
  repoRoot: string;
  fixtureRoot?: string;
  storageRoot: string;
  sessionId?: string;
}

/**
 * The runner's one exported entry point, described structurally.
 *
 * Deliberately not `typeof import('...')`: a relative specifier in a type
 * position resolves against this file's location, which is not the repo root
 * once the package is installed into a profile. The shape below is the part
 * this tool actually calls.
 */
type HostRunner = (cfg: {
  repoRoot: string;
  fixtureRoot?: string;
  hostLlm: unknown;
  provider: string;
  model: string;
  reasoningEffort?: string;
  storageRoot: string;
  ownerSessionId: string;
  caseId?: string;
}) => Promise<{ report: Record<string, unknown>; reportPath: string }>;

export function apply(ctx: Context, config: HostDiagnosticConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'evolver_phase1_diagnostic',
      description:
        'Run the frozen Phase 1 engineering-diagnostic closing validation (12 cases, P5 -> P6 -> P7) through the HOST model route. ' +
        'Cases, assertions and budgets are shared with the trusted CLI driver; only the transport differs. ' +
        'This spends real model calls across the whole set, so it is registered only when explicitly enabled.',
      parameters: {
        caseId: {
          type: 'string',
          description: 'Run a single case id (e.g. E005). Omit to run all 12. A single case is a smoke, not a closing run.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const a = (args ?? {}) as { caseId?: string };
        const sessionId =
          (exec.agent as { id?: string; sessionId?: string } | undefined)?.id ??
          (exec.agent as { sessionId?: string } | undefined)?.sessionId ??
          config.sessionId;
        if (!sessionId) {
          return { ok: false, stage: 'owner', detail: 'no host session id is available; refusing to invent an owner for a live run' };
        }

        // Imported lazily: the runner reaches back into the repo's scripts, and a
        // plugin load must not require them to exist.
        //
        // Resolved from `repoRoot` rather than a `../../..` chain. The chain is
        // only correct for one physical layout: the profile installs this package
        // under `node_modules`, so a path relative to the module silently lands
        // next to `node_modules` instead of in the repo. An absolute file URL
        // built from the configured root is correct wherever the package is
        // loaded from.
        const runnerUrl = pathToFileURL(path.join(config.repoRoot, 'scripts', 'eval-phase1-diagnostic-host.ts')).href;
        const { runHostDiagnostic } = (await import(runnerUrl)) as { runHostDiagnostic: HostRunner };
        const { report, reportPath } = await runHostDiagnostic({
          repoRoot: config.repoRoot,
          fixtureRoot: config.fixtureRoot,
          // `ctx.get`, not `ctx.llm`: see the inject note in adapters/dsh/index.ts.
          hostLlm: ctx.get('llm'),
          provider: config.provider,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          storageRoot: path.join(config.storageRoot, 'host-diagnostic'),
          ownerSessionId: sessionId,
          caseId: a.caseId,
        });
        return { ok: true, stage: 'complete', reportPath, status: report.status, route: report.route, report };
      },
    }),
  );
}
