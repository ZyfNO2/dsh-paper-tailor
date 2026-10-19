import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ExperimentError, expAssertArtifactRef, expAssertId, expNoExtraKeys, type ArtifactRef } from '../contracts/experiments.ts';
import { validateResearchCommand, type ResearchCommandReceipt } from '../contracts/research-command.ts';
import { validateResearchObservation, type ResearchObservation } from '../contracts/research-observation.ts';
import { canonicalJsonV1, parseJsonStrictV1, typedHash } from '../domain/research-canonical.ts';
import { KnowledgeService, type KnowledgeActor, type WikiClaim } from './knowledge-service.ts';
import { PublishedResearchObservationReader } from './research-observation-reader.ts';

interface WritebackRecord {
  schemaVersion: 1; commandId: string; requestHash: string; observationIdentity: string; observationRef: ArtifactRef;
  observation: ResearchObservation; bundleRef: ArtifactRef; wikiRef: ArtifactRef | null; assetRefs: ArtifactRef[];
  stage: 'bundle_published' | 'wiki_published' | 'completed'; receipt: ResearchCommandReceipt | null;
  wikiInput: { pageId: string; evidencePackRef: ArtifactRef; baseRevisionRef: ArtifactRef | null };
  wikiCommandId?: string;
  inheritedClaims?: Array<Omit<WikiClaim, 'state'>>;
}
export class ResearchWritebackService {
  private readonly options: {
    directory: string; taskId: string; ownerSessionId: string; policyRef: ArtifactRef; knowledge: KnowledgeService;
    reader: PublishedResearchObservationReader; actorFor(caller: unknown): KnowledgeActor;
    /** CAS/idempotent asset relationship publication, keyed by observation identity. */
    publishAssetLinks(caller: unknown, observation: ResearchObservation, bundleRef: ArtifactRef, wikiRef: ArtifactRef, identity: string): ArtifactRef[];
  };
  private readonly directory: string;
  constructor(options: ResearchWritebackService['options']) {
    this.options = options; this.directory = path.resolve(options.directory);
    fs.mkdirSync(path.join(this.directory, 'records'), { recursive: true }); fs.mkdirSync(path.join(this.directory, 'operations'), { recursive: true });
  }
  private publish(value: unknown): ArtifactRef {
    const bytes = Buffer.from(canonicalJsonV1(value)), sha256 = createHash('sha256').update(bytes).digest('hex'), id = `records/${sha256}.json`;
    const file = path.join(this.directory, id);
    if (fs.existsSync(file)) { if (!fs.readFileSync(file).equals(bytes)) throw new ExperimentError('ARTIFACT_CORRUPT', 'Writeback bundle bytes changed'); }
    else fs.writeFileSync(file, bytes, { flag: 'wx' });
    return { id, sha256 };
  }
  private save(file: string, record: WritebackRecord): void {
    const temporary = `${file}.pending`;
    const fd = fs.openSync(temporary, 'wx');
    try { fs.writeFileSync(fd, canonicalJsonV1(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  }
  writebackExperiment(caller: unknown, raw: unknown): ResearchCommandReceipt {
    const actor = this.options.actorFor(caller);
    if (actor.taskId !== this.options.taskId || actor.sessionId !== this.options.ownerSessionId) throw new ExperimentError('OWNER_MISMATCH', 'Writeback owner differs');
    const command = validateResearchCommand(raw, (payload) => {
      const o = expNoExtraKeys(payload, ['observationRef', 'pageId', 'evidencePackRef', 'baseRevisionRef'], 'writeback');
      return { observationRef: expAssertArtifactRef(o.observationRef, 'observationRef'), pageId: expAssertId(o.pageId, 'pageId'),
        evidencePackRef: expAssertArtifactRef(o.evidencePackRef, 'evidencePackRef'), baseRevisionRef: o.baseRevisionRef === null ? null : expAssertArtifactRef(o.baseRevisionRef, 'baseRevisionRef') };
    });
    if (command.taskId !== actor.taskId || command.budgetRef !== null || canonicalJsonV1(command.policyRef) !== canonicalJsonV1(this.options.policyRef)) throw new ExperimentError('POLICY_DENIED', 'Writeback task or policy differs');
    const observation = this.options.reader.readObservation(caller, command.payload.observationRef);
    if (observation.taskId !== actor.taskId) throw new ExperimentError('POLICY_DENIED', 'Observation is from another task');
    const identity = typedHash('research-observation-identity-v1', { taskId: observation.taskId, experimentId: observation.experimentId, attemptId: observation.attemptId,
      configRef: observation.configRef, protocolRef: observation.protocolRef, rawResultRefs: observation.rawResultRefs });
    const requestHash = typedHash('research-writeback-command-v1', { command, actor });
    const file = path.join(this.directory, 'operations', `${identity}.json`), lockPath = path.join(this.directory, 'writeback.lock');
    let lock: number;
    try { lock = fs.openSync(lockPath, 'wx'); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ExperimentError('RECONCILIATION_REQUIRED', 'Writeback owner is uncertain');
      throw error;
    }
    try {
      for (const name of fs.readdirSync(path.join(this.directory, 'operations')).filter((name) => /^[0-9a-f]{64}\.json$/.test(name))) {
        const old = parseJsonStrictV1(fs.readFileSync(path.join(this.directory, 'operations', name), 'utf8')) as unknown as WritebackRecord;
        if (old.commandId === command.commandId && old.requestHash !== requestHash) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Writeback command identity was reused across observations');
      }
      let record: WritebackRecord;
      if (fs.existsSync(file)) {
        record = parseJsonStrictV1(fs.readFileSync(file, 'utf8')) as unknown as WritebackRecord;
        if (record.observationIdentity !== identity || canonicalJsonV1(record.observation) !== canonicalJsonV1(observation)) throw new ExperimentError('ARTIFACT_CORRUPT', 'Writeback operation differs from observation');
        if (record.commandId !== command.commandId || record.requestHash !== requestHash) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Observation already belongs to another writeback envelope');
        if (record.receipt) return record.receipt;
      } else {
        if (command.expectedRevision !== 0) throw new ExperimentError('REVISION_CONFLICT', 'New observation writeback requires revision zero');
        const bundleRef = this.publish({ schemaVersion: 1, observationIdentity: identity, observationRef: command.payload.observationRef, observation });
        record = { schemaVersion: 1, commandId: command.commandId, requestHash, observationIdentity: identity, observationRef: command.payload.observationRef,
          observation, bundleRef, wikiRef: null, assetRefs: [], stage: 'bundle_published', receipt: null,
          wikiInput: { pageId: command.payload.pageId, evidencePackRef: command.payload.evidencePackRef, baseRevisionRef: command.payload.baseRevisionRef } };
        this.save(file, record);
      }
      if (record.stage === 'bundle_published') {
        const text = `${observation.experimentId}/${observation.attemptId}: ${observation.nature}. ` +
          (observation.verification === 'verified' ? observation.metrics.map((metric) => `${metric.metricId}=${metric.value} ${metric.unit} (${metric.split}, seed ${metric.seed})`).join('; ') : 'Execution is partial or failed; this diagnosis does not establish performance.');
        const claim = observation.verification === 'verified'
          ? { id: `obs-${identity}`, kind: 'local_observation', text, evidenceRefs: [], conditionsRef: observation.comparisonConditionsRef, verifiedResultRef: record.bundleRef }
          : { id: `diag-${identity}`, kind: 'execution_diagnostic', text, evidenceRefs: [], conditionsRef: observation.comparisonConditionsRef, diagnosticRef: record.bundleRef };
        const wiki = this.options.knowledge.updateWiki(record.wikiCommandId ?? `wb-${identity}`, actor, { pageId: record.wikiInput.pageId, pageType: 'experiment', title: `Experiment ${observation.experimentId}`,
          baseRevisionRef: record.wikiInput.baseRevisionRef, evidencePackRef: record.wikiInput.evidencePackRef, claims: [...(record.inheritedClaims ?? []), claim] });
        record.wikiRef = wiki.ref; record.stage = 'wiki_published'; this.save(file, record);
      }
      if (record.stage === 'wiki_published') {
        record.assetRefs = this.options.publishAssetLinks(caller, observation, record.bundleRef, record.wikiRef!, identity);
        record.assetRefs.forEach((ref) => expAssertArtifactRef(ref, 'writeback assetRef'));
        if (!record.assetRefs.length) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Writeback did not publish any research asset links');
        record.stage = 'completed';
        record.receipt = { schemaVersion: 1, status: 'succeeded', error: null, resultRefs: [record.bundleRef, record.wikiRef!, ...record.assetRefs],
          receipt: { operationId: identity, commandId: command.commandId, requestHash, taskRevision: 1 } };
        this.save(file, record);
      }
      if (!record.receipt) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Writeback stage is not completed');
      return record.receipt;
    } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
  }
  /** Explicit CAS recovery: pin the current Wiki revision; preserve its claims and the original envelope. */
  rebaseWiki(caller: unknown, operationId: string, snapshotRef: ArtifactRef, expectedWikiRef: ArtifactRef): void {
    const record = this.getWriteback(caller, operationId), actor = this.options.actorFor(caller);
    const lockPath = path.join(this.directory, 'writeback.lock');
    let lock: number;
    try { lock = fs.openSync(lockPath, 'wx'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ExperimentError('RECONCILIATION_REQUIRED', 'Writeback recovery owner is uncertain');
      throw error;
    }
    try {
      const current = this.getWriteback(caller, operationId);
      if (canonicalJsonV1(current) !== canonicalJsonV1(record) || record.stage !== 'bundle_published') throw new ExperimentError('REVISION_CONFLICT', 'Only unchanged pending Wiki publication can be rebased');
      const committed = this.options.knowledge.getWikiUpdateResult(record.wikiCommandId ?? `wb-${operationId}`, actor);
      if (committed) { record.wikiRef = committed.ref; record.stage = 'wiki_published'; }
      else {
        const wiki = this.options.knowledge.getWiki(record.wikiInput.pageId, snapshotRef, actor);
        if (canonicalJsonV1(wiki.revision.ref) !== canonicalJsonV1(expectedWikiRef) || canonicalJsonV1(wiki.revision.evidencePackRef) !== canonicalJsonV1(record.wikiInput.evidencePackRef)) throw new ExperimentError('REVISION_CONFLICT', 'Wiki revision or evidence pack changed during recovery');
        record.wikiInput.baseRevisionRef = wiki.revision.ref;
        record.inheritedClaims = wiki.revision.claims.map(({ state: _state, ...claim }) => claim);
        record.wikiCommandId = `wb-${operationId}-${expectedWikiRef.sha256.slice(0, 12)}`;
      }
      this.save(path.join(this.directory, 'operations', `${operationId}.json`), record);
    } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
  }

  /** Used by existing Wiki verifier callbacks; re-verifies raw evidence, never returns unconditional true. */
  verifyWikiBundle(caller: unknown, bundleRef: ArtifactRef, conditionsRef: ArtifactRef, nature: 'observation' | 'diagnostic'): boolean {
    const actor = this.options.actorFor(caller);
    if (actor.taskId !== this.options.taskId || actor.sessionId !== this.options.ownerSessionId) throw new ExperimentError('OWNER_MISMATCH', 'Wiki observation verifier owner differs');
    if (bundleRef.id !== `records/${bundleRef.sha256}.json`) throw new ExperimentError('ARTIFACT_CORRUPT', 'Invalid writeback bundle identity');
    const bytes = fs.readFileSync(path.join(this.directory, bundleRef.id));
    if (createHash('sha256').update(bytes).digest('hex') !== bundleRef.sha256) throw new ExperimentError('ARTIFACT_CORRUPT', 'Writeback bundle changed');
    const bundle = parseJsonStrictV1(bytes.toString('utf8')) as Record<string, unknown>, observation = validateResearchObservation(bundle.observation);
    this.options.reader.verifyObservation(caller, observation);
    return observation.taskId === this.options.taskId && canonicalJsonV1(observation.comparisonConditionsRef) === canonicalJsonV1(conditionsRef) &&
      (nature === 'observation' ? observation.verification === 'verified' : observation.verification !== 'verified');
  }
  getWriteback(caller: unknown, operationId: string): WritebackRecord {
    const actor = this.options.actorFor(caller);
    if (actor.taskId !== this.options.taskId || actor.sessionId !== this.options.ownerSessionId) throw new ExperimentError('OWNER_MISMATCH', 'Writeback query owner differs');
    if (!/^[0-9a-f]{64}$/.test(operationId)) throw new ExperimentError('SCHEMA_VIOLATION', 'Writeback operation ID must be a typed hash');
    const record = parseJsonStrictV1(fs.readFileSync(path.join(this.directory, 'operations', `${operationId}.json`), 'utf8')) as unknown as WritebackRecord;
    this.options.reader.verifyObservation(caller, validateResearchObservation(record.observation));
    if (record.observationIdentity !== operationId) throw new ExperimentError('ARTIFACT_CORRUPT', 'Writeback identity changed');
    return record;
  }
  readBundle(caller: unknown, ref: ArtifactRef): Buffer {
    const actor = this.options.actorFor(caller);
    if (actor.taskId !== this.options.taskId || actor.sessionId !== this.options.ownerSessionId) throw new ExperimentError('OWNER_MISMATCH', 'Bundle query owner differs');
    expAssertArtifactRef(ref, 'bundleRef');
    if (ref.id !== `records/${ref.sha256}.json`) throw new ExperimentError('POLICY_DENIED', 'Bundle path is outside the publication registry');
    const bytes = fs.readFileSync(path.join(this.directory, ref.id));
    if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new ExperimentError('ARTIFACT_CORRUPT', 'Bundle bytes changed');
    const bundle = parseJsonStrictV1(bytes.toString('utf8')) as Record<string, unknown>;
    this.options.reader.verifyObservation(caller, validateResearchObservation(bundle.observation));
    return bytes;
  }
}
