import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ExperimentError, expAssertArtifactRef, expAssertId, expNoExtraKeys, type ArtifactRef } from '../contracts/experiments.ts';
import { validateResearchCommand, type ResearchCommandReceipt } from '../contracts/research-command.ts';
import { validateResearchAssetDraft, validateResearchAssetRevision, type ResearchAssetDraft, type ResearchAssetRevision, type ResearchAssetKind } from '../contracts/research-assets.ts';
import { canonicalJsonV1, parseJsonStrictV1, typedHash } from '../domain/research-canonical.ts';
import { LINK_VALIDATORS, type ResearchLinkedKind, type ResearchLinkedRecord, type ResearchPosition, type ResearchContribution,
  type ResearchAssetRelation, type ResearchCitation, type ResearchProcessNode } from '../contracts/research-asset-links.ts';
import { researchInteger } from '../contracts/research-command.ts';
import { PublishedResearchObservationReader } from './research-observation-reader.ts';

export interface ResearchAssetActor { sessionId: string; taskId: string; usageScopes: string[] }
export interface ResearchDependencyDescriptor {
  kind: string; scope: ResearchAssetDraft['scope']; status: 'current' | 'stale' | 'revoked';
}
export interface ResearchAssetServiceOptions {
  directory: string; taskId: string; ownerSessionId: string; policyRef: ArtifactRef;
  usageScopes: string[];
  /** Trusted identity resolution, not caller-supplied actor data. */
  actorFor(caller: unknown, mutation: boolean): ResearchAssetActor;
  /** Scope/withdrawal filtering occurs before readDependency. Null reveals no hidden metadata. */
  describeDependency(ref: ArtifactRef, actor: ResearchAssetActor): ResearchDependencyDescriptor | null;
  readDependency(ref: ArtifactRef, actor: ResearchAssetActor): Buffer;
  validateExecutionCapability?: (asset: ResearchAssetDraft) => void;
  observationReader?: PublishedResearchObservationReader;
}
interface StoredAsset { ref: ArtifactRef; asset: ResearchAssetRevision }
interface LinkedRevision {
  schemaVersion: 1; kind: ResearchLinkedKind; key: string; revision: number; previousRef: ArtifactRef | null;
  scope: ResearchAssetDraft['scope']; dependencyRefs: ArtifactRef[]; record: ResearchLinkedRecord;
}
interface StoredLink { ref: ArtifactRef; value: LinkedRevision }
interface AssetState {
  revision: number; assets: StoredAsset[];
  links: StoredLink[];
  commands: Array<{ commandId: string; requestHash: string; actor: ResearchAssetActor; receipt: ResearchCommandReceipt }>;
}
const same = (a: unknown, b: unknown) => canonicalJsonV1(a) === canonicalJsonV1(b);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export class ResearchAssetService {
  private readonly options: ResearchAssetServiceOptions;
  private readonly directory: string;
  private readonly journal: string;
  constructor(options: ResearchAssetServiceOptions) {
    this.options = { ...options, usageScopes: [...options.usageScopes], policyRef: expAssertArtifactRef(options.policyRef, 'policyRef') };
    this.directory = path.resolve(options.directory); this.journal = path.join(this.directory, 'asset-events.jsonl');
    fs.mkdirSync(path.join(this.directory, 'records'), { recursive: true });
    this.readState();
  }
  private actor(caller: unknown, mutation: boolean): ResearchAssetActor {
    const actor = this.options.actorFor(caller, mutation);
    if (actor.taskId !== this.options.taskId || !actor.usageScopes.length || actor.usageScopes.some((scope) => !this.options.usageScopes.includes(scope)) ||
        mutation && actor.sessionId !== this.options.ownerSessionId) throw new ExperimentError('OWNER_MISMATCH', 'Asset caller is outside pinned task, scope or owner');
    return actor;
  }
  private publish(value: unknown): ArtifactRef {
    const bytes = Buffer.from(canonicalJsonV1(value)), sha256 = sha(bytes), id = `records/${sha256}.json`;
    const file = path.join(this.directory, id);
    if (fs.existsSync(file)) {
      if (!fs.readFileSync(file).equals(bytes)) throw new ExperimentError('ARTIFACT_CORRUPT', 'Published asset bytes changed');
    } else fs.writeFileSync(file, bytes, { flag: 'wx' });
    return { id, sha256 };
  }
  private readState(): { state: AssetState; head: string | null } {
    let state: AssetState = { revision: 0, assets: [], links: [], commands: [] }, head: string | null = null;
    if (!fs.existsSync(this.journal)) return { state, head };
    const content = fs.readFileSync(this.journal, 'utf8');
    if (content && !content.endsWith('\n')) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Asset journal has incomplete event');
    for (const line of content.split('\n').filter(Boolean)) {
      const event = expNoExtraKeys(parseJsonStrictV1(line), ['schemaVersion', 'taskId', 'ownerSessionId', 'policyRef', 'previousHash', 'state', 'eventHash'], 'asset event');
      const { eventHash, ...body } = event;
      const next = expNoExtraKeys(event.state, ['revision', 'assets', 'links', 'commands'], 'asset state') as unknown as AssetState;
      if (event.schemaVersion !== 1 || event.taskId !== this.options.taskId || event.ownerSessionId !== this.options.ownerSessionId ||
          !same(event.policyRef, this.options.policyRef) || event.previousHash !== head || next.revision !== state.revision + 1 ||
          !Array.isArray(next.assets) || !Array.isArray(next.commands) || typedHash('research-asset-event-v1', body) !== eventHash) {
        throw new ExperimentError('RECONCILIATION_REQUIRED', 'Asset journal identity, revision or hash differs');
      }
      if (!Object.hasOwn(next, 'links')) next.links = [];
      if (!Array.isArray(next.links)) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Asset links journal is malformed');
      for (const stored of next.links) {
        expNoExtraKeys(stored, ['ref', 'value'], 'stored link');
        const ref = expAssertArtifactRef(stored.ref, 'link ref'), v = stored.value;
        expNoExtraKeys(v, ['schemaVersion', 'kind', 'key', 'revision', 'previousRef', 'scope', 'dependencyRefs', 'record'], 'linked revision');
        if (!Object.hasOwn(LINK_VALIDATORS, v.kind) || v.schemaVersion !== 1 || ref.id !== `records/${ref.sha256}.json` ||
            sha(fs.readFileSync(path.join(this.directory, ref.id))) !== ref.sha256 ||
            !same(parseJsonStrictV1(fs.readFileSync(path.join(this.directory, ref.id), 'utf8')), v)) throw new ExperimentError('ARTIFACT_CORRUPT', 'Linked record kind or bytes differ');
        LINK_VALIDATORS[v.kind](v.record); researchInteger(v.revision, 'link revision', 1); expAssertId(v.key, 'link key');
        if (v.previousRef !== null) expAssertArtifactRef(v.previousRef, 'link previousRef');
        if (!Array.isArray(v.dependencyRefs) || !v.scope?.taskIds.includes(this.options.taskId) || !v.scope.usageScopes.length) throw new ExperimentError('ARTIFACT_CORRUPT', 'Linked record dependencies or scope differ');
        v.dependencyRefs.forEach((dependency) => expAssertArtifactRef(dependency, 'link dependency'));
        if ((v.revision === 1) !== (v.previousRef === null) || v.revision > 1 && !next.links.some((previous) => previous.value.kind === v.kind &&
            previous.value.key === v.key && previous.value.revision === v.revision - 1 && same(previous.ref, v.previousRef))) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Link predecessor is missing');
      }
      const identities = new Set<string>();
      for (const stored of next.assets) {
        expNoExtraKeys(stored, ['ref', 'asset'], 'stored asset');
        const ref = expAssertArtifactRef(stored.ref, 'ref');
        const asset = validateResearchAssetRevision(stored.asset);
        const identity = `${asset.assetKey}:${asset.revision}`;
        if (identities.has(identity) || ref.id !== `records/${ref.sha256}.json` || !asset.scope.taskIds.includes(this.options.taskId) ||
            sha(fs.readFileSync(path.join(this.directory, ref.id))) !== ref.sha256 ||
            !same(parseJsonStrictV1(fs.readFileSync(path.join(this.directory, ref.id), 'utf8')), asset)) {
          throw new ExperimentError('ARTIFACT_CORRUPT', 'Stored asset bytes, scope or revision identity differs');
        }
        identities.add(identity);
        if (asset.revision > 1 && !next.assets.some((prior) => prior.asset.assetKey === asset.assetKey &&
            prior.asset.revision === asset.revision - 1 && same(prior.ref, asset.previousRef))) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Asset predecessor is missing');
      }
      state = next; head = eventHash as string;
    }
    return { state, head };
  }
  private inputRefs(asset: ResearchAssetDraft): ArtifactRef[] {
    return [...asset.sourceRefs, ...asset.wikiRefs, ...asset.dependencies, ...asset.claims.flatMap((claim) => claim.evidenceRefs),
      ...asset.positionBindings.map((binding) => binding.positionRef), ...(asset.capability.executableRef ? [asset.capability.executableRef] : [])];
  }
  private descriptor(ref: ArtifactRef, actor: ResearchAssetActor, state: AssetState, visited: Set<string>): ResearchDependencyDescriptor | null {
    const linked = state.links.find((entry) => same(entry.ref, ref));
    if (linked) {
      if (visited.has(ref.sha256)) throw new ExperimentError('ARTIFACT_CORRUPT', 'Linked dependency cycle');
      const status = this.visibilityRefs(linked.value.scope, linked.value.dependencyRefs, actor, state, new Set([...visited, ref.sha256]));
      return status === 'hidden' ? null : { kind: linked.value.kind, scope: linked.value.scope, status };
    }
    const stored = state.assets.find((entry) => same(entry.ref, ref));
    if (!stored) return this.options.describeDependency(ref, actor);
    if (visited.has(ref.sha256)) throw new ExperimentError('ARTIFACT_CORRUPT', 'Asset dependency cycle');
    const status = this.visibility(stored.asset, actor, state, new Set([...visited, ref.sha256]));
    return status === 'hidden' ? null : { kind: 'asset', scope: stored.asset.scope, status };
  }
  private visibility(asset: ResearchAssetDraft, actor: ResearchAssetActor, state: AssetState, visited = new Set<string>()): 'current' | 'stale' | 'hidden' {
    return this.visibilityRefs(asset.scope, this.inputRefs(asset), actor, state, visited);
  }
  private visibilityRefs(scope: ResearchAssetDraft['scope'], refs: ArtifactRef[], actor: ResearchAssetActor, state: AssetState, visited = new Set<string>()): 'current' | 'stale' | 'hidden' {
    if (!scope.taskIds.includes(actor.taskId) || !scope.usageScopes.some((scope) => actor.usageScopes.includes(scope))) return 'hidden';
    let stale = false;
    let scopes = scope.usageScopes.filter((entry) => actor.usageScopes.includes(entry));
    for (const ref of refs) {
      const descriptor = this.descriptor(ref, actor, state, visited);
      if (!descriptor || descriptor.status === 'revoked' || !descriptor.scope.taskIds.includes(actor.taskId) ||
          !descriptor.scope.usageScopes.some((scope) => actor.usageScopes.includes(scope))) return 'hidden';
      scopes = scopes.filter((scope) => descriptor.scope.usageScopes.includes(scope));
      if (!scopes.length) return 'hidden';
      if (descriptor.status === 'stale') stale = true;
    }
    return stale ? 'stale' : 'current';
  }
  private mutate<P>(caller: unknown, raw: unknown, validate: (payload: unknown) => P,
    change: (state: AssetState, actor: ResearchAssetActor, payload: P) => ArtifactRef[]): ResearchCommandReceipt {
    const actor = this.actor(caller, true);
    const command = validateResearchCommand(raw, validate);
    if (command.taskId !== this.options.taskId || !same(command.policyRef, this.options.policyRef) || command.budgetRef !== null) throw new ExperimentError('POLICY_DENIED', 'Asset command policy or task differs');
    const lockPath = path.join(this.directory, 'asset.lock');
    let lock: number;
    try { lock = fs.openSync(lockPath, 'wx'); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ExperimentError('RECONCILIATION_REQUIRED', 'Asset writer owner is uncertain');
      throw error;
    }
    try {
      const { state, head } = this.readState();
      const requestHash = typedHash('research-asset-command-v1', { command, actor });
      const replay = state.commands.find((entry) => entry.commandId === command.commandId);
      if (replay) {
        if (replay.requestHash !== requestHash) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Asset command replay differs');
        return copy(replay.receipt);
      }
      if (command.expectedRevision !== state.revision) throw new ExperimentError('REVISION_CONFLICT', 'Asset store revision changed');
      const resultRefs = change(state, actor, command.payload);
      state.revision++;
      const receipt: ResearchCommandReceipt = { schemaVersion: 1, status: 'succeeded', resultRefs, error: null,
        receipt: { operationId: `asset-${requestHash}`, commandId: command.commandId, requestHash, taskRevision: state.revision } };
      state.commands.push({ commandId: command.commandId, requestHash, actor, receipt });
      const body = { schemaVersion: 1, taskId: this.options.taskId, ownerSessionId: this.options.ownerSessionId, policyRef: this.options.policyRef, previousHash: head, state };
      const eventHash = typedHash('research-asset-event-v1', body), fd = fs.openSync(this.journal, 'a');
      try { fs.writeFileSync(fd, `${canonicalJsonV1({ ...body, eventHash })}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return copy(receipt);
    } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
  }
  registerAssetRevision(caller: unknown, raw: unknown): ResearchCommandReceipt {
    return this.mutate(caller, raw, (payload) => {
      const o = expNoExtraKeys(payload, ['asset', 'previousRef'], 'register asset');
      return { asset: validateResearchAssetDraft(o.asset), previousRef: o.previousRef === null ? null : expAssertArtifactRef(o.previousRef, 'previousRef') };
    }, (state, actor, payload) => {
      const draft = payload.asset;
      const latest = state.assets.filter((entry) => entry.asset.assetKey === draft.assetKey).at(-1);
      if (!same(latest?.ref ?? null, payload.previousRef)) throw new ExperimentError('REVISION_CONFLICT', 'Asset predecessor differs from latest revision');
      if (latest && latest.asset.kind !== draft.kind) throw new ExperimentError('INCOMPATIBLE_BINDING', 'Stable asset kind cannot change');
      let taskIds = draft.scope.taskIds.filter((taskId) => taskId === this.options.taskId);
      let usageScopes = draft.scope.usageScopes.filter((scope) => this.options.usageScopes.includes(scope) && actor.usageScopes.includes(scope));
      for (const ref of this.inputRefs(draft)) {
        const descriptor = this.descriptor(ref, actor, state, new Set());
        if (!descriptor || descriptor.status !== 'current') throw new ExperimentError('POLICY_DENIED', 'Asset dependency is hidden, withdrawn or stale');
        if (draft.sourceRefs.some((source) => same(source, ref)) && descriptor.kind !== 'source' ||
            draft.wikiRefs.some((wiki) => same(wiki, ref)) && descriptor.kind !== 'wiki') throw new ExperimentError('SOURCE_MISMATCH', 'Source/Wiki category differs from the authoritative dependency registry');
        taskIds = taskIds.filter((taskId) => descriptor.scope.taskIds.includes(taskId));
        usageScopes = usageScopes.filter((scope) => descriptor.scope.usageScopes.includes(scope));
        if (!taskIds.length || !usageScopes.length) throw new ExperimentError('POLICY_DENIED', 'Derived permission intersection is empty before reading dependency bytes');
        if (!state.assets.some((entry) => same(entry.ref, ref)) && !state.links.some((entry) => same(entry.ref, ref))) {
          if (sha(this.options.readDependency(ref, actor)) !== ref.sha256) throw new ExperimentError('ARTIFACT_CORRUPT', 'Dependency byte hash differs');
        }
      }
      if (!taskIds.length || !usageScopes.length) throw new ExperimentError('POLICY_DENIED', 'Derived permission intersection is empty');
      if (draft.capability.status === 'available') {
        if (!this.options.validateExecutionCapability) throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'No trusted runner capability validator mounted');
        this.options.validateExecutionCapability(draft);
      }
      const asset = validateResearchAssetRevision({ ...draft, scope: { taskIds, usageScopes }, schemaVersion: 1,
        revision: (latest?.asset.revision ?? 0) + 1, previousRef: latest?.ref ?? null });
      for (const binding of asset.positionBindings) {
        const position = state.links.find((entry) => entry.value.kind === 'position' && same(entry.ref, binding.positionRef));
        if (!position || !(position.value.record as ResearchPosition).allowedKinds.includes(asset.kind) ||
            (position.value.record as ResearchPosition).domain !== asset.applicability.domain) throw new ExperimentError('INCOMPATIBLE_BINDING', 'Asset type/domain differs from registered position');
      }
      const ref = this.publish(asset); state.assets.push({ ref, asset });
      return [ref];
    });
  }
  private registerLinked(caller: unknown, raw: unknown, kind: ResearchLinkedKind): ResearchCommandReceipt {
    return this.mutate(caller, raw, (payload) => {
      const o = expNoExtraKeys(payload, ['record', 'previousRef'], `register ${kind}`);
      return { record: LINK_VALIDATORS[kind](o.record) as ResearchLinkedRecord, previousRef: o.previousRef === null ? null : expAssertArtifactRef(o.previousRef, 'previousRef') };
    }, (state, actor, payload) => {
      const record = payload.record;
      let key: string, dependencyRefs: ArtifactRef[];
      if (kind === 'position') { key = (record as ResearchPosition).positionKey; dependencyRefs = []; }
      else if (kind === 'contribution') {
        const contribution = record as ResearchContribution; key = contribution.contributionKey;
        dependencyRefs = [contribution.sourceRef, contribution.locator.chunkRef, ...contribution.assetRefs, ...(contribution.wikiRef ? [contribution.wikiRef] : [])];
      } else if (kind === 'relation') {
        const relation = record as ResearchAssetRelation; key = relation.relationKey;
        dependencyRefs = [relation.sourceRef, relation.targetRef, relation.conditionsRef, ...relation.evidenceRefs];
      } else if (kind === 'process') {
        const node = record as ResearchProcessNode; key = node.nodeKey;
        dependencyRefs = [...node.parentRefs, ...node.assetRefs, ...node.observationRefs, ...(node.conditionsRef ? [node.conditionsRef] : [])];
      } else {
        const citation = record as ResearchCitation; key = citation.citationKey;
        dependencyRefs = [citation.contributionRef, citation.targetRef, citation.conditionsRef];
      }
      const latest = state.links.filter((entry) => entry.value.kind === kind && entry.value.key === key).at(-1);
      if (!same(latest?.ref ?? null, payload.previousRef)) throw new ExperimentError('REVISION_CONFLICT', 'Linked record predecessor differs');
      let usageScopes = actor.usageScopes.filter((scope) => this.options.usageScopes.includes(scope));
      for (const ref of dependencyRefs) {
        const descriptor = this.descriptor(ref, actor, state, new Set());
        if (!descriptor || descriptor.status !== 'current' || !descriptor.scope.taskIds.includes(actor.taskId)) throw new ExperimentError('POLICY_DENIED', 'Linked dependency is outside active source scope');
        usageScopes = usageScopes.filter((scope) => descriptor.scope.usageScopes.includes(scope));
        if (!usageScopes.length) throw new ExperimentError('POLICY_DENIED', 'Linked dependency scope intersection is empty');
        if (!state.assets.some((entry) => same(entry.ref, ref)) && !state.links.some((entry) => same(entry.ref, ref)) &&
            sha(this.options.readDependency(ref, actor)) !== ref.sha256) throw new ExperimentError('ARTIFACT_CORRUPT', 'Linked dependency bytes differ');
      }
      if (kind === 'contribution') {
        const contribution = record as ResearchContribution;
        const chunkDescriptor = this.descriptor(contribution.locator.chunkRef, actor, state, new Set());
        if (chunkDescriptor?.kind !== 'chunk') throw new ExperimentError('SOURCE_MISMATCH', 'Contribution requires a real source chunk locator');
        const chunk = parseJsonStrictV1(this.options.readDependency(contribution.locator.chunkRef, actor).toString('utf8')) as Record<string, unknown>;
        if (chunk.paperId !== contribution.paperId || !same(chunk.sourceRef, contribution.sourceRef) || chunk.rawByteStart !== contribution.locator.rawByteStart ||
            chunk.rawByteEndExclusive !== contribution.locator.rawByteEndExclusive || chunk.paragraphIndex !== contribution.locator.paragraphIndex) {
          throw new ExperimentError('SOURCE_MISMATCH', 'Contribution locator differs from actual source bytes');
        }
      }
      if (kind === 'citation') {
        const citation = record as ResearchCitation;
        if (!state.links.some((entry) => entry.value.kind === 'contribution' && same(entry.ref, citation.contributionRef))) throw new ExperimentError('SOURCE_MISMATCH', 'Citation requires registered contribution');
        const target = state.assets.find((entry) => same(entry.ref, citation.targetRef));
        if (!target || !['Experiment', 'Method'].includes(target.asset.kind)) throw new ExperimentError('INCOMPATIBLE_BINDING', 'Citation target must be experiment or method scheme');
      }
      if (kind === 'process') {
        const node = record as ResearchProcessNode;
        const parents = node.parentRefs.map((ref) => state.links.find((entry) => entry.value.kind === 'process' && same(entry.ref, ref)));
        const allowedParents = { problem: [], hypothesis: ['problem'], scheme: ['hypothesis'], experiment: ['scheme'], result: ['experiment'], decision: ['result'], conclusion: ['result', 'decision'] };
        if (parents.some((entry) => !entry || !(allowedParents[node.kind] as string[]).includes((entry.value.record as ResearchProcessNode).kind))) throw new ExperimentError('INCOMPATIBLE_BINDING', 'Research process edge does not follow problem/hypothesis/scheme/experiment/result/decision/conclusion semantics');
        if (node.assetRefs.some((ref) => !state.assets.some((entry) => same(entry.ref, ref)))) throw new ExperimentError('SOURCE_MISMATCH', 'Research process asset must be a registered revision');
        if (node.observationRefs.length) {
          if (!this.options.observationReader) throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Research process observation reader is unavailable');
          for (const ref of node.observationRefs) {
            const observation = this.options.observationReader.readObservation(caller, ref);
            if (observation.taskId !== actor.taskId || !same(observation.comparisonConditionsRef, node.conditionsRef) ||
                (node.nature === 'failure_diagnostic' ? observation.verification !== 'failed' : ['local_observation', 'inferred'].includes(node.nature) && observation.verification !== 'verified')) throw new ExperimentError('SOURCE_MISMATCH', 'Research statement differs from actual observation task/conditions/verification');
          }
        }
      }
      const value: LinkedRevision = { schemaVersion: 1, kind, key, revision: (latest?.value.revision ?? 0) + 1,
        previousRef: latest?.ref ?? null, scope: { taskIds: [this.options.taskId], usageScopes }, dependencyRefs, record };
      const ref = this.publish(value); state.links.push({ ref, value }); return [ref];
    });
  }
  registerPosition(caller: unknown, raw: unknown) { return this.registerLinked(caller, raw, 'position'); }
  registerContribution(caller: unknown, raw: unknown) { return this.registerLinked(caller, raw, 'contribution'); }
  registerAssetRelation(caller: unknown, raw: unknown) { return this.registerLinked(caller, raw, 'relation'); }
  attachCitation(caller: unknown, raw: unknown) { return this.registerLinked(caller, raw, 'citation'); }
  registerProcessNode(caller: unknown, raw: unknown) { return this.registerLinked(caller, raw, 'process'); }
  getLinkedRecord(caller: unknown, rawRef: unknown) {
    const actor = this.actor(caller, false), ref = expAssertArtifactRef(rawRef, 'linkedRef'), { state } = this.readState();
    const stored = state.links.find((entry) => same(entry.ref, ref)), descriptor = this.descriptor(ref, actor, state, new Set());
    if (!stored || !descriptor || descriptor.status === 'revoked') throw new ExperimentError('POLICY_DENIED', 'Linked record is not available');
    return { storeRevision: state.revision, ref: copy(ref), value: copy(stored.value), dependencyStatus: descriptor.status };
  }
  listLinkedRecords(caller: unknown, kind: ResearchLinkedKind) {
    if (!Object.hasOwn(LINK_VALIDATORS, kind)) throw new ExperimentError('SCHEMA_VIOLATION', 'Unknown linked record kind');
    const actor = this.actor(caller, false), { state } = this.readState(), latest = new Map<string, StoredLink>();
    state.links.filter((entry) => entry.value.kind === kind).forEach((entry) => latest.set(entry.value.key, entry));
    const records = [...latest.values()].flatMap((entry) => {
      const descriptor = this.descriptor(entry.ref, actor, state, new Set());
      return !descriptor || descriptor.status === 'revoked' ? [] : [{ ref: copy(entry.ref), value: copy(entry.value), dependencyStatus: descriptor.status }];
    });
    return { storeRevision: state.revision, total: records.length, records };
  }
  getAsset(caller: unknown, rawRef: unknown) {
    const actor = this.actor(caller, false), ref = expAssertArtifactRef(rawRef, 'assetRef'), { state } = this.readState();
    const stored = state.assets.find((entry) => same(entry.ref, ref));
    const status = stored ? this.visibility(stored.asset, actor, state) : 'hidden';
    if (!stored || status === 'hidden') throw new ExperimentError('POLICY_DENIED', 'Asset is not available in caller scope');
    return { storeRevision: state.revision, ref: copy(ref), asset: copy(stored.asset), dependencyStatus: status };
  }
  getCommandResult(caller: unknown, commandId: string): ResearchCommandReceipt | null {
    const actor = this.actor(caller, false); expAssertId(commandId, 'commandId');
    const { state } = this.readState(), entry = state.commands.find((command) => command.commandId === commandId);
    if (!entry) return null;
    if (!same(entry.actor, actor) || entry.receipt.resultRefs.some((ref) => !this.descriptor(ref, actor, state, new Set()))) throw new ExperimentError('POLICY_DENIED', 'Asset command result is not visible to the actual caller');
    return copy(entry.receipt);
  }
  describeResearchDependency(caller: unknown, ref: ArtifactRef): ResearchDependencyDescriptor | null {
    const actor = this.actor(caller, false), { state } = this.readState(); expAssertArtifactRef(ref, 'dependencyRef');
    if (!state.assets.some((entry) => same(entry.ref, ref)) && !state.links.some((entry) => same(entry.ref, ref))) return null;
    return this.descriptor(ref, actor, state, new Set());
  }
  readResearchDependency(caller: unknown, ref: ArtifactRef): Buffer {
    const descriptor = this.describeResearchDependency(caller, ref);
    if (!descriptor) throw new ExperimentError('POLICY_DENIED', 'Asset dependency is outside current visible research scope');
    const bytes = fs.readFileSync(path.join(this.directory, ref.id)); if (sha(bytes) !== ref.sha256) throw new ExperimentError('ARTIFACT_CORRUPT', 'Asset dependency bytes changed'); return bytes;
  }
  listAssets(caller: unknown, filters: { kind?: ResearchAssetKind } = {}) {
    const actor = this.actor(caller, false), { state } = this.readState();
    const latest = new Map<string, StoredAsset>(); state.assets.forEach((stored) => latest.set(stored.asset.assetKey, stored));
    const assets = [...latest.values()].filter((stored) => !filters.kind || stored.asset.kind === filters.kind).flatMap((stored) => {
      const status = this.visibility(stored.asset, actor, state);
      return status === 'hidden' ? [] : [{ ref: copy(stored.ref), asset: copy(stored.asset), dependencyStatus: status }];
    });
    return { storeRevision: state.revision, total: assets.length, assets };
  }
}
