/**
 * Host probe tool: proves the SDK port works on the REAL host route.
 *
 * Why a tool and not a script
 * --------------------------
 * A bare node script has no Cordis context, so it cannot see the host's `llm`
 * service at all - running one only proves that the script is not a host. A
 * plugin tool is executed BY the host, so `ctx.llm` inside it is the real thing,
 * with the user's configured route and credentials already loaded.
 *
 * What it does
 * ------------
 * One call through DshSdkModelPort on the route this plugin was configured with,
 * then one through a deliberately wrong provider, to show that an unavailable
 * route is reported as unavailable rather than being papered over.
 *
 * It registers as `evolver_probe_live_route` and writes nothing to the repository.
 */

import { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DshSdkModelPort } from './dsh-sdk-port.ts';

export const name = 'evolver-live-probe';
export const inject: string[] = [];
export const provide: string[] = [];

export interface LiveProbeConfig {
  provider: string;
  model: string;
}

export function apply(ctx: Context, config: LiveProbeConfig): void {
  // `ctx.get`, not `ctx.llm`: an undeclared service read throws. See the inject
  // note in adapters/dsh/index.ts.
  const hostLlm = ctx.get('llm');

  ctx.tools.register(
    defineTool({
      name: 'evolver_probe_live_route',
      description:
        'Verify the host model route is reachable through the plugin SDK port. ' +
        'Reports whether the host exposes an llm service, then makes one real call.',
      parameters: {
        // `required: false` is rejected by dsh-tools (UNSUPPORTED_SCHEMA: "must be
        // true when present"), so optionality is expressed by omitting the field
        // entirely. A boolean declared this way defaults to false when absent.
        confirmCall: {
          type: 'boolean',
          description: 'Set true to spend one real model call. Absent or false inspects the host only.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [
          { type: 'text', text: `live route probe: ${JSON.stringify(value, null, 2)}` },
        ],
      },
      execute: async (args: unknown) => {
        // Default to NOT spending a call. This default used to be `true`, which
        // contradicted the parameter description ("Absent or false inspects the
        // host only") and made a plain inspection silently cost a real model
        // call. Inspecting the host is free and is what a probe should do by
        // default; spending a call has to be an explicit choice.
        const { confirmCall = false } = (args ?? {}) as { confirmCall?: boolean };

        if (!hostLlm || typeof (hostLlm as { stream?: unknown }).stream !== 'function') {
          return {
            ok: false,
            stage: 'host_llm_service',
            detail: 'this context exposes no llm.stream service; the plugin cannot reach the host model runtime',
            configured: config,
          };
        }

        const base = {
          ok: true,
          stage: 'host_llm_service',
          detail: 'host exposes llm.stream',
          configured: config,
        };

        if (!confirmCall) return { ...base, called: false };

        const port = new DshSdkModelPort({
          provider: config.provider,
          model: config.model,
          llm: hostLlm as never,
          label: 'host probe',
        });

        try {
          const result = await port.invoke({
            requestHash: `probe-${Date.now()}`,
            systemPrompt: 'Answer with a single short token and nothing else.',
            userPrompt: 'Reply with exactly: PORT_OK',
            maxInputTokens: 2048,
            maxOutputTokens: 64,
            timeoutMs: 120000,
          } as never);
          return {
            ...base,
            called: true,
            ok: true,
            route: result.route,
            text: result.text.slice(0, 200),
            charCount: result.text.length,
          };
        } catch (err) {
          const code = (err as { code?: string }).code ?? 'UNKNOWN';
          return {
            ...base,
            called: true,
            ok: false,
            errorCode: code,
            detail: String((err as Error).message).slice(0, 400),
          };
        }
      },
    })
  );
}
