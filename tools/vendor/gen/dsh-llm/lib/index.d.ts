export namespace APP_IDENTITY {
    export let product: string;
    export { version };
    export let url: string;
}
/** Incrementally compacts one attempt without retaining a second raw-chunk list. */
export var AssistantStreamAccumulator: {
    new (): {
        records: any[];
        /**
        * Add one timed chunk to the compact attempt stream.
        * @param value - model chunk and its original Session timestamp.
        * @returns a detached immutable copy for assembly and live publication.
        */
        push(value: any): any;
        /**
        * Return the current compact attempt stream.
        * @returns a detached immutable record list suitable for a durable event.
        */
        snapshot(): any;
    };
};
/**
* Incremental chunk-to-message assembler. This is the single canonical assembly
* algorithm used by the agent loop to build an assistant message from a chunk
* stream while logging the raw chunks for replay fidelity.
*
* @module @deepseek-ai/dsh-llm/assembler
*/
/**
* Incrementally assembles raw {@link StreamChunk}s into complete
* {@link ContentBlock}s and a final assistant {@link Message}.
*
* The agent loop feeds it while logging raw chunks for replay fidelity, then
* reads `blocks()` / `message()` / `usage` / `finish` once the stream ends,
* or `interruptedBlocks()` when cancellation cut the stream short.
*
* Tolerant of delta-only protocols (no block-start/end); deltas arriving for
* an index already closed by `block-end` are ignored (malformed stream) so a
* misbehaving adapter cannot grow memory or corrupt a completed block.
*/
export var BlockAssembler: {
    new (): {
        partials: Map<any, any>;
        order: any[];
        _usage: any;
        _finish: any;
        _replayState: any;
        /**
        * Feed one chunk into the assembly state.
        * @param chunk - the next raw chunk, in stream order.
        */
        push(chunk: any): void;
        ensure(index: any, blockType: any): any;
        assemble(partial: any, index: any): any;
        /** Invariant accessor: every index in `order` has a partial. */
        mustGet(index: any): any;
        /**
        * The one shared keep/drop decision over all seen blocks: max-token
        * truncation drops tool calls that cannot be executed safely. Emitted blocks
        * and replay metadata both derive from this result, so they cannot disagree.
        */
        assembled(): {
            blocks: any[];
            replay: any;
        };
        /**
        * Assemble all blocks seen so far, in stream order.
        * @returns one block per seen index, except that max-token truncation drops
        *   tool calls that cannot be executed safely; an open block assembles from
        *   its accumulated deltas (an unknown block type never closed by `block-end` throws).
        */
        blocks(): any[];
        /**
        * Assemble the prefix an interrupted stream can safely finalize: closed and
        * open text/reasoning blocks with non-whitespace content, in stream order.
        * Tool calls are omitted because interruption precedes dispatch; retaining
        * one would require a fabricated result. Open unknown blocks are also omitted.
        * @returns the kept blocks; empty when nothing streamed before the interruption.
        */
        interruptedBlocks(): any[];
        /** Usage from the `usage` chunk; undefined until one arrives. */
        get usage(): any;
        /** Finish reason from the `finish` chunk; `{kind: 'stop'}` when the stream ended without one. */
        get finish(): any;
        /**
        * Replay metadata from the terminal finish chunk, if any, with per-block
        * entries pruned in step with {@link blocks}. Undefined when the envelope's
        * entries do not align with the emitted blocks.
        */
        get replayState(): any;
        /**
        * The assembled assistant message.
        * @param source - producer attribution for the assembled message.
        * @returns a frozen assistant-role message over `blocks()` (same open-block assembly rules).
        */
        message(source?: {
            kind: string;
            plugin: string;
        }): any;
    };
};
/** Message value types, identity, and immutable construction helpers. */
/**
* Bound for a `notice` summary. The account rides a collapsed transcript row
* and is committed to the durable log, while its inputs — task labels, goal
* objectives, tool arguments — are caller text with no length of their own.
*/
export const CONTEXT_SUMMARY_MAX_CHARS: 120;
/** Canonical provider-neutral code for a model request rejected because its context window was exceeded. */
export const CONTEXT_WINDOW_EXCEEDED_CODE: "CONTEXT_WINDOW_EXCEEDED";
/**
* Canonical provider-neutral code for a response that completed normally but
* carried no content blocks at all. Providers occasionally emit a degenerate
* completion (a terminal stop with zero output); adapters classify it as this
* failure instead of yielding an empty assistant message, because an empty
* message silently ends the turn with nothing for the user or the loop to act
* on. The attempt produced nothing durable, so retry policy treats it as safe
* to repeat.
*/
export const EMPTY_RESPONSE_CODE: "EMPTY_RESPONSE";
/**
* Harness error base with a stable machine-routable code and chained cause.
* Package errors extend it so tool results and replay can retain failure class.
* @module @deepseek-ai/dsh-llm/error
*/
/**
* Base class for all harness errors. Carries a `code` (stable, programmatic —
* e.g. `NO_ADAPTER`, `INVALID_ARGS`, `INVARIANT`) distinct from the
* human-readable `message`, and supports `cause` chaining via the standard
* `ErrorOptions`. `name` defaults to the subclass constructor name.
*/
export var HarnessError: {
    new (message: any, code: any, options: any): {
        /** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
        code: any;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
* Canonical provider-neutral code for a credential that was supplied but
* cannot be used — malformed rather than absent. Distinct from
* `MISSING_CREDENTIAL` because the fix differs: correct the stored value
* rather than supply one. Deliberately outside the default retryable set —
* a malformed credential fails identically on every attempt.
*/
export const INVALID_CREDENTIAL_CODE: "INVALID_CREDENTIAL";
/**
* Provider-wire adapter for the harness message and stream vocabulary. Register implementations
* with `ctx.llm.registerAdapter(providers, adapter)`. Every provider HTTP request must include
* `attributionHeaders()`; prove the headers are added in the wire request or library header hook. The direct-fetch
* DeepSeek and library-backed pi-ai adapters meet this contract through different internals.
*/
export var LlmAdapter: {
    new (): {
        /**
        * Describe one provider route owned by this adapter.
        * @param provider - a route passed to `registerAdapter()` for this instance.
        * @returns detached display metadata whose id must equal `provider`.
        */
        providerInfo(provider: any): {
            id: any;
            name: any;
        };
        /**
        * Return the provider-owned retry policy captured with this route.
        * @param _provider - a route passed to `registerAdapter()` for this instance.
        * @returns a resolved policy, or `undefined` to use the normal defaults.
        */
        providerRetryPolicy(_provider: any): void;
        /**
        * Resolve provider-side request-image pricing for one exact model route.
        * The default declares none, so consumers fall back to their own neutral
        * estimate. Implementations must answer synchronously without I/O; the
        * token meter resolves this per measurement.
        * @param _provider - a route passed to `registerAdapter()` for this instance.
        * @param _model - exact model id passed to {@link GenerateOptions.model}.
        * @returns route-owned image pricing, or `undefined` when the route declares none.
        */
        imageRequestPricing(_provider: any, _model: any): void;
        /**
        * List models this adapter can currently advertise for one owned provider.
        * The result is advisory: an adapter may accept unlisted model ids, and
        * consumers must not turn absence into request rejection.
        * @param _provider - one provider route owned by this adapter.
        * @returns discoverable models in adapter-preferred order.
        */
        listModels(_provider: any): Promise<any[]>;
        /**
        * Resolve all metadata available for one exact model. This query is
        * independent of the advisory catalog and does not validate request routing.
        * @param provider - one provider route owned by this adapter.
        * @param model - exact model id passed to {@link GenerateOptions.model}.
        * @param _signal - cancellation for this exact-model lookup; asynchronous
        *   implementations must settle promptly after it aborts.
        * @returns provider/model identity plus any context, call-default, and reasoning metadata.
        */
        resolveModel(provider: any, model: any, _signal: any): Promise<{
            provider: any;
            id: any;
            name: any;
        }>;
        /**
        * Bind exact model metadata and the eventual request dispatch to one adapter generation.
        * Dynamic adapters override this so settings changes between preparation and
        * dispatch cannot combine one generation's capabilities with another's endpoint.
        * @param provider - registered provider route.
        * @param model - exact model id.
        * @param signal - cancellation for model resolution.
        * @returns model metadata and a one-generation stream entry point.
        */
        prepareCall(provider: any, model: any, signal: any): Promise<{
            model: {
                provider: any;
                id: any;
                name: any;
            };
            stream: (options: any) => any;
        }>;
    };
};
/**
* Brand one loop-owned streaming attempt identifier.
* @param id - the opaque Agent-lifecycle-local identifier.
* @returns the same string with the attempt-id brand.
*/
export function LlmAttemptId(id: any): any;
/**
* Typed error for LLM-related failures. Extends {@link HarnessError}, so the
* `code` string (e.g. `AUTH`, `RATE_LIMIT`, `NO_ADAPTER`) is shared taxonomy.
*/
export var LlmError: {
    new (message: any, code: any, options: any): {
        /** Serializable facts retained beside this live Error. */
        failure: Readonly<{
            requestId?: any;
            providerRetryAfterMs?: any;
            status?: any;
            message: string;
            code: string;
        }>;
        name: string;
        /** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
        code: any;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
* The abstract `llm` service: an adapter registry plus a streaming model-call
* API, interceptable via the `llm/stream` waterfall.
*/
export let LlmRuntime: {
    new (ctx: any): {
        adapters: Map<any, any>;
        directory: Map<any, any>;
        discoveries: Map<any, any>;
        /** Notify topology observers without letting one broken listener veto the commit. */
        emitAdaptersUpdated(): void;
        /** Contained-listener diagnostic shared by the sync and async failure paths. */
        warnAdaptersListenerFailure(error: any): void;
        /**
        * Register an adapter for the given provider routes. Throws `LlmError` with code
        * `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
        * Disposed with the fiber.
        * @param providers - every provider route this adapter should serve.
        * @param adapter - the adapter that streams calls for those providers.
        * @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
        */
        registerAdapter(providers: any, adapter: any): () => any;
        /**
        * Validate one candidate route set for `adapter`, treating routes this
        * registration already holds as available. Nothing is mutated: a rejected
        * candidate leaves the registry exactly as it was.
        */
        prepareRoutes(providers: any, adapter: any, owned: any): {
            adapter: any;
            provider: {
                id: any;
                name: any;
            };
            retryPolicy: any;
        }[];
        /**
        * Swap this registration's routes for the prepared ones in one synchronous
        * section, so no observer can see the registry between the release and the
        * re-registration. The route set's one mutation point is also where
        * `llm/adapters-updated` is published, so a `replace` announces itself
        * exactly like a first registration.
        */
        commitRoutes(owned: any, registrations: any): void;
        /**
        * Describe provider routes with a registered adapter.
        * @returns detached provider metadata in registration order.
        */
        listProviders(): any[];
        /**
        * Declare provider routes an adapter plugin can activate through
        * configuration. Registration is all-or-nothing: an empty list, invalid
        * entry, or a provider already declared by any registration throws
        * `LlmError` without registering the rest. Disposed with the fiber.
        * @param entries - every configurable provider this plugin owns.
        * @returns a handle that withdraws all of them, and can atomically replace them.
        */
        registerConfigurableProviders(entries: any): () => any;
        /**
        * List every declared configurable provider, registered or dormant.
        * @returns detached directory entries in declaration order.
        */
        listConfigurableProviders(): any[];
        /**
        * Offer to interrogate provider endpoints on behalf of the settings
        * namespace this plugin owns. The namespace is the key because that is what
        * a configuration surface already holds from the configurable-provider
        * directory, and because a provider being *added* has no route to name yet.
        * Disposed with the fiber.
        * @param settingsNs - the namespace whose profiles this discovery serves.
        * @param discover - interrogates one endpoint and must honor the supplied signal.
        * @returns the disposer that withdraws the offer.
        */
        registerModelDiscovery(settingsNs: any, discover: any): () => any;
        /**
        * Interrogate one provider endpoint for the models it advertises. The
        * request describes a draft, not a stored route, so nothing here reads or
        * writes settings or credentials — the caller owns both, and the reply is
        * candidate metadata a surface may offer for adoption.
        * @param settingsNs - namespace whose registered discovery serves this draft.
        * @param request - the endpoint, protocol, and one-shot credential to use.
        * @param signal - caller cancellation.
        * @returns the advertised models, deduplicated in endpoint order.
        */
        discoverModels(settingsNs: any, request: any, signal: any): Promise<{
            maxTokens?: any;
            contextWindow?: any;
            name?: any;
            id: any;
        }[]>;
        /**
        * Remote adapter for one draft provider interrogation.
        * @param settingsNs - namespace whose registered discovery serves this draft.
        * @param request - endpoint, protocol, and one-shot credential to use.
        * @param signal - caller cancellation supplied by the Remote carrier.
        * @returns advertised models in endpoint order.
        * @throws RemoteError with `llm/model-discovery-rejected` when discovery refuses or fails.
        */
        remoteDiscoverModels(settingsNs: any, request: any, signal: any): Promise<{
            maxTokens?: any;
            contextWindow?: any;
            name?: any;
            id: any;
        }[]>;
        /**
        * Resolve the retry policy captured when one provider route was registered.
        * @param provider - registered provider route to inspect.
        * @returns the provider-owned policy, with normal defaults already resolved.
        */
        providerRetryPolicy(provider: any): any;
        /**
        * Resolve provider-side request-image pricing for one exact route, or
        * `undefined` when the provider is unregistered or declares none. Unknown
        * providers degrade to `undefined` rather than throwing because callers
        * price durable history whose route may no longer be mounted.
        * @param provider - provider route named by a request header.
        * @param model - exact model id named by the same header.
        * @returns the owning adapter's image pricing for the route, when declared.
        */
        imageRequestPricing(provider: any, model: any): any;
        /**
        * Resolve the exact text one durable file occurrence contributes to every
        * provider request in the current execution environment.
        * @param ref - durable verbatim file reference from model history.
        * @returns the same deterministic handle text used at adapter dispatch.
        */
        fileRequestText(ref: any): string;
        /** Detach typed adapter-owned modality metadata. */
        detachedModalities(modalities: any): any[];
        /**
        * Discover models advertised by one registered provider. Catalog membership
        * is advisory and never changes routing or request validation.
        * @param provider - registered provider route to inspect.
        * @returns detached model metadata in adapter-preferred order.
        */
        listModels(provider: any): Promise<any>;
        /**
        * Resolve and validate all metadata from the adapter that owns one exact
        * route. The result is detached from adapter-owned objects; catalog
        * membership remains advisory and does not control request routing.
        * @param provider - registered provider route to inspect.
        * @param model - exact model id passed to the adapter.
        * @param signal - optional cancellation for adapter-owned asynchronous lookup.
        * @returns exact model identity plus available context and reasoning metadata.
        */
        resolveModelInfo(provider: any, model: any, signal: any): Promise<{
            systemPromptUpdate?: any;
            defaultMaxTokens?: any;
            context?: {
                contextWindow: any;
            };
            inputModalities?: any[];
            description?: any;
            provider: any;
            id: any;
            name: any;
        } | {
            reasoning: {
                defaultEffort?: any;
                efforts: any;
            };
            systemPromptUpdate?: any;
            defaultMaxTokens?: any;
            context?: {
                contextWindow: any;
            };
            inputModalities?: any[];
            description?: any;
            provider: any;
            id: any;
            name: any;
        }>;
        resolveModelInfoFor(registration: any, model: any, signal: any): Promise<{
            systemPromptUpdate?: any;
            defaultMaxTokens?: any;
            context?: {
                contextWindow: any;
            };
            inputModalities?: any[];
            description?: any;
            provider: any;
            id: any;
            name: any;
        } | {
            reasoning: {
                defaultEffort?: any;
                efforts: any;
            };
            systemPromptUpdate?: any;
            defaultMaxTokens?: any;
            context?: {
                contextWindow: any;
            };
            inputModalities?: any[];
            description?: any;
            provider: any;
            id: any;
            name: any;
        }>;
        /** Validate and detach one adapter-returned exact model result. */
        normalizeModelInfo(registration: any, model: any, resolved: any): {
            systemPromptUpdate?: any;
            defaultMaxTokens?: any;
            context?: {
                contextWindow: any;
            };
            inputModalities?: any[];
            description?: any;
            provider: any;
            id: any;
            name: any;
        } | {
            reasoning: {
                defaultEffort?: any;
                efforts: any;
            };
            systemPromptUpdate?: any;
            defaultMaxTokens?: any;
            context?: {
                contextWindow: any;
            };
            inputModalities?: any[];
            description?: any;
            provider: any;
            id: any;
            name: any;
        };
        /**
        * Validate a conversation call config against its exact model capability and
        * materialize adapter-configured defaults. Unsupported explicit efforts
        * reject before provider I/O; no clamping or aliasing is performed. This
        * standalone query does not bind a later dispatch; use {@link prepareCall}
        * when logging and streaming must share one adapter registration.
        * @param config - provider/model route and optional request controls.
        * @param signal - optional cancellation for adapter-owned capability lookup.
        * @returns a detached config only when a default must be materialized.
        */
        resolveCallConfig(config: any, signal: any): Promise<any>;
        resolveCallFor(registration: any, config: any, signal: any): Promise<{
            modelInfo: any;
            context?: any;
            config: any;
        }>;
        /** Validate request controls against one already-bound exact model result. */
        resolveCallWithInfo(config: any, info: any): {
            modelInfo: any;
            context?: any;
            config: any;
        };
        /**
        * Resolve one call under its current adapter registration. The returned
        * one-shot handle keeps that registration across header logging and dispatch,
        * so HMR cannot combine one adapter's capability result with another adapter.
        * @param config - provider/model route and optional request controls.
        * @param signal - optional cancellation for adapter-owned capability lookup.
        * @returns a prepared config and its registration-bound stream entry point.
        */
        prepareCall(config: any, signal: any): Promise<Readonly<{
            stream: (options: any) => any;
            systemPromptUpdate?: any;
            inputModalities?: readonly any[];
            context?: any;
            config: any;
            retryPolicy: any;
            adapterDefaults: any;
        }>>;
        registration(provider: any): any;
        /** Remove replay state whose historical route is owned by another adapter. */
        forAdapter(options: any, adapter: any): any;
        /**
        * Resolve the current execution-world read path of one durable file
        * reference through the mounted attachment and filesystem providers.
        */
        fileReadPath(ref: any): any;
        /**
        * Final adapter boundary. Adapter selection, dispatch, iterator construction,
        * and iteration failures become one terminal failure chunk. Middleware and
        * downstream consumer failures remain thrown plugin or consumer errors.
        */
        adapterStream(options: any, prepared: any): AsyncGenerator<any, void, unknown>;
        /**
        * Stream one model call as raw chunks (token-level deltas). Replay state is
        * retained only when the same adapter instance owns its historical provider
        * and the target provider. Final adapter selection remains fixed through
        * asynchronous exact-model resolution and dispatch. Adapter selection,
        * dispatch, and iteration failures become terminal `error` or `aborted`
        * finish chunks; middleware, nested-call, cleanup, and consumer failures
        * remain thrown.
        * @param options - the full request; `options.provider` selects the adapter.
        * @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
        */
        stream(options: any): any;
        streamWithRegistration(options: any, prepared: any): any;
    };
};
/**
* dsh-llm's owned branded ids: tool-call correlation and provider request
* diagnostics.
*
* The `Branded<B>` primitive and stateless constructor live in
* `@deepseek-ai/dsh-brand` so every owner of a cross-boundary id can brand it
* without depending on dsh-llm; see that package's README for the
* nominal-typing policy.
*
* @module @deepseek-ai/dsh-llm/brand
*/
/**
* Brand a message identifier.
* @param id - the opaque message identifier.
* @returns the same string with the message-id brand.
*/
export function MessageId(id: any): any;
/**
* Brand a provider-issued request identifier.
* @param id - the opaque provider-issued string.
* @returns the same string, branded; no validation is performed.
*/
export function ProviderRequestId(id: any): any;
/** Canonical provider-neutral code for an exhausted account quota or balance. */
export const QUOTA_EXCEEDED_CODE: "QUOTA";
/**
* Brand an adapter-owned reasoning-effort identifier.
* @param id - the opaque identifier exposed by one model capability.
* @returns the same string, branded; no validation is performed.
*/
export function ReasoningEffortId(id: any): any;
/** Cordis schema embedded by each concrete provider configuration. */
export const RetryPolicySchema: z<Schemastery.ObjectS<{
    mode: z<"normal", "normal">;
    maxRetries: z<number, number>;
    retryableCodes: z<string[], string[]>;
    backoff: z<Schemastery.ObjectS<{
        initialDelayMs: z<number, number>;
        maxDelayMs: z<number, number>;
        jitterRatio: z<number, number>;
    }>, Schemastery.ObjectT<{
        initialDelayMs: z<number, number>;
        maxDelayMs: z<number, number>;
        jitterRatio: z<number, number>;
    }>>;
}> | Schemastery.ObjectS<{
    mode: z<"always", "always">;
    backoff: z<Schemastery.ObjectS<{
        initialDelayMs: z<number, number>;
        maxDelayMs: z<number, number>;
        jitterRatio: z<number, number>;
    }>, Schemastery.ObjectT<{
        initialDelayMs: z<number, number>;
        maxDelayMs: z<number, number>;
        jitterRatio: z<number, number>;
    }>>;
}>, Schemastery.ObjectT<{
    mode: z<"normal", "normal">;
    maxRetries: z<number, number>;
    retryableCodes: z<string[], string[]>;
    backoff: z<Schemastery.ObjectS<{
        initialDelayMs: z<number, number>;
        maxDelayMs: z<number, number>;
        jitterRatio: z<number, number>;
    }>, Schemastery.ObjectT<{
        initialDelayMs: z<number, number>;
        maxDelayMs: z<number, number>;
        jitterRatio: z<number, number>;
    }>>;
}> | Schemastery.ObjectT<{
    mode: z<"always", "always">;
    backoff: z<Schemastery.ObjectS<{
        initialDelayMs: z<number, number>;
        maxDelayMs: z<number, number>;
        jitterRatio: z<number, number>;
    }>, Schemastery.ObjectT<{
        initialDelayMs: z<number, number>;
        maxDelayMs: z<number, number>;
        jitterRatio: z<number, number>;
    }>>;
}>>;
/**
* Brand a string as a {@link ToolCallId}.
* @param id - the provider-issued or synthesized call id.
* @returns the same string with the tool-call-id brand.
*/
export function ToolCallId(id: any): any;
/**
* Feed one compact stream into a {@link BlockAssembler} without materializing members.
* Each run contributes one delta carrying its joined fragments, which assembles the same
* blocks as the original per-member deltas because assembly only concatenates them;
* raw chunks are pushed as recorded. The records are trusted, not validated: validate a
* stream read at a durable boundary with {@link expandAssistantStream} first.
* @param stream - compact records from one durable Assistant settlement.
* @param assembler - assembler to feed; a fresh one by default.
* @returns the same assembler after every record was pushed.
*/
export function assembleAssistantStream(stream: any, assembler?: {
    partials: Map<any, any>;
    order: any[];
    _usage: any;
    _finish: any;
    _replayState: any;
    /**
    * Feed one chunk into the assembly state.
    * @param chunk - the next raw chunk, in stream order.
    */
    push(chunk: any): void;
    ensure(index: any, blockType: any): any;
    assemble(partial: any, index: any): any;
    /** Invariant accessor: every index in `order` has a partial. */
    mustGet(index: any): any;
    /**
    * The one shared keep/drop decision over all seen blocks: max-token
    * truncation drops tool calls that cannot be executed safely. Emitted blocks
    * and replay metadata both derive from this result, so they cannot disagree.
    */
    assembled(): {
        blocks: any[];
        replay: any;
    };
    /**
    * Assemble all blocks seen so far, in stream order.
    * @returns one block per seen index, except that max-token truncation drops
    *   tool calls that cannot be executed safely; an open block assembles from
    *   its accumulated deltas (an unknown block type never closed by `block-end` throws).
    */
    blocks(): any[];
    /**
    * Assemble the prefix an interrupted stream can safely finalize: closed and
    * open text/reasoning blocks with non-whitespace content, in stream order.
    * Tool calls are omitted because interruption precedes dispatch; retaining
    * one would require a fabricated result. Open unknown blocks are also omitted.
    * @returns the kept blocks; empty when nothing streamed before the interruption.
    */
    interruptedBlocks(): any[];
    /** Usage from the `usage` chunk; undefined until one arrives. */
    get usage(): any;
    /** Finish reason from the `finish` chunk; `{kind: 'stop'}` when the stream ended without one. */
    get finish(): any;
    /**
    * Replay metadata from the terminal finish chunk, if any, with per-block
    * entries pruned in step with {@link blocks}. Undefined when the envelope's
    * entries do not align with the emitted blocks.
    */
    get replayState(): any;
    /**
    * The assembled assistant message.
    * @param source - producer attribution for the assembled message.
    * @returns a frozen assistant-role message over `blocks()` (same open-block assembly rules).
    */
    message(source?: {
        kind: string;
        plugin: string;
    }): any;
}): {
    partials: Map<any, any>;
    order: any[];
    _usage: any;
    _finish: any;
    _replayState: any;
    /**
    * Feed one chunk into the assembly state.
    * @param chunk - the next raw chunk, in stream order.
    */
    push(chunk: any): void;
    ensure(index: any, blockType: any): any;
    assemble(partial: any, index: any): any;
    /** Invariant accessor: every index in `order` has a partial. */
    mustGet(index: any): any;
    /**
    * The one shared keep/drop decision over all seen blocks: max-token
    * truncation drops tool calls that cannot be executed safely. Emitted blocks
    * and replay metadata both derive from this result, so they cannot disagree.
    */
    assembled(): {
        blocks: any[];
        replay: any;
    };
    /**
    * Assemble all blocks seen so far, in stream order.
    * @returns one block per seen index, except that max-token truncation drops
    *   tool calls that cannot be executed safely; an open block assembles from
    *   its accumulated deltas (an unknown block type never closed by `block-end` throws).
    */
    blocks(): any[];
    /**
    * Assemble the prefix an interrupted stream can safely finalize: closed and
    * open text/reasoning blocks with non-whitespace content, in stream order.
    * Tool calls are omitted because interruption precedes dispatch; retaining
    * one would require a fabricated result. Open unknown blocks are also omitted.
    * @returns the kept blocks; empty when nothing streamed before the interruption.
    */
    interruptedBlocks(): any[];
    /** Usage from the `usage` chunk; undefined until one arrives. */
    get usage(): any;
    /** Finish reason from the `finish` chunk; `{kind: 'stop'}` when the stream ended without one. */
    get finish(): any;
    /**
    * Replay metadata from the terminal finish chunk, if any, with per-block
    * entries pruned in step with {@link blocks}. Undefined when the envelope's
    * entries do not align with the emitted blocks.
    */
    get replayState(): any;
    /**
    * The assembled assistant message.
    * @param source - producer attribution for the assembled message.
    * @returns a frozen assistant-role message over `blocks()` (same open-block assembly rules).
    */
    message(source?: {
        kind: string;
        plugin: string;
    }): any;
};
/**
* Accept one supplied credential, or refuse it as unusable.
*
* A stored key arrives from the credentials seam, a `.env` line, or a shell
* export, all of which pick up surrounding whitespace, so trimming is silent.
* Anything else fails here rather than inside `fetch`, whose ByteString
* refusal names a UTF-16 code point instead of the setting to change. The key
* never enters the message: `ref` names where to fix it, and echoing any part
* of a secret into a log or a UI is the failure this diagnosis avoids.
*
* Lives beside {@link LlmError} rather than in `./api-key.ts` so the predicate
* module stays dependency-free; both adapters share this one diagnosis instead
* of keeping near-identical local copies.
* @param raw - the credential exactly as supplied.
* @param pkg - the refusing package name, prefixed to the diagnostic.
* @param ref - the credential reference the value resolved through.
* @returns the trimmed, usable key.
*/
export function assertUsableApiKey(raw: any, pkg: any, ref: any): any;
/**
* Every raw chunk of one never-packed type, in stream order.
* @param stream - compact records from one durable Assistant settlement.
* @param type - chunk type that only appears as a raw record.
* @returns the matching chunks; empty when the stream has none.
*/
export function assistantStreamChunks(stream: any, type: any): any[];
/**
* Time of the first token in one compact stream per {@link isTokenDelta}, read from the
* records themselves and stopping at the first qualifying member.
* @param stream - compact records from one durable Assistant settlement.
* @returns the first token's time, or undefined when the stream carries no token.
*/
export function assistantStreamFirstTokenTime(stream: any): any;
/**
* Whether one compact stream carries any reader-visible content per {@link isVisibleChunk},
* stopping at the first qualifying member.
* @param stream - compact records from one durable Assistant settlement.
* @returns whether a transcript reader would see anything from this stream.
*/
export function assistantStreamHasVisibleContent(stream: any): any;
/**
* Whether one compact stream carries non-whitespace text per {@link chunkHasVisibleText},
* stopping at the first qualifying member.
* @param stream - compact records from one durable Assistant settlement.
* @returns whether the stream contributes visible text.
*/
export function assistantStreamHasVisibleText(stream: any): any;
/**
* Build the attribution headers an adapter must send on every provider
* request. Header names are lowercase (HTTP field names are case-insensitive
* on the wire).
* @param identity - the identity to send; defaults to {@link APP_IDENTITY} — omission cannot suppress attribution.
* @returns headers to merge into the provider request (currently just `user-agent`).
*/
export function attributionHeaders(identity?: {
    product: string;
    version: any;
    url: string;
}): {
    "user-agent": string;
};
/**
* Bound one `notice` summary to {@link CONTEXT_SUMMARY_MAX_CHARS}.
* @param summary - the producer's one-line account, of any length.
* @returns the account, ellipsized when it exceeds the bound.
*/
export function boundContextSummary(summary: any): any;
/**
* Field-wise equality over {@link LlmCallConfig} — the comparison a caller
* runs to decide whether a proposed configuration is a real change (worth a
* logged header snapshot) or the held one restated.
* @param a - one configuration.
* @param b - the other.
* @returns whether every field (including the `stop` list, element-wise) matches.
*/
export function callConfigEquals(a: any, b: any): any;
/**
* Whether one chunk carries non-whitespace text, as a text delta or a completed text block.
* Reasoning, Tool calls, and other block kinds never count.
* @param chunk - any stream chunk.
* @returns whether the chunk contributes visible text.
*/
export function chunkHasVisibleText(chunk: any): boolean;
/**
* True when typed model content contains a file block, walking nested
* tool-result content on the same recursion every file policy shares.
* Reads current content on every call without retaining scan results.
* @param content - typed model content blocks.
* @returns whether any nested block is a file.
*/
export function contentHasFile(content: any): boolean;
/**
* True when typed model content contains an image block, walking nested
* tool-result content. This is the one recursive image walk shared by every
* image policy (capability gating, text-only serialization, compaction
* survey), so a consumer cannot silently diverge on nesting depth.
* @param content - typed model content blocks.
* @returns whether any nested block is an image.
*/
export function contentHasImage(content: any): any;
/**
* Create one identified model-produced assistant message and freeze it before publication.
* @param input - complete content plus the provider, model, and optional replay state for a new assistant message.
* @returns an immutable assistant message with fixed role/source tags and a fresh stable identity.
*/
export function createAssistantMessage(input: any): any;
/**
* Create one identified message and freeze it before publication.
* @param input - complete role, content, and source for a new message.
* @returns an immutable message with a fresh stable identity.
*/
export function createMessage(input: any): any;
/**
* Create and freeze one identified system-role message holding a rendered
* system prompt.
* @param text - the complete rendered prompt; `''` records "no system prompt".
* @param plugin - the plugin that assembled the prompt.
* @returns an immutable system message with a fresh stable identity.
*/
export function createSystemMessage(text: any, plugin: any): any;
/**
* Create and freeze one identified tool-result message.
* @param input - call identity, raw result blocks, and outcome.
* @returns an immutable user-role tool-result message.
*/
export function createToolResultMessage(input: any): any;
/**
* Create one identified user-role message and freeze it before publication.
* @param input - complete content and source for a new user message.
* @returns an immutable user message with a fresh stable identity.
*/
export function createUserMessage(input: any): any;
/**
* Render a thrown value with its full `cause` chain and AggregateError
* members, so transport wrappers like undici's `TypeError: fetch failed`
* surface the underlying failure instead of masking it. Plain structured
* failures render their own data-backed `message`. Diagnostic-surface
* rendering only (messages, notices, logs) — never parse the result; route on
* {@link HarnessError.code}.
* @param value - the caught value (`unknown` in catch clauses).
* @returns the outermost message first, each cause appended with `: ` (skipped
* when it repeats the wrapper message verbatim), and AggregateError members
* bracketed and `; `-joined.
*/
export function errorChain(value: any): any;
/**
* Expand compact records into the exact timed chunk sequence.
* @param stream - compact records from one durable Assistant settlement.
* @returns detached timed chunks with every original delta boundary preserved.
* @throws {TypeError} when a record or reconstructed timestamp is invalid.
*/
export function expandAssistantStream(stream: any): {
    time: any;
    chunk: any;
}[];
/**
* Stable model-facing handle for one durable file reference: the address of
* the verbatim stored copy and the instruction to read it on demand. This is
* the only representation a provider ever receives for a file.
* @param ref - durable verbatim file reference.
* @param readonlyPath - execution-world path of the stored copy, when resolvable.
* @returns deterministic handle text naming the file, its size, and its address.
*/
export function fileHandleText(ref: any, readonlyPath: any): string;
/**
* Detach and deep-freeze a message whose identity already exists.
* @param message - complete message, including its stable identity.
* @returns an immutable snapshot that preserves the identity.
*/
export function freezeMessage(message: any): any;
/**
* Test whether the exact request object was assembled by dsh-agent-loop.
* @param request - request envelope observed at the LLM waterfall.
* @returns whether {@link markAgentLoopRequest} recorded this object.
*/
export function isAgentLoopRequest(request: any): boolean;
/**
* Recognize the context-overflow wording used by OpenAI-compatible providers
* and library adapters. Adapters pass all available provider code, type, and
* message text so both thrown and in-band delivery styles share one classifier.
* @param detail - provider error code/type/message text joined into one string.
* @returns true when the detail identifies a request exceeding the model context window.
*/
export function isContextWindowExceededError(detail: any): boolean;
/**
* Narrow an arbitrary thrown value to a HarnessError (for `instanceof` at runtime boundaries).
* @param value - the caught value (`unknown` in catch clauses).
* @returns true only for real instances; duck-typed or cross-realm errors do not narrow.
*/
export function isHarnessError(value: any): value is {
    /** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
    code: any;
    name: string;
    message: string;
    stack?: string;
    cause?: unknown;
};
/**
* Recognize provider wording that identifies an exhausted account quota rather
* than a transient request-rate limit.
* @param detail - provider error code/type/message text joined into one string.
* @returns true only for terminal quota, balance, credit, budget, or usage-limit wording.
*/
export function isQuotaExceededError(detail: any): boolean;
/**
* Whether one chunk carries the model's first output token for latency measurement.
* @param chunk - any stream chunk.
* @returns true for a non-empty text, reasoning, or Tool-call arguments fragment and for
*   every name-bearing Tool-call delta; false for block, usage, and finish chunks.
*/
export function isTokenDelta(chunk: any): boolean;
/**
* Whether one chunk by itself contributes reader-visible transcript content.
* Text and reasoning count only with non-whitespace content, streamed as a delta or
* completed as a block; a block of any other kind counts at its start and its end,
* except a Tool call, which is protocol rather than content. Usage and finish never count.
* @param chunk - any stream chunk.
* @returns whether a transcript reader would see this chunk.
*/
export function isVisibleChunk(chunk: any): boolean;
/**
* Every streamed text-delta fragment joined in stream order; reasoning and Tool-call fragments are excluded.
* @param stream - compact records from one durable Assistant settlement.
* @returns the joined text, empty when the stream carries no text delta.
*/
export function joinAssistantStreamText(stream: any): string;
/**
* The last raw chunk of one never-packed type, scanning backwards and stopping at the first hit.
* @param stream - compact records from one durable Assistant settlement.
* @param type - chunk type that only appears as a raw record.
* @returns the stream's final chunk of that type, or undefined when it has none.
*/
export function lastAssistantStreamChunk(stream: any, type: any): any;
/**
* Mark one exact request object as assembled by dsh-agent-loop.
* @param request - loop-owned request envelope before LLM dispatch.
* @returns the same request object marked as created by the process-local agent loop.
*/
export function markAgentLoopRequest(request: any): any;
/**
* Judge one *supplied* API key, trimming surrounding whitespace first.
*
* Trimming is silent because a padded key has one unambiguous reading; every
* other defect is reported. Absence is a configuration state this function
* never sees — a profile naming no credential authenticates through the
* provider's own ambient discovery or OAuth — so callers decide whether a
* value was supplied before asking.
* @param raw - the key exactly as configured, stored, or typed.
* @returns the trimmed key, or why it cannot be used.
*/
export function normalizeApiKey(raw: any): {
    ok: boolean;
    reason: string;
    value?: undefined;
} | {
    ok: boolean;
    value: any;
    reason?: undefined;
};
/**
* Return a deterministic transient projection whose oldest images are replaced
* in whole count and byte quanta after a route budget is exceeded. The target
* depends only on complete durable history: at 129 one-megabyte images under
* a 128 MiB bound with a 64 MiB quantum, the oldest 65 images are removed so
* 64 MiB remain; that removed prefix stays fixed until total history exceeds
* 192 MiB.
* @param messages - complete request history, oldest first.
* @param policy - route representation, budgets, and removal quanta.
* @returns original messages below both bounds, otherwise shallow copies with deterministic placeholders.
*/
export function offloadRequestImagesWithPolicy(messages: any, policy: any): any;
/**
* Number of oldest image occurrences one request projection removes, in whole
* count and byte quanta, once a route budget is exceeded. The result depends
* only on the represented lengths, so provider request pricing reproduces the
* exact serialization decision without building the projected messages.
* @param lengths - represented byte length of every occurrence, in request order.
* @param policy - count/byte budgets and removal quanta; unbounded when absent.
* @returns how many leading occurrences the projection replaces with placeholders.
*/
export function offloadedImagePrefixCount(lengths: any, policy: any): number;
/**
* Stable per-image placeholder for a request-limit omission.
* @param ref - durable normalized attachment omitted from this request.
* @param access - optional provider-resolved path for model tools.
* @returns identity, normalized metadata, and the available recovery path.
*/
export function offloadedImageText(ref: any, access: any): string;
/**
* Project durable file history into deterministic handle text for every model
* route. Unlike images, no provider receives file blocks natively, so this
* projection is unconditional in request assembly.
* @param messages - complete request history.
* @param resolvePath - resolve one reference's current execution-world read path.
* @returns the original list without files, otherwise shallow message copies with handle text.
*/
export function projectFilesToText(messages: any, resolvePath: any): any;
/**
* Project durable image history into deterministic text for an exact text-only model.
* @param messages - complete request history.
* @returns the original list without images, otherwise shallow message copies with stable placeholders.
*/
export function projectImagesForTextModel(messages: any): any;
/**
* Stable model-facing handle for one exact request image. Identity comes from
* the occurrence's own durable reference: request versions are prepared per
* attachment id, so one shared version may serve occurrences whose display
* names differ.
* @param ref - the occurrence's durable normalized attachment.
* @param version - exact request-image dimensions shown beside the text.
* @param access - optional path resolved for the current tool execution world.
* @returns attachment handle and request-image dimensions.
*/
export function requestImageHandleText(ref: any, version: any, access: any): string;
/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */
/**
* Bridge one attachment provider's host object location into the mounted
* tool execution world. The consumer supplies the current filesystem
* provider's mapping without making attachment or LLM definitions depend on it.
* @param attachments - provider that owns the normalized attachment object.
* @param mapHostPath - map one absolute host path into the current tool execution world.
* @param ref - durable normalized attachment reference.
* @returns a read-only execution-world path, or undefined when either provider exposes no mapping.
* @throws an attachment error when the durable reference is invalid.
*/
export function resolveImageAttachmentAccess(attachments: any, mapHostPath: any, ref: any): {
    readonlyPath: any;
};
/**
* Validate, default, and detach one provider-owned retry policy.
* @param config - optional provider configuration; omission selects normal defaults.
* @param path - diagnostic path naming the provider config that owns the value.
* @returns an immutable policy safe to capture in provider registration state.
*/
export function resolveRetryPolicy(config: any, path: any): Readonly<{
    initialDelayMs: any;
    maxDelayMs: any;
    jitterRatio: any;
    mode: "normal";
    maxRetries: any;
    retryableCodes: readonly any[];
}> | Readonly<{
    initialDelayMs: any;
    maxDelayMs: any;
    jitterRatio: any;
    mode: "always";
}>;
/**
* Time of the first member of one packed run that {@link isTokenDelta} accepts: a
* name-bearing Tool-call run starts at its first member, otherwise the first non-empty fragment.
* Stops scanning at that member.
* @param run - one packed delta run.
* @returns the member's reconstructed time, or undefined when no member qualifies.
*/
export function runFirstTokenTime(run: any): any;
/**
* Time of the first member of one packed run that {@link isVisibleChunk} accepts: the first
* non-whitespace text or reasoning fragment. A Tool-call run has none. Stops scanning at that member.
* @param run - one packed delta run.
* @returns the member's reconstructed time, or undefined when no member qualifies.
*/
export function runFirstVisibleTime(run: any): any;
/**
* Stable text shown to a model that cannot accept one durable image reference.
* @param ref - durable normalized attachment omitted from the request.
* @returns deterministic text-only placeholder.
*/
export function textOnlyImageText(ref: any): string;
/**
* The standard `User-Agent` value: `product/version (+url)`. The
* parenthesized `+url` comment is the conventional self-identification form
* (RFC 9110 §10.1.5 product + comment syntax).
* @param identity - the identity to render; defaults to {@link APP_IDENTITY}.
* @returns the ready-to-send header value.
*/
export function userAgent(identity?: {
    product: string;
    version: any;
    url: string;
}): string;
declare const version: any;
import z from "@deepseek-ai/schemastery";
export { LlmRuntime as default };
