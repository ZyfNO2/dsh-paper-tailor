/**
* Insertion-ordered anonymous entries with independent registration identity.
*
* Equal values remain separate registrations. Values are borrowed, and
* iterators are live within one nonempty table generation; draining the table
* detaches them from later appends.
*/
export var AnonymousEntries: {
    new (): {
        data: Map<any, any>;
        /**
        * Append one independently owned value.
        * @param value - borrowed value to retain.
        * @returns an idempotent undo for this exact append.
        */
        append(value: any): () => void;
        /**
        * Iterate live values in insertion order.
        * @returns the native live value iterator.
        */
        values(): MapIterator<any>;
        /**
        * Test whether this table has no entries.
        * @returns whether the table is empty.
        */
        isEmpty(): boolean;
    };
};
/**
* Shared insertion-ordered storage and effect ownership for scope-aware registries.
*
* @module @deepseek-ai/dsh-scope
*/
/**
* Insertion-ordered named entries with caller-owned duplicate diagnostics.
*
* Values are borrowed. Iterators are live within one nonempty table
* generation; draining the table detaches them from later insertions. Each
* successful insertion returns an idempotent undo for that exact entry.
*/
export var NamedEntries: {
    new (duplicateError: any): {
        duplicateError: any;
        data: Map<any, any>;
        /**
        * Insert one unique name.
        * @param name - name unique within this table.
        * @param value - borrowed value to retain.
        * @returns an idempotent undo that removes only this insertion.
        */
        insert(name: any, value: any): () => void;
        /**
        * Read one named value.
        * @param name - name to resolve.
        * @returns the retained value, or `undefined` when absent.
        */
        get(name: any): any;
        /**
        * Test one name for membership.
        * @param name - name to test.
        * @returns whether the table contains that name.
        */
        has(name: any): boolean;
        /**
        * Iterate live names in insertion order.
        * @returns the native live key iterator.
        */
        keys(): MapIterator<any>;
        /**
        * Iterate live entries in insertion order.
        * @returns the native live entry iterator.
        */
        entries(): MapIterator<[any, any]>;
        /**
        * Iterate live values in insertion order.
        * @returns the native live value iterator.
        */
        values(): MapIterator<any>;
        /**
        * Test whether this table has no entries.
        * @returns whether the table is empty.
        */
        isEmpty(): boolean;
    };
};
/**
* Own the global and exact-scope layers for one registry.
*
* Reads never create scoped layers. Registrations derive both visibility and
* effect ownership from the supplied Cordis context, collect undo before
* notification, and reclaim only a completely empty aggregate layer.
*/
export var ScopedLayers: {
    new (createLayer: any, onChange: any): {
        createLayer: any;
        onChange: any;
        /** The eagerly constructed context-global layer. */
        global: any;
        scoped: Map<any, any>;
        /**
        * Read an existing exact-scope overlay. Deliberately chain-blind: callers
        * addressing one scope's OWN contributions (its restrictions, its guards)
        * must not silently pick up an ancestor's — use {@link chainLayers} where
        * inheritance is the point.
        * @param scope - exact scope key; `undefined` denotes no overlay.
        * @returns the existing scoped layer, or `undefined` without creating one.
        */
        peek(scope: any): any;
        /**
        * Existing overlays along the scope's parent chain ({@link scopeChainOf}),
        * farthest ancestor first and the exact scope last, so a caller layering
        * them in order gives the nearest scope the final word.
        * @param scope - viewing scope, or `undefined` for no overlays.
        * @returns the existing layers, nearest last; absent overlays are skipped.
        */
        chainLayers(scope: any): any[];
        /**
        * Materialize global named entries followed by scope-chain shadows,
        * farthest ancestor first, so the nearest scope's entry wins a name.
        * @param scope - viewing scope, or `undefined` for the global view.
        * @param pick - select the named table from a layer.
        * @returns an insertion-ordered effective map.
        */
        merge(scope: any, pick: any): Map<any, any>;
        /**
        * Attach one synchronous layer mutation to its registration context.
        * @param ctx - context that determines both scope visibility and effect ownership.
        * @param action - atomic mutation returning its synchronous undo.
        * @param options - Cordis effect label and optional change notification.
        * @returns the exact disposer returned by `ctx.effect()`.
        */
        effect(ctx: any, action: any, options: any): any;
    };
};
/**
* Bind `parent` as `key`'s enclosing scope, once.
*
* A key that already has a parent throws: there is no open re-link path, so a
* scope's ancestry cannot be moved by anyone but the original binder, who
* alone receives the {@link ScopeParentBinding}. A link that would close a
* cycle is rejected, because every chain consumer walks parents to the root.
* @param key - the child scope key.
* @param parent - its enclosing scope key.
* @returns the binding that alone may re-link this key.
*/
export function bindScopeParent(key: any, parent: any): {
    rebind(next: any): void;
};
/**
* Read a carrier's routing key.
* @param value - dispatch receiver to inspect.
* @returns the carrier key, or `undefined` for an unkeyed/non-carrier value.
*/
export function carrierKeyOf(value: any): any;
/**
* Mint a scope under `ctx`. The scoped context inherits the minting plugin's
* dependency API and owns every registration made through it.
* @param ctx - active context whose dependency API the scope inherits.
* @param key - opaque identity used for listener routing.
* @param options - optional scope-chain placement.
* @returns the scoped context and exact/shared disposal boundaries.
*/
export function createScope(ctx: any, key: any, options: any): {
    ctx: any;
    rawDispose: any;
    dispose: () => any;
};
/**
* Test whether a value is a scope carrier.
* @param value - dispatch receiver to inspect.
* @returns whether {@link scopeTarget} created it.
*/
export function isScopeCarrier(value: any): boolean;
/**
* The chain from a key to its root ancestor.
* @param key - the starting key, or `undefined` for the empty chain.
* @returns keys nearest-first: `[key, parent, grandparent, …]`.
*/
export function scopeChainOf(key: any): any[];
/**
* Read the nearest scope tag inherited by a context.
* @param ctx - context to inspect.
* @returns its scope key, or `undefined` for an unscoped context.
*/
export function scopeOf(ctx: any): any;
/**
* Read one key's enclosing scope.
* @param key - the scope key to inspect.
* @returns its parent key, or `undefined` for a root scope.
*/
export function scopeParentOf(key: any): any;
/**
* Build an opaque receiver that preserves the base filter, admits untagged
* listeners globally, and admits tagged listeners for a matching key or any
* of its ancestors ({@link bindScopeParent}): a listener owned by an enclosing
* scope receives every descendant scope's events, which is what lets one
* standing composition observe each of the agents composed under it. A tag
* BELOW the dispatch key stays excluded — events flow up the chain, never
* down.
* @param base - subject or service whose existing Cordis filter is preserved.
* @param key - routed scope identity, or `undefined` for an unscoped subject.
* @returns a carrier whose subject remains available only through event arguments.
*/
export function scopeTarget(base: any, key: any): {
    [Context.filter](ctx: any): boolean;
};
import { Context } from "@deepseek-ai/cordis";
