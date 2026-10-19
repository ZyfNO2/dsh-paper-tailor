/**
* Thrown by `run_code` when the program run itself failed — a program
* exception, a budget expiry, an abort, or substrate death. Extends
* {@link HarnessError} (`code: 'CODE_RUN_FAILED'`); the registry's execution
* pipeline converts it into a structured `isError` result whose text carries
* the failure kind plus the captured logs, so the model can self-correct.
*/
export var CodeRunFailedError: {
    new (message: any): {
        name: string;
        code: any;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
/**
* Enforced JSON Schema subset shared by tool outputs, generated PTC mode
* types, subagents, and workflows. The subset accepts any JSON root, an
* annotation-only schema for unconstrained JSON, one scalar `type`, object
* `properties`/`required`/boolean `additionalProperties`, array `items`,
* type-correct scalar `enum`/`const`, and exact-one `oneOf`.
*
* Unsupported or misplaced keywords reject rather than being accepted without
* enforcement. Consumers that require an object root apply
* {@link assertObjectJsonSchema} before accepting input.
* @module dsh-tools/json-schema
*/
/**
* Thrown when a raw schema falls outside the enforced subset. `violations`
* lists every offending path instead of stopping at the first author error.
*/
export var JsonSchemaError: {
    new (violations: any): {
        /** Individual schema violations in walk order. */
        violations: any;
        name: string;
        code: any;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
/**
* PTC mode `run_code` transport. Programs call the registry's agent-visible
* tools through nested executions scheduled under the native concurrency
* contract; each sub-dispatch is logged for reconstruction, while only the
* outer curated result enters model history.
* @module @deepseek-ai/dsh-tools/src/ptc
*/
/** The model-facing name of the PTC mode tool. */
export const RUN_CODE_NAME: "run_code";
/** Canonical error code for cancellation after a tool body was invoked. */
export const TOOL_ABORTED: "ABORTED";
/** Canonical error code for cancellation before a tool body was invoked. */
export const TOOL_ABORTED_BEFORE_DISPATCH: "ABORTED_BEFORE_DISPATCH";
/**
* Scheduler entry point omitted from the generated named service API.
* @internal
*/
export const TOOL_RUNTIME_SCHEDULER: unique symbol;
/** Invalid model-generated arguments for a typed tool. */
export var ToolArgsError: {
    new (violations: any): {
        /** Individual violations in schema-walk order. */
        violations: any;
        name: string;
        code: any;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
/**
* Thrown (internally) when the model requests a tool that isn't registered.
* Extends {@link HarnessError} (`code: 'UNKNOWN_TOOL'`) so an unknown-tool
* failure is as routable as a tool-thrown one — retry/sandbox/replay code can
* distinguish it from a tool body's own error.
*/
export var ToolNotFoundError: {
    new (toolName: any, reachableFrom: any): {
        name: string;
        code: any;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
/** Thrown when a tool body or post-policy value violates its declared output. */
export var ToolOutputError: {
    new (toolName: any, violations: any): {
        /** Schema/value violations in validation order. */
        violations: any;
        name: string;
        code: any;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
/**
* Tool registry and execution pipeline. Scoped registrations shadow globals;
* one visibility resolver feeds presentation, lookup, and dispatch.
*/
export var ToolRuntime: {
    new (ctx: any, config?: {}): {
        /** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
        deferredContexts: WeakMap<WeakKey, any>;
        /** Executions whose tool body declared the current turn complete. */
        concludingExecutions: WeakSet<WeakKey>;
        /** Original caller cancellation, kept outside the wrapper-mutable execution object. */
        cancellationStates: WeakMap<WeakKey, any>;
        /** Definition-owned final content transform snapshotted before policy begins. */
        contentFinalizers: WeakMap<WeakKey, any>;
        layers: {
            createLayer: any;
            onChange: any;
            global: any;
            scoped: Map<any, any>;
            peek(scope: any): any;
            chainLayers(scope: any): any[];
            merge(scope: any, pick: any): Map<any, any>;
            effect(ctx: any, action: any, options: any): any;
        };
        /** Presentation for scopes that declare none; {@link presentAs} shadows it per scope. */
        defaultMode: any;
        maxParallelSubCalls: any;
        /**
        * Reserved presentation transport, kept outside the filterable registration
        * layers. Built on first need rather than at construction: which agents run
        * a PTC mode is no longer known when the service is constructed, and the
        * transport is stateless beyond its closures over `this`.
        */
        ptcTransport: any;
        /**
        * The prompt statement of the `ptc` executor collapse, registered wherever
        * {@link sdkSection} is and rendering empty outside an effective `ptc`.
        *
        * Every tool contributes its own guidance section naming its tool, none of
        * them qualify how that tool is reached, and they all render before the SDK.
        * Without this the model reads a catalog of tools it is told to use and no
        * statement that only `run_code` may be called, so it emits a native call,
        * receives `UNKNOWN_TOOL` for a tool the prompt just declared, and concludes
        * the deployment is inconsistent. Its order places the rule before that
        * guidance rather than after it.
        *
        * `both` renders empty: native calls do execute there, so the rule is false.
        * @returns the section registration.
        */
        collapseSection(): {
            name: string;
            order: any;
            text: (context: any) => "" | "`run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.";
        };
        /**
        * The generated-SDK prompt section, registered globally by a PTC mode
        * deployment and per scope by {@link presentAs}.
        *
        * The body regenerates from the CALLING scope, and renders empty for an
        * agent presenting natively — an agent that opted out under a PTC mode
        * deployment still sees the global registration, and an empty section is
        * dropped from the rendered prompt.
        * @returns the section registration.
        */
        sdkSection(): {
            name: string;
            order: any;
            text: (context: any) => any;
        };
        /**
        * The presentation one scope's agent sees: its own declaration, else the
        * deployment default.
        * @param scope - the calling agent, or undefined for the global view.
        * @returns the resolved presentation mode.
        */
        modeFor(scope: any): any;
        /**
        * The reserved `run_code` transport, built on first need.
        *
        * It never enters the global layer: per-agent restrictions must not remove
        * it, and a scoped registration must not shadow it. The visibility resolver
        * appends it after resolving the filterable global/scoped capability layers,
        * and only for scopes whose mode actually presents it.
        * @returns the shared transport definition.
        */
        requireCodeTransport(): any;
        /**
        * Present the calling scope's tools in `mode` instead of the deployment
        * default. Nearest scope on the chain wins, so a preset's standing
        * declaration covers every agent joined under it.
        *
        * Scoped only, and one declaration per scope: this is how an agent preset
        * composes PTC mode agents beside native ones in the same process, and a
        * process-global override would be the `mode` config field instead.
        * @param mode - the presentation the covered agents' models see.
        * @returns the exact disposer that restores the deployment default.
        */
        presentAs(mode: any): any;
        /**
        * Build one scope's wire schemas and names for prompt-order validation.
        * Restrictions do not make known tools invalid, but a mode collapse does.
        */
        wireSchemas(scope: any): {
            schemas: {
                name: any;
                description: any;
                parameters: any;
            }[];
            knownNames: any[];
        };
        /**
        * Resolve the code runtime or throw the actionable misconfiguration error.
        * Read at use time (assembly / run_code execution), NOT via static
        * `inject`: an inject entry would hold `ctx.tools` — and every tool plugin
        * behind it — hostage to a code runtime existing even under `mode:
        * 'native'`.
        *
        * Assembly and `run_code` execution read separately, so the language is not
        * bound to a request. Harmless while one published backend exists — both
        * reads return the same flavor — but a reload that swapped in a second
        * language between them would hand a program written against one SDK to the
        * other. Binding it is deferred until a second backend ships (the first
        * point it is testable).
        */
        requireCodeRuntime(mode: any): any;
        /**
        * Register globally or in the calling agent scope. Scoped tools shadow
        * globals; duplicates within one layer and the reserved `run_code` name fail.
        * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
        * @returns the exact disposer that unregisters the tool.
        */
        register(definition: any): any;
        /**
        * Restrict global tools for the calling agent scope. Empty filters, unknown
        * names, scope-local names, and reserved transport names fail. Restrictions
        * intersect; scoped registrations remain visible.
        * @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
        * @returns the exact disposer that lifts this restriction.
        */
        restrict(filter: any): any;
        /**
        * Register a monotonic guard after the extensible `tools/pre-execute`
        * waterfall. A plain-context guard applies globally; one registered through
        * `agent.ctx` applies only to that agent. Any matching guard may deny by
        * returning a reason, while no guard can force-allow a call another guard
        * denied. The exact effect disposer is returned for ordered ownership and
        * HMR cleanup.
        * @param guard - synchronous check; a returned string denies the execution.
        * @returns the exact disposer that unregisters the guard.
        */
        guard(guard: any): any;
        /** First monotonic denial from the global then the scope chain's guard layers, farthest first. */
        guardReason(exec: any): any;
        /**
        * Resolve every registry fact one scope needs in one layer traversal. The
        * visible map applies restrictions to the INHERITED surface, then the
        * scope's own registrations and the reserved presentation transport; the
        * other sets retain the pre-restriction facts needed by restriction and
        * prompt-order validation.
        *
        * A restriction filters what a scope inherits — the global layer and every
        * ancestor layer on its chain — and never what its OWN layer registers.
        * That exemption is what a per-child capability filter has to keep intact:
        * the delegation runtime registers a child's structured-output tool into the
        * child's own layer, and a filter naming the capabilities the child may use
        * must not strip the machinery it answers through.
        *
        * Reading the exempt set as "the global layer" instead of "not mine" held
        * only while every model-facing tool sat in the host composition. Once
        * presets moved them onto the agent plane they became an ANCESTOR
        * contribution, so a child's filter silently stopped constraining anything
        * it was given.
        * @param scope - the viewing scope (the agent), or undefined for the global view.
        * @returns the complete derived view for that scope.
        */
        view(scope: any): {
            visible: Map<any, any>;
            knownNames: Set<any>;
            restrictableNames: Set<any>;
        };
        /**
        * Look up a tool as one scope sees it (scoped
        * shadows global; a restricted-away global reads as absent). Presenters pass
        * the calling agent so the rendered card matches the definition that
        * actually executed.
        * @param name - the tool name as registered.
        * @param scope - the viewing scope (the agent); omitted = the global view.
        * @returns the definition the scope resolves, or undefined when none is visible.
        */
        get(name: any, scope: any): any;
        /**
        * Resolve the definition that MAY EXECUTE for a call, applying the mode
        * collapse at the operation boundary that owns it. The registry view
        * (`get`) is presentation-agnostic; here a MODEL-DIRECT call under `ptc`
        * may only name the reserved `run_code` transport, while a nested
        * sub-dispatch (a `parent` token set — the `run_code` SDK calling a tool
        * it bound) may call any visible tool. Denial surfaces as `UNKNOWN_TOOL`
        * through the executor, matching an absent definition.
        * @param name - the tool name as registered.
        * @param scope - the viewing scope (the agent); omitted = the global view.
        * @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
        * @returns the definition that may run, or undefined when the call must be rejected.
        */
        resolveExecution(name: any, scope: any, nested: any): any;
        /**
        * Project visible definitions onto the allowlisted model-facing schema fields,
        * excluding execution and presentation callbacks.
        * @param scope - the viewing scope (the agent); omitted = the global view.
        * @returns one deep-cloned schema per visible tool.
        */
        schemas(scope: any): {
            name: any;
            description: any;
            parameters: any;
        }[];
        /** Project visible callable tools onto the generated PTC mode SDK contract. */
        sdkSchemas(scope: any): {
            output: boolean;
            name: any;
            description: any;
            parameters: any;
        }[];
        /** Project one definition onto the model-facing schema fields. */
        schemaOf(definition: any, detachParameters: any): {
            name: any;
            description: any;
            parameters: any;
        };
        /**
        * Classify a pending call through the caller's visible tool definition. Only
        * an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
        * throwing classifiers are exclusive.
        * @param exec - call name, parsed arguments, and optional agent scope.
        * @returns the fail-closed scheduling mode.
        */
        executionMode(exec: any): {
            kind: string;
        };
        /**
        * Run the `tools/ptc-dispatch-log` waterfall over one settled sub-dispatch
        * and return the content the bridge should log on `tool/ptc-dispatch`.
        * Contained: when a listener throws, the method logs the original settled
        * content; that failure must not fail the dispatch or omit the settle event. Private:
        * the ONE consumer is the `run_code` bridge this registry constructs, which
        * receives it as a capability parameter (the `requireRuntime` idiom) — the
        * waterfall, not this invoker, is the public extension point.
        */
        shapeDispatchLog(dispatch: any): Promise<any>;
        /**
        * Whether the `ptc` mode collapse denies a model-direct call: only the
        * reserved `run_code` transport may be named. Nested sub-dispatches (a
        * `parent` token set) bypass the collapse. One home for the
        * security-relevant predicate, shared by {@link resolveExecution} and
        * {@link createExecution} so the two can never drift apart.
        *
        * Resolved through {@link modeFor}, NOT `defaultMode`: an agent given `ptc`
        * by an agent preset under a native deployment is the composition
        * `dsh-agent-tool-presentation` exists for, and reading the deployment default would
        * leave exactly that agent uncollapsed — announcing one surface while
        * executing another, which is the bypass this collapse closes.
        * @param name - the tool name as registered.
        * @param scope - the viewing scope whose effective presentation mode applies.
        * @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
        */
        collapses(name: any, scope: any, nested: any): boolean;
        /**
        * Execute through pre-policy, guards, around-dispatch, post-policy,
        * definition-owned content finalization, and final notification. Tool and
        * listener failures resolve as materialized error results; an invisible tool
        * reports `UNKNOWN_TOOL`. The returned outcome is the same lossless, frozen
        * snapshot final observers receive. Cancellation
        * arriving after entry and before final result materialization skips a
        * not-yet-started body with `ABORTED_BEFORE_DISPATCH` or replaces a
        * successful started outcome with `ABORTED`; already-started work is still
        * drained and may retain a tool-owned structured error.
        * @param exec - the typed same-process call input. The registry assigns its
        *   correlation token before policy begins.
        * @returns the materialized final result.
        */
        execute(exec: any): Promise<any>;
        completeScheduledExecution(prepared: any): Promise<any>;
        createExecution(exec: any): {
            kind: string;
            exec: {
                arguments: any;
                deferContext(context: any): void;
                concludeTurn(): void;
                parent?: any;
                agent?: any;
                token: symbol;
                callId: any;
                rootCallId: any;
                name: any;
                signal: any;
            };
            result: {
                content: {
                    type: string;
                    text: string;
                }[];
                isError: boolean;
                error: {
                    info?: {
                        name: string;
                        code: any;
                    };
                    message: any;
                };
            };
        } | {
            kind: string;
            exec: {
                arguments: any;
                deferContext(context: any): void;
                concludeTurn(): void;
                parent?: any;
                agent?: any;
                token: symbol;
                callId: any;
                rootCallId: any;
                name: any;
                signal: any;
            };
            result?: undefined;
        };
        /**
        * Run the ordered pre-execute and monotonic guard stages for the scheduler.
        * @param input - the caller-supplied execution input.
        * @returns the prepared execution plus the next scheduler stage.
        * @internal
        */
        prepareScheduledExecution(input: any): Promise<any>;
        prepareExecution(input: any, next: any): Promise<any>;
        /** Whether the original caller signal is currently aborted. */
        callerCancelled(exec: any): any;
        /** Canonical cancellation outcome selected by whether the tool body started. */
        cancellationResult(exec: any, prior: any): {
            additionalContexts?: any;
            content: {
                type: string;
                text: string;
            }[];
            isError: boolean;
            error: {
                message: string;
                info: {
                    name: string;
                    code: string;
                };
            };
        };
        /**
        * Dispatch the registered body with the original caller signal fused back
        * into any around-wrapper replacement. Cancellation never abandons the body:
        * a started promise reaches quiescence before its outcome becomes `ABORTED`.
        */
        dispatchToolBody(exec: any): Promise<any>;
        /**
        * Run around-dispatch and the tool body. Tool and unknown-tool failures still
        * receive post-execute; pipeline failures are already final.
        * @param exec - the prepared execution.
        * @returns whether the result still needs post-execute.
        * @internal
        */
        dispatchScheduledExecution(exec: any): Promise<{
            kind: string;
            result: any;
        }>;
        /**
        * Run ordered post-execute, then apply definition-owned content finalization,
        * materialize, and notify the final outcome.
        * @param exec - the prepared execution.
        * @param result - dispatch/pre result that still needs post-execute.
        * @returns the materialized final result.
        * @internal
        */
        finalizeScheduledExecution(exec: any, result: any): Promise<any>;
        /**
        * Materialize the candidate, apply definition-owned content finalization,
        * then materialize and notify the authoritative result.
        * @param exec - the prepared execution.
        * @param result - final result.
        * @returns the materialized final result.
        * @internal
        */
        finishScheduledExecution(exec: any, result: any): any;
        /** Apply the snapshotted tool-owned content transform without exposing other result fields. */
        applyFinalContent(exec: any, result: any): any;
        /** Notify observers without exposing a mutation or error channel into the outcome. */
        notifyResult(exec: any, result: any): void;
        /**
        * Resolve an `ask` decision to allow/deny through the approval seam. The
        * seam is consumed opportunistically with `ctx.get('approval')` — a
        * deployment that composes no ApprovalService keeps the historical degrade
        * to deny, and an unmount mid-session degrades the same way on the next ask.
        * An agent-less execution also degrades: without an agent there is no
        * session to audit to and no UI to route to. Otherwise the outcome maps
        * one-to-one — `allowed-once` proceeds; the three non-grants deny with
        * distinct reasons so the model can tell a human "no" from an absent
        * approval channel.
        */
        serviceAsk(exec: any, ask: any): Promise<void | {
            decision: {
                kind: string;
                reason: any;
            };
            approvalCancelled: boolean;
        } | {
            decision: {
                kind: string;
                reason?: undefined;
            };
            approvalCancelled: boolean;
        }>;
        /**
        * Run the `tools/post-execute` waterfall over a dispatched `result` and apply
        * its {@link PostToolDecision}: `accept` keeps the call successful (replacing
        * `content` when given), `block` turns it into an `isError` whose content is
        * the corrective `feedback`. Either decision may attach `additionalContexts`,
        * which are ferried on the returned result for the loop's active-batch FIFO.
        * Context deferred by the tool body survives an accepted result but is
        * discarded when the outer call is blocked; a block exposes only context the
        * blocking decision explicitly supplied.
        * Runs inside `execute`'s outer try/catch (a throwing listener → isError).
        */
        postExecute(exec: any, result: any): Promise<any>;
        /** Registry-normalized results and the exact dispatch that validated each value. */
        canonicalResults: WeakMap<WeakKey, any>;
        /** Mark one registry-normalized result as canonical only for its owning dispatch. */
        markCanonical(exec: any, result: any): any;
        /** Snapshot, validate, render, and optionally project one successful body value. */
        createSuccessResult(exec: any, tool: any, candidate: any): any;
        /** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
        normalizeDispatchResult(exec: any, result: any): any;
        /** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
        materializeFinalResult(result: any): any;
        /** Internal staged view consumed by `dsh-agent-loop`'s parallel scheduler. */
        [TOOL_RUNTIME_SCHEDULER]: {
            prepare: (exec: any) => Promise<any>;
            dispatch: (exec: any) => Promise<{
                kind: string;
                result: any;
            }>;
            finalize: (exec: any, result: any) => Promise<any>;
            finish: (exec: any, result: any) => any;
        };
    };
    inject: string[];
    Config: z<Schemastery.ObjectS<{
        mode: z<"native" | "ptc" | "both", "native" | "ptc" | "both">;
        maxParallelSubCalls: z<number, number>;
    }>, Schemastery.ObjectT<{
        mode: z<"native" | "ptc" | "both", "native" | "ptc" | "both">;
        maxParallelSubCalls: z<number, number>;
    }>>;
};
/**
* Assert the enforced subset plus the object-root constraint retained by
* subagent and workflow structured outputs.
* @param schema - untrusted caller-supplied schema.
* @returns Assertion that the schema belongs to the supported subset and has an object root.
*/
export function assertObjectJsonSchema(schema: any): void;
/**
* Assert that an arbitrary raw schema uses only the enforced subset.
* Annotation-only schemas are accepted as the standard unconstrained-JSON
* form; callers that require an object root use {@link assertObjectJsonSchema}.
* @param schema - untrusted raw JSON Schema.
* @returns Assertion that the schema belongs to the supported subset.
*/
export function assertSupportedJsonSchema(schema: any): void;
/**
* Define a test fixture that deliberately uses its content blocks as the
* canonical JSON value. Product tools must declare domain-owned DTOs instead.
* @param options - ordinary fixture fields plus a content-producing body.
* @returns a registry-ready tool with an explicit JSON-array output contract.
* @internal
*/
export function defineContentToolFixture(options: any): {
    execute(args: any, exec: any): Promise<any>;
    timeoutMs?: any;
    name: any;
    description: any;
    parameters: {
        required?: any;
        type: string;
        properties: any;
    };
    output: {
        presentationMeta?: (args: any, value: any) => any;
        schema: any;
        render(args: any, value: any): any;
    };
};
/**
* Define a first-party tool with inferred arguments and strict execution
* validation. Replay-only presenters validate softly and fall back to generic
* rendering for obsolete logged arguments.
* @param options - typed definition and optional finalizer and presenters.
* @returns A registry-ready definition.
*/
export function defineTool(options: any): {
    execute(args: any, exec: any): Promise<any>;
    timeoutMs?: any;
    name: any;
    description: any;
    parameters: {
        required?: any;
        type: string;
        properties: any;
    };
    output: {
        presentationMeta?: (args: any, value: any) => any;
        schema: any;
        render(args: any, value: any): any;
    };
};
/**
* Map one JSON-Schema node to a context-free Python type expression from the
* `typing` module. Handles every unified schema construct — `object` (degraded
* to `dict[str, Any]`: naming a `TypedDict` requires the render context that
* {@link renderToolsSdkPy} supplies), `const`/`enum` (→ `Literal[...]`),
* `oneOf` (→ union), `string`/`number`/`integer`/`boolean`/`null`, `array`
* (`items` → `list[T]`) — and returns `Any` for an unsupported or malformed
* schema, matching the TS flavor's `unknown` fallback. Type annotations in the
* emitted SDK are advisory: Python does not enforce them at runtime.
* @param schema - the JSON-Schema node.
* @returns the Python type text.
*/
export function jsonSchemaToPy(schema: any): string;
/**
* Map one enforced JSON-Schema node to a TypeScript type literal. Supports
* every unified schema construct and returns `unknown` for malformed or
* unsupported inputs without throwing.
* @param schema - the JSON-Schema node (any shape; hostile inputs degrade).
* @param indent - the indentation level for nested object members.
* @returns the TS type text (multi-line for objects with properties).
*/
export function jsonSchemaToTs(schema: any, indent?: number): string;
/**
* Compile the implicit open parameter object into raw JSON Schema.
* @param spec - per-property parameter definitions.
* @returns An object-rooted raw schema with no implicit-root openness override.
*/
export function parameterSchemaSpecToJsonSchema(spec: any): {
    required?: any;
    type: string;
    properties: any;
};
/**
* Render the full `tools:sdk` prompt section: the fixed usage instructions
* plus one `declare const tools` interface covering every given tool.
* Deterministic — tools are emitted in lexicographic name order, so an
* unchanged tool set produces byte-identical text across assemblies. The sort
* is not a total order on byte-equal names, so two schemas sharing a name
* would render in argument order; the caller's visible-capability map is keyed
* by name, so the input never carries a duplicate.
* @param schemas - the tool schemas to declare (the caller excludes
*   `run_code` itself).
* @returns the complete section text.
*/
export function renderToolsSdk(schemas: any): string;
/**
* Render the full `tools:sdk` prompt section under `runtime.language ===
* 'python'`: the Python-flavored usage instructions plus one named `TypedDict`
* per tool argument or output object (and per nested object) and one awaitable
* method per visible tool on a `Tools` protocol — typed args in, the tool's
* canonical output value out — with a `tools: Tools` singleton the model calls
* into. The `typing` import line lists exactly the symbols the render used.
* Deterministic — tools are emitted in lexicographic name order, and class
* declarations precede the protocol in that same order (nested classes before
* the parent that references them), so an unchanged tool set produces
* byte-identical text across assemblies. The sort is not a total order on
* byte-equal names, so two schemas sharing a name would render in argument
* order; the caller's visible-capability map is keyed by name, so the input
* never carries a duplicate.
* @param schemas - the tool schemas plus canonical output schemas to declare
*   (the caller excludes `run_code` itself).
* @returns the complete section text.
*/
export function renderToolsSdkPy(schemas: any): string;
/**
* Validate model-generated arguments against an implicit parameter schema.
* @param spec - declared parameter schema.
* @param args - candidate arguments, however malformed.
* @returns Path-qualified violations; empty means valid.
*/
export function validateArgs(spec: any, args: any): string[];
/**
* Validate a candidate value against an asserted raw schema. The function is
* total for arbitrary values and returns path-qualified violations.
* @param schema - a schema accepted by {@link assertSupportedJsonSchema}.
* @param value - the candidate JSON value.
* @param path - root label used in diagnostics.
* @returns All violations in walk order; empty means valid.
*/
export function validateJsonSchemaValue(schema: any, value: any, path?: string): string[];
/**
* Compile one author-facing value schema to the enforced raw JSON Schema
* subset. The author-only `json` node becomes an annotation-only schema.
* @param spec - schema for any JSON-value root.
* @returns The asserted raw schema projection.
*/
export function valueSchemaSpecToJsonSchema(spec: any): any;
import z from "@deepseek-ai/schemastery";
export { ToolRuntime as default };
