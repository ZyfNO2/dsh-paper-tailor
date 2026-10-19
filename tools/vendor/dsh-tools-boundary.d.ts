/**
 * Type-only boundary supplement for @deepseek-ai/dsh-tools.
 *
 * PROVENANCE (RG-F F1, see docs/mvp/RESUME-GAP-PREFLIGHT-F0-INVENTORY-20261007.md §3):
 * the shipped @deepseek-ai/dsh-tools@0.1.5-rc.2 bundle erases every type-only
 * export (its package.json `types` field points at a file that does not exist
 * in the published tarball). The generated declaration
 * tools/vendor/gen/dsh-tools/lib/index.d.ts recovers all VALUE exports by
 * mechanical inference from the shipped JS bytes. The type-only exports below
 * do not exist in the shipped bytes at all, so they are transcribed here as
 * concrete structural types from the observed runtime behaviour of the bundle
 * (field names verified in the shipped JS: callId, rootCallId, token, name,
 * arguments, agent, signal, deferContext, concludeTurn) and from the call
 * sites in this repository.
 *
 * Rules this file obeys:
 *  - it declares NO `any`: every field is concrete; unknown-erased surfaces
 *    stay absent rather than invented;
 *  - it is an INPUT to the required typecheck, not a suppression: production
 *    sources are unchanged and still checked against these shapes;
 *  - the runtime contract behind these shapes is enforced by the WTOOLS and
 *    GPR2 suites, which drive real ToolRunContext objects through defineTool;
 *  - if @deepseek-ai/dsh-tools ever ships real declarations, delete this file
 *    and re-pin the vendor identity.
 */

import '@deepseek-ai/dsh-tools';

declare module '@deepseek-ai/dsh-tools' {
  /** The cordis Context that the bundle re-exports as a type-only export. */
  export type Context = import('@deepseek-ai/cordis').Context;

  /**
   * The per-call execution context passed as the second argument of a tool's
   * execute. Structural transcription of the object the runtime and the DSH
   * host actually hand to tools.
   */
  export interface ToolRunContext {
    callId: string;
    rootCallId: string;
    token: string;
    name: string;
    arguments: unknown;
    agent?: { id?: string; sessionId?: string };
    signal: AbortSignal;
    deferContext: () => unknown;
    concludeTurn: () => void;
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The host-provided tool registry. Verified at runtime: every evolver
     * adapter registers through `ctx.tools.register(defineTool(...))` and the
     * WTOOLS suite drives the real registry object.
     */
    tools: { register: (tool: unknown) => void };
  }

  interface Events {
    /**
     * Cordis context disposal, emitted by the host runtime on teardown.
     * Name verified in the shipped cordis bundle (registerDispose hooks) and
     * exercised by every plugin's cleanup path.
     */
    dispose(): void;
  }
}
