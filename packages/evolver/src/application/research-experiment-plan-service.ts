import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ExperimentError, expAssertArtifactRef, expAssertId, expNoExtraKeys, type ArtifactRef } from '../contracts/experiments.ts';
import { validateResearchCommand, type ResearchCommandReceipt } from '../contracts/research-command.ts';
import { validateParameterValue } from '../contracts/research-assets.ts';
import { canonicalJsonV1, parseJsonStrictV1, typedHash } from '../domain/research-canonical.ts';
import { ResearchAssetService } from './research-asset-service.ts';

export interface ResearchExperimentPlan {
  schemaVersion: 1; taskId: string; planKey: string; schemeRef: ArtifactRef;
  components: Array<{ assetRef: ArtifactRef; parameters: Record<string, string | number | boolean> }>;
  configRef: ArtifactRef; protocolRef: ArtifactRef; conditionsRef: ArtifactRef; sourceRefs: ArtifactRef[];
  applicabilityDomain: string; runnerId: string; constraints: { device: string; maxTrials: number; timeoutMs: number; testAccess: 'forbidden' };
  status: 'ready' | 'needs_revision' | 'unsupported'; missingChecks: Array<{ code: string; message: string; fieldPaths: string[] }>;
}
interface PlanEvent { schemaVersion: 1; taskId: string; ownerSessionId: string; previousHash: string | null; revision: number;
  commandId: string; requestHash: string; planRef: ArtifactRef; eventHash: string }
export class ResearchExperimentPlanService {
  private readonly options: { directory: string; taskId: string; ownerSessionId: string; policyRef: ArtifactRef; budgetRef: ArtifactRef; assets: ResearchAssetService;
    actorFor(caller: unknown, mutation: boolean): { sessionId: string; taskId: string };
    /** Checks current task/usage/license policy before opening and hashes original bytes. */
    assertDependency(caller: unknown, ref: ArtifactRef, purpose: 'experiment'): void;
    /** Concrete registered runner/profile compatibility check. Null means capability is unavailable. */
    checkRunner: null | ((caller: unknown, plan: Omit<ResearchExperimentPlan, 'status' | 'missingChecks'>) => void);
  };
  constructor(options: ResearchExperimentPlanService['options']) { this.options = options; fs.mkdirSync(path.join(options.directory, 'records'), { recursive: true }); }
  private authorize(caller: unknown, mutation: boolean): void {
    const actor = this.options.actorFor(caller, mutation);
    if (actor.taskId !== this.options.taskId || mutation && actor.sessionId !== this.options.ownerSessionId) throw new ExperimentError('OWNER_MISMATCH', 'Experiment plan caller differs from pinned owner/task');
  }
  private events(): PlanEvent[] {
    const file = path.join(this.options.directory, 'plan-events.jsonl'); if (!fs.existsSync(file)) return [];
    const bytes = fs.readFileSync(file, 'utf8'); if (bytes && !bytes.endsWith('\n')) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Plan journal has an unfinished record');
    let head: string | null = null; const events: PlanEvent[] = [];
    for (const line of bytes.split('\n').filter(Boolean)) {
      const event = expNoExtraKeys(parseJsonStrictV1(line), ['schemaVersion', 'taskId', 'ownerSessionId', 'previousHash', 'revision', 'commandId', 'requestHash', 'planRef', 'eventHash'], 'plan event') as unknown as PlanEvent;
      const { eventHash, ...body } = event;
      if (event.schemaVersion !== 1 || event.taskId !== this.options.taskId || event.ownerSessionId !== this.options.ownerSessionId || event.previousHash !== head || event.revision !== events.length + 1 || typedHash('research-experiment-plan-event-v1', body) !== eventHash) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Plan journal identity/hash differs');
      expAssertArtifactRef(event.planRef, 'planRef'); events.push(event); head = eventHash;
    }
    return events;
  }
  createExperimentPlan(caller: unknown, raw: unknown): ResearchCommandReceipt {
    this.authorize(caller, true);
    const command = validateResearchCommand(raw, (payload) => {
      const p = expNoExtraKeys(payload, ['planKey', 'schemeRef', 'components', 'configRef', 'protocolRef', 'conditionsRef', 'sourceRefs', 'applicabilityDomain', 'runnerId', 'constraints'], 'plan input');
      const constraints = expNoExtraKeys(p.constraints, ['device', 'maxTrials', 'timeoutMs', 'testAccess'], 'constraints');
      if (constraints.testAccess !== 'forbidden' || !Number.isSafeInteger(constraints.maxTrials) || (constraints.maxTrials as number) < 1 || !Number.isSafeInteger(constraints.timeoutMs) || (constraints.timeoutMs as number) < 1 || !Array.isArray(p.components) || !p.components.length || !Array.isArray(p.sourceRefs)) throw new ExperimentError('SCHEMA_VIOLATION', 'Plan requires finite trials/time, components and forbidden test access');
      const components = p.components.map((entry) => {
        const c = expNoExtraKeys(entry, ['assetRef', 'parameters'], 'component');
        if (!c.parameters || typeof c.parameters !== 'object' || Array.isArray(c.parameters)) throw new ExperimentError('SCHEMA_VIOLATION', 'Component parameters require an object');
        const parameters = expNoExtraKeys(c.parameters, Object.keys(c.parameters), 'parameters');
        for (const [key, value] of Object.entries(parameters)) if (!key.trim() || !['string', 'boolean', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw new ExperimentError('SCHEMA_VIOLATION', 'Component parameters require finite scalars');
        return { assetRef: expAssertArtifactRef(c.assetRef, 'assetRef'), parameters: parameters as Record<string, string | number | boolean> };
      });
      if (new Set(components.map((entry) => entry.assetRef.id)).size !== components.length) throw new ExperimentError('SCHEMA_VIOLATION', 'Plan repeats a component');
      return { schemaVersion: 1 as const, taskId: commandTask(raw), planKey: expAssertId(p.planKey, 'planKey'), schemeRef: expAssertArtifactRef(p.schemeRef, 'schemeRef'), components,
        configRef: expAssertArtifactRef(p.configRef, 'configRef'), protocolRef: expAssertArtifactRef(p.protocolRef, 'protocolRef'), conditionsRef: expAssertArtifactRef(p.conditionsRef, 'conditionsRef'), sourceRefs: p.sourceRefs.map((ref) => expAssertArtifactRef(ref, 'sourceRef')),
        applicabilityDomain: expAssertId(p.applicabilityDomain, 'applicabilityDomain'), runnerId: expAssertId(p.runnerId, 'runnerId'), constraints: { device: expAssertId(constraints.device, 'device'), maxTrials: constraints.maxTrials as number, timeoutMs: constraints.timeoutMs as number, testAccess: 'forbidden' as const } };
    });
    if (command.taskId !== this.options.taskId || canonicalJsonV1(command.policyRef) !== canonicalJsonV1(this.options.policyRef) || canonicalJsonV1(command.budgetRef) !== canonicalJsonV1(this.options.budgetRef)) throw new ExperimentError('POLICY_DENIED', 'Plan command policy/task/budget differs');
    const requestHash = typedHash('research-experiment-plan-command-v1', command), lockPath = path.join(this.options.directory, 'plans.lock');
    let lock: number; try { lock = fs.openSync(lockPath, 'wx'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ExperimentError('RECONCILIATION_REQUIRED', 'Plan writer lease is uncertain'); throw error; }
    try {
      const events = this.events(), replay = events.find((entry) => entry.commandId === command.commandId);
      if (replay) { if (replay.requestHash !== requestHash) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Plan replay payload differs'); this.getExperimentPlan(caller, replay.planRef); return this.receipt(replay); }
      if (command.expectedRevision !== events.length) throw new ExperimentError('REVISION_CONFLICT', 'Plan store revision changed');
      const missingChecks: ResearchExperimentPlan['missingChecks'] = [], draft = command.payload;
      const scheme = this.options.assets.getAsset(caller, draft.schemeRef);
      if (scheme.asset.kind !== 'Method') throw new ExperimentError('INCOMPATIBLE_BINDING', 'Scheme requires Method asset');
      for (const component of draft.components) {
        const view = this.options.assets.getAsset(caller, component.assetRef), asset = view.asset;
        if (asset.kind === 'Experiment') throw new ExperimentError('INCOMPATIBLE_BINDING', 'An observation asset cannot be used as an executable research component');
        if (view.dependencyStatus !== 'current' || asset.applicability.domain !== draft.applicabilityDomain) missingChecks.push({ code: 'INCOMPATIBLE_BINDING', message: `${asset.assetKey} is stale or outside applicability domain`, fieldPaths: ['components'] });
        for (const key of Object.keys(component.parameters)) if (!asset.parameterSchema.some((parameter) => parameter.key === key)) throw new ExperimentError('INCOMPATIBLE_BINDING', `Unknown parameter ${key}`);
        for (const parameter of asset.parameterSchema) {
          const value = component.parameters[parameter.key] ?? parameter.defaultValue;
          if (value === null) { if (parameter.required) missingChecks.push({ code: 'CONFIG_INCOMPLETE', message: `Missing ${asset.assetKey}.${parameter.key}`, fieldPaths: ['components.parameters'] }); }
          else { component.parameters[parameter.key] = validateParameterValue(parameter, value); }
        }
        if (asset.capability.status !== 'available' || asset.capability.runnerId !== draft.runnerId) missingChecks.push({ code: 'UNSUPPORTED_CAPABILITY', message: `${asset.assetKey}: ${asset.capability.reason ?? 'Runner binding unavailable'}`, fieldPaths: ['runnerId'] });
      }
      for (const ref of [draft.configRef, draft.protocolRef, draft.conditionsRef, ...draft.sourceRefs]) this.options.assertDependency(caller, ref, 'experiment');
      if (scheme.dependencyStatus !== 'current') missingChecks.push({ code: 'SOURCE_MISMATCH', message: 'Scheme dependency is stale', fieldPaths: ['schemeRef'] });
      if (!this.options.checkRunner) missingChecks.push({ code: 'UNSUPPORTED_CAPABILITY', message: 'No registered execution profile checker installed', fieldPaths: ['runnerId'] });
      else this.options.checkRunner(caller, draft);
      const plan: ResearchExperimentPlan = { ...draft, status: missingChecks.some((check) => check.code === 'UNSUPPORTED_CAPABILITY') ? 'unsupported' : missingChecks.length ? 'needs_revision' : 'ready', missingChecks };
      const bytes = Buffer.from(canonicalJsonV1(plan)), sha256 = createHash('sha256').update(bytes).digest('hex'), planRef = { id: `records/${sha256}.json`, sha256 }, file = path.join(this.options.directory, planRef.id);
      if (fs.existsSync(file)) { if (!fs.readFileSync(file).equals(bytes)) throw new ExperimentError('ARTIFACT_CORRUPT', 'Plan publication changed'); } else fs.writeFileSync(file, bytes, { flag: 'wx' });
      const body = { schemaVersion: 1 as const, taskId: this.options.taskId, ownerSessionId: this.options.ownerSessionId, previousHash: events.at(-1)?.eventHash ?? null, revision: events.length + 1, commandId: command.commandId, requestHash, planRef };
      const event = { ...body, eventHash: typedHash('research-experiment-plan-event-v1', body) }, fd = fs.openSync(path.join(this.options.directory, 'plan-events.jsonl'), 'a');
      try { fs.writeFileSync(fd, `${canonicalJsonV1(event)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return this.receipt(event);
    } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
  }
  private receipt(event: PlanEvent): ResearchCommandReceipt { return { schemaVersion: 1, status: 'succeeded', error: null, resultRefs: [event.planRef], receipt: { operationId: `plan-${event.requestHash}`, commandId: event.commandId, requestHash: event.requestHash, taskRevision: event.revision } }; }
  getExperimentPlan(caller: unknown, rawRef: unknown): ResearchExperimentPlan {
    this.authorize(caller, false); const ref = expAssertArtifactRef(rawRef, 'planRef');
    if (!this.events().some((entry) => canonicalJsonV1(entry.planRef) === canonicalJsonV1(ref)) || ref.id !== `records/${ref.sha256}.json`) throw new ExperimentError('POLICY_DENIED', 'Plan is outside registered task publication');
    const bytes = fs.readFileSync(path.join(this.options.directory, ref.id)); if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new ExperimentError('ARTIFACT_CORRUPT', 'Plan bytes changed');
    const plan = parseJsonStrictV1(bytes.toString('utf8')) as unknown as ResearchExperimentPlan;
    if (plan.taskId !== this.options.taskId) throw new ExperimentError('POLICY_DENIED', 'Plan task differs');
    this.options.assets.getAsset(caller, plan.schemeRef); plan.components.forEach((component) => this.options.assets.getAsset(caller, component.assetRef));
    [plan.configRef, plan.protocolRef, plan.conditionsRef, ...plan.sourceRefs].forEach((ref) => this.options.assertDependency(caller, ref, 'experiment'));
    return plan;
  }
  listExperimentPlans(caller: unknown) { this.authorize(caller, false); const events = this.events(); return { revision: events.length, plans: events.map((event) => ({ ref: event.planRef, plan: this.getExperimentPlan(caller, event.planRef) })) }; }
  assertExecutablePlan(caller: unknown, ref: ArtifactRef): ResearchExperimentPlan {
    this.authorize(caller, true); const plan = this.getExperimentPlan(caller, ref);
    if (plan.status !== 'ready' || !this.options.checkRunner) throw new ExperimentError('UNSUPPORTED_CAPABILITY', `Plan is ${plan.status}: ${plan.missingChecks.map((check) => check.message).join('; ')}`);
    if (this.options.assets.getAsset(caller, plan.schemeRef).dependencyStatus !== 'current') throw new ExperimentError('SOURCE_MISMATCH', 'Scheme source no longer matches the frozen ready plan');
    for (const component of plan.components) {
      const view = this.options.assets.getAsset(caller, component.assetRef);
      if (view.dependencyStatus !== 'current' || view.asset.capability.status !== 'available' || view.asset.capability.runnerId !== plan.runnerId) throw new ExperimentError('SOURCE_MISMATCH', 'Component capability/source no longer matches the frozen ready plan');
    }
    this.options.checkRunner(caller, plan); return plan;
  }
}
function commandTask(raw: unknown): string { return expAssertId((raw as Record<string, unknown>).taskId, 'taskId'); }
