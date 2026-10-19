/** Durable research delegation authority, separate from the DSH task/mailbox. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ExperimentError, expAssertArtifactRef, expAssertId, expNoExtraKeys,
  type ArtifactRef,
} from '../contracts/experiments.ts';
import {
  validateResearchCommand, researchInteger, type ResearchCommand, type ResearchCommandReceipt,
} from '../contracts/research-command.ts';
import {
  researchPathWithin, validateResearchRoleConfiguration, validateResearchDelegationGrant,
  type ResearchRoleConfiguration, type ResearchDelegationGrant,
} from '../contracts/team-research.ts';
import { canonicalJsonV1, parseJsonStrictV1, typedHash } from '../domain/research-canonical.ts';
import { validateResearchHandoffInput, type ResearchHandoffRecord } from '../contracts/research-handoff.ts';
import { validateReviewIssueInput, type ResearchReviewIssue, type ResearchRepairAttempt } from '../contracts/research-review.ts';
import { RootBudgetLedger } from './research-budget.ts';

export interface ResearchMemberIdentity {
  sessionId: string;
  rootSessionId: string;
  teamId: string;
  role: 'lead' | 'teammate';
  name: string;
}

export interface TeamResearchServiceOptions {
  directory: string;
  taskId: string;
  ownerSessionId: string;
  teamId: string;
  policyRef: ArtifactRef;
  budgetRef: ArtifactRef;
  readRoots: readonly string[];
  writeRoots: readonly string[];
  tools: ReadonlyMap<string, 'read' | 'write' | 'execute'>;
  /** Exact live Agent identity check, normally ctx.agentTeams.membership(agent). */
  identityFor: (caller: unknown) => ResearchMemberIdentity;
  /** Trusted published-ref resolver must scope-filter/revoke before reading bytes. */
  resolvePublished: (ref: ArtifactRef, taskId: string, usage: 'role_config' | 'role_prompt' | 'research_input') => Buffer;
  /** Trusted output verifier: checks published bytes, producer, task and kind. */
  verifyOutput?: (member: unknown, ref: ArtifactRef, kind: string) => void;
  rootLedger?: RootBudgetLedger;
  /** Actual Host status verifier; absence refuses member-cancellation completion. */
  verifyRuntimeStop?: (member: unknown, proof: { memberSessionId: string; memberName: string; lastStatus: 'inactive' | 'failed'; observedAt: string }) => void;
}

interface TeamState {
  revision: number;
  grants: ResearchDelegationGrant[];
  applications: Array<{ grantId: string; recordRef: ArtifactRef }>;
  handoffs: ResearchHandoffRecord[];
  issues: ResearchReviewIssue[];
  repairs: ResearchRepairAttempt[];
  commands: Array<{ commandId: string; requestHash: string; callerIdentity: ResearchMemberIdentity; receipt: ResearchCommandReceipt }>;
}

interface TeamEvent {
  schemaVersion: 1;
  taskId: string;
  ownerSessionId: string;
  teamId: string;
  policyRef: ArtifactRef;
  budgetRef: ArtifactRef;
  previousHash: string | null;
  state: TeamState;
  eventHash: string;
}

const same = (a: unknown, b: unknown): boolean => canonicalJsonV1(a) === canonicalJsonV1(b);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class TeamResearchService {
  private readonly options: TeamResearchServiceOptions;
  private readonly directory: string;
  private readonly eventPath: string;
  private readonly lockPath: string;

  constructor(options: TeamResearchServiceOptions) {
    this.options = {
      ...options,
      policyRef: expAssertArtifactRef(options.policyRef, 'policyRef'),
      budgetRef: expAssertArtifactRef(options.budgetRef, 'budgetRef'),
      readRoots: [...options.readRoots], writeRoots: [...options.writeRoots], tools: new Map(options.tools),
    };
    this.directory = path.resolve(options.directory);
    this.eventPath = path.join(this.directory, 'delegation-events.jsonl');
    this.lockPath = path.join(this.directory, 'delegation.lock');
    fs.mkdirSync(path.join(this.directory, 'records'), { recursive: true });
    // Opening an existing journal validates its bindings and hash chain.
    this.readState();
  }

  private identity(caller: unknown): ResearchMemberIdentity {
    const identity = this.options.identityFor(caller);
    if (identity.rootSessionId !== this.options.ownerSessionId || identity.teamId !== this.options.teamId) {
      throw new ExperimentError('OWNER_MISMATCH', 'Caller is not a member of this research Team');
    }
    return identity;
  }

  assertLead(caller: unknown): ResearchMemberIdentity {
    const identity = this.identity(caller);
    if (identity.role !== 'lead' || identity.sessionId !== this.options.ownerSessionId) {
      throw new ExperimentError('POLICY_DENIED', 'Only the actual Lead may issue research delegation');
    }
    return identity;
  }

  private readPublished(ref: ArtifactRef, usage: 'role_config' | 'role_prompt' | 'research_input'): Buffer {
    const bytes = this.options.resolvePublished(ref, this.options.taskId, usage);
    if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) {
      throw new ExperimentError('ARTIFACT_CORRUPT', `Published ${usage} bytes do not match their ref`);
    }
    return bytes;
  }

  prepareRole(caller: unknown, rawRef: unknown): { configuration: ResearchRoleConfiguration; prompt: string } {
    this.assertLead(caller);
    const ref = expAssertArtifactRef(rawRef, 'roleConfigurationRef');
    const configuration = validateResearchRoleConfiguration(parseJsonStrictV1(this.readPublished(ref, 'role_config').toString('utf8')));
    if (!same(configuration.policyRef, this.options.policyRef) || !configuration.allowedTaskIds.includes(this.options.taskId)) {
      throw new ExperimentError('POLICY_DENIED', 'Role configuration does not match the task policy');
    }
    for (const binding of configuration.tools) {
      if (this.options.tools.get(binding.name) !== binding.effect) {
        throw new ExperimentError('POLICY_DENIED', 'Role requested a tool/effect outside the trusted catalog');
      }
    }
    for (const [requested, admitted] of [
      [configuration.readRoots, this.options.readRoots], [configuration.writeRoots, this.options.writeRoots],
    ] as const) {
      if (requested.some((root) => !admitted.some((parent) => researchPathWithin(parent, root)))) {
        throw new ExperimentError('POLICY_DENIED', 'Role requested workspace roots outside the parent policy');
      }
    }
    const prompt = this.readPublished(configuration.systemPromptRef, 'role_prompt').toString('utf8');
    if (prompt.trim().length === 0) throw new ExperimentError('SCHEMA_VIOLATION', 'Role system prompt is empty');
    for (const input of configuration.allowedInputRefs) this.readPublished(input, 'research_input');
    return { configuration, prompt };
  }

  private readState(): { state: TeamState; head: string | null } {
    let state: TeamState = { revision: 0, grants: [], applications: [], handoffs: [], issues: [], repairs: [], commands: [] };
    let head: string | null = null;
    if (!fs.existsSync(this.eventPath)) return { state, head };
    const text = fs.readFileSync(this.eventPath, 'utf8');
    if (text && !text.endsWith('\n')) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Team journal has an incomplete event');
    for (const line of text.split('\n').filter(Boolean)) {
      const event = parseJsonStrictV1(line) as TeamEvent;
      const { eventHash, ...body } = event;
      if (event.schemaVersion !== 1 || event.taskId !== this.options.taskId ||
          event.ownerSessionId !== this.options.ownerSessionId || event.teamId !== this.options.teamId ||
          !same(event.policyRef, this.options.policyRef) || !same(event.budgetRef, this.options.budgetRef) ||
          event.previousHash !== head || event.state.revision !== state.revision + 1 ||
          typedHash('team-research-event-v1', body) !== eventHash) {
        throw new ExperimentError('RECONCILIATION_REQUIRED', 'Team journal binding, revision or hash chain mismatch');
      }
      event.state.grants = event.state.grants.map(validateResearchDelegationGrant);
      // Explicit compatibility migration for grant-only v1 journals.
      if (!Object.hasOwn(event.state, 'handoffs')) event.state.handoffs = [];
      if (!Object.hasOwn(event.state, 'issues')) event.state.issues = [];
      if (!Object.hasOwn(event.state, 'repairs')) event.state.repairs = [];
      if (!Array.isArray(event.state.issues) || !Array.isArray(event.state.repairs)) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Review journal arrays are malformed');
      const issueIds = new Set<string>(), repairIds = new Set<string>();
      for (const issue of event.state.issues) {
        expNoExtraKeys(issue, ['issueId', 'subjectRef', 'evidenceRefs', 'reproduction', 'repairRequirement', 'severity',
          'reviewerSessionId', 'status', 'repairIds', 'recheckRefs', 'firstErrorRef'], 'persisted issue');
        validateReviewIssueInput({ issueId: issue.issueId, subjectRef: issue.subjectRef, evidenceRefs: issue.evidenceRefs,
          reproduction: issue.reproduction, repairRequirement: issue.repairRequirement, severity: issue.severity });
        const reviewer = event.state.grants.find((grant) => grant.memberSessionId === issue.reviewerSessionId);
        if (issueIds.has(issue.issueId) || reviewer?.roleConfiguration.roleId !== 'reviewer' ||
            !['open', 'addressed', 'closed', 'unresolved'].includes(issue.status) || !Array.isArray(issue.repairIds) || !Array.isArray(issue.recheckRefs)) {
          throw new ExperimentError('RECONCILIATION_REQUIRED', 'Persisted issue role, status or identity differs');
        }
        issueIds.add(issue.issueId);
        expAssertArtifactRef(issue.firstErrorRef, 'firstErrorRef');
        issue.recheckRefs.forEach((ref) => expAssertArtifactRef(ref, 'recheckRef'));
      }
      for (const repair of event.state.repairs) {
        expNoExtraKeys(repair, ['repairId', 'issueId', 'engineerSessionId', 'grantId', 'oldSubjectRef', 'newSubjectRef',
          'status', 'diffRef', 'checkRefs', 'callRefs', 'chargeRef', 'firstErrorRef', 'failureDiagnosticRef'], 'persisted repair');
        if (!Object.hasOwn(repair, 'failureDiagnosticRef')) repair.failureDiagnosticRef = null;
        const issue = event.state.issues.find((entry) => entry.issueId === repair.issueId);
        const engineer = event.state.grants.find((grant) => grant.grantId === repair.grantId);
        if (repairIds.has(repair.repairId) || !issue || engineer?.roleConfiguration.roleId !== 'engineer' ||
            engineer.memberSessionId !== repair.engineerSessionId || !issue.repairIds.includes(repair.repairId) ||
            !same(repair.oldSubjectRef, issue.subjectRef) || !same(repair.firstErrorRef, issue.firstErrorRef) ||
            !['admitted', 'submitted', 'failed'].includes(repair.status) || !Array.isArray(repair.checkRefs) || !Array.isArray(repair.callRefs)) {
          throw new ExperimentError('RECONCILIATION_REQUIRED', 'Persisted repair differs from issue, member or admission');
        }
        repairIds.add(repair.repairId);
        expAssertArtifactRef(repair.chargeRef, 'chargeRef');
        repair.checkRefs.forEach((ref) => expAssertArtifactRef(ref, 'checkRef'));
        repair.callRefs.forEach((ref) => expAssertArtifactRef(ref, 'callRef'));
        if (repair.newSubjectRef !== null) expAssertArtifactRef(repair.newSubjectRef, 'newSubjectRef');
        if (repair.diffRef !== null) expAssertArtifactRef(repair.diffRef, 'diffRef');
        if (repair.failureDiagnosticRef !== null) expAssertArtifactRef(repair.failureDiagnosticRef, 'failureDiagnosticRef');
        if (repair.status === 'failed' && repair.failureDiagnosticRef === null) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Failed repair has no diagnosis');
        if (repair.status === 'submitted' && (!repair.newSubjectRef || !repair.diffRef || !repair.checkRefs.length ||
            repair.newSubjectRef.sha256 === repair.oldSubjectRef.sha256)) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Submitted repair lacks new checked output');
      }
      for (const grant of event.state.grants) {
        if (grant.taskId !== this.options.taskId || grant.teamId !== this.options.teamId ||
            grant.ownerSessionId !== this.options.ownerSessionId || !same(grant.policyRef, this.options.policyRef) ||
            !same(grant.budgetRef, this.options.budgetRef)) {
          throw new ExperimentError('RECONCILIATION_REQUIRED', 'Persisted grant crossed a task/owner/policy boundary');
        }
      }
      if (!Array.isArray(event.state.handoffs)) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Persisted handoffs must be an array');
      const handoffIds = new Set<string>();
      for (const record of event.state.handoffs) {
        expNoExtraKeys(record, ['handoffId', 'goal', 'dependencies', 'inputRefs', 'expectedOutputs', 'exitCriteria', 'deadlineAt',
          'fromSessionId', 'toSessionId', 'grantId', 'budgetRef', 'status', 'nativeAcceptanceRef', 'outputs', 'failure'], 'persisted handoff');
        validateResearchHandoffInput({ handoffId: record.handoffId, goal: record.goal, dependencies: record.dependencies,
          inputRefs: record.inputRefs, expectedOutputs: record.expectedOutputs, exitCriteria: record.exitCriteria, deadlineAt: record.deadlineAt });
        const grant = event.state.grants.find((entry) => entry.grantId === record.grantId);
        if (handoffIds.has(record.handoffId) || !grant || record.fromSessionId !== this.options.ownerSessionId ||
            record.toSessionId !== grant.memberSessionId || !same(record.budgetRef, this.options.budgetRef) ||
            !['prepared', 'accepted', 'completed', 'failed', 'cancelled'].includes(record.status) ||
            !Array.isArray(record.outputs) || record.failure !== null && typeof record.failure !== 'string' ||
            record.dependencies.some((id) => !event.state.handoffs.some((dependency) => dependency.handoffId === id && dependency.status === 'completed'))) {
          throw new ExperimentError('RECONCILIATION_REQUIRED', 'Persisted handoff binding, dependency or state mismatch');
        }
        handoffIds.add(record.handoffId);
        if (record.status === 'prepared' && record.nativeAcceptanceRef !== null ||
            ['accepted', 'completed'].includes(record.status) && record.nativeAcceptanceRef === null) {
          throw new ExperimentError('RECONCILIATION_REQUIRED', 'Persisted handoff lacks a valid native acceptance stage');
        }
        if (record.nativeAcceptanceRef !== null) expAssertArtifactRef(record.nativeAcceptanceRef, 'nativeAcceptanceRef');
        for (const output of record.outputs) {
          expNoExtraKeys(output, ['kind', 'ref'], 'persisted output');
          expAssertId(output.kind, 'output.kind'); expAssertArtifactRef(output.ref, 'output.ref');
        }
        if (record.status === 'completed' && (record.outputs.length !== record.expectedOutputs.length ||
            new Set(record.outputs.map((output) => output.kind)).size !== record.outputs.length ||
            record.outputs.some((output) => !record.expectedOutputs.includes(output.kind)))) {
          throw new ExperimentError('RECONCILIATION_REQUIRED', 'Persisted completion differs from expected output kinds');
        }
      }
      for (const command of event.state.commands) {
        for (const ref of command.receipt.resultRefs) {
          if (!/^records\/[0-9a-f]{64}\.json$/.test(ref.id) || ref.id !== `records/${ref.sha256}.json` ||
              createHash('sha256').update(fs.readFileSync(path.join(this.directory, ref.id))).digest('hex') !== ref.sha256) {
            throw new ExperimentError('ARTIFACT_CORRUPT', 'Committed Team record bytes or identity mismatch');
          }
        }
      }
      state = event.state;
      head = eventHash;
    }
    return { state, head };
  }

  private publish(value: unknown): ArtifactRef {
    const bytes = Buffer.from(canonicalJsonV1(value), 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const id = `records/${sha256}.json`;
    const file = path.join(this.directory, id);
    if (fs.existsSync(file)) {
      if (!fs.readFileSync(file).equals(bytes)) throw new ExperimentError('ARTIFACT_CORRUPT', 'Existing Team record differs');
    } else fs.writeFileSync(file, bytes, { flag: 'wx' });
    return { id, sha256 };
  }

  private mutate<P>(caller: unknown, command: ResearchCommand<P>, extraIdentity: unknown,
    change: (state: TeamState) => ArtifactRef[], memberCommand = false): ResearchCommandReceipt {
    const callerIdentity = memberCommand ? this.identity(caller) : this.assertLead(caller);
    if (memberCommand) this.authorize(caller);
    if (command.taskId !== this.options.taskId || !same(command.policyRef, this.options.policyRef) ||
        !same(command.budgetRef, this.options.budgetRef)) {
      throw new ExperimentError('POLICY_DENIED', 'Command differs from the pinned task/policy/budget');
    }
    let lock: number;
    try { lock = fs.openSync(this.lockPath, 'wx'); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ExperimentError('RECONCILIATION_REQUIRED', 'Team writer lock is occupied; do not erase an uncertain owner');
      }
      throw error;
    }
    try {
      const { state, head } = this.readState();
      const requestHash = typedHash('team-research-command-v1', { command, extraIdentity });
      const previous = state.commands.find((stored) => stored.commandId === command.commandId);
      if (previous) {
        if (!same(previous.callerIdentity, callerIdentity)) throw new ExperimentError('OWNER_MISMATCH', 'Command replay belongs to a different actual caller');
        if (previous.requestHash !== requestHash) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Command id reused with different content');
        return clone(previous.receipt);
      }
      if (state.revision !== command.expectedRevision) throw new ExperimentError('REVISION_CONFLICT', 'Team state revision changed');
      const resultRefs = change(state);
      state.revision += 1;
      const receipt: ResearchCommandReceipt = {
        schemaVersion: 1, status: 'succeeded', error: null, resultRefs,
        receipt: { operationId: `team-${requestHash}`, commandId: command.commandId, requestHash, taskRevision: state.revision },
      };
      state.commands.push({ commandId: command.commandId, requestHash, callerIdentity, receipt });
      const body = {
        schemaVersion: 1 as const, taskId: this.options.taskId, ownerSessionId: this.options.ownerSessionId,
        teamId: this.options.teamId, policyRef: this.options.policyRef, budgetRef: this.options.budgetRef,
        previousHash: head, state,
      };
      const event: TeamEvent = { ...body, eventHash: typedHash('team-research-event-v1', body) };
      const fd = fs.openSync(this.eventPath, 'a');
      try { fs.writeFileSync(fd, `${canonicalJsonV1(event)}\n`); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      return clone(receipt);
    } finally {
      fs.closeSync(lock);
      fs.unlinkSync(this.lockPath);
    }
  }

  delegate(lead: unknown, member: unknown, raw: unknown): ResearchCommandReceipt {
    const memberIdentity = this.identity(member);
    if (memberIdentity.role !== 'teammate') throw new ExperimentError('POLICY_DENIED', 'Delegation target must be an actual teammate');
    const command = validateResearchCommand(raw, (payload) => {
      const o = expNoExtraKeys(payload, ['roleConfigurationRef', 'expiresAt'], 'delegate.payload');
      return { roleConfigurationRef: expAssertArtifactRef(o.roleConfigurationRef, 'roleConfigurationRef'), expiresAt: expAssertId(o.expiresAt, 'expiresAt') };
    });
    return this.mutate(lead, command, memberIdentity, (state) => {
      if (state.grants.some((grant) => grant.memberSessionId === memberIdentity.sessionId)) {
        throw new ExperimentError('POLICY_DENIED', 'Member identity already has a grant; create a fresh member instead');
      }
      const { configuration } = this.prepareRole(lead, command.payload.roleConfigurationRef);
      const expiry = Date.parse(command.payload.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + configuration.limits.deadlineMs) {
        throw new ExperimentError('POLICY_DENIED', 'Grant expiry is outside the finite role deadline');
      }
      const grant = validateResearchDelegationGrant({
        schemaVersion: 1, grantId: `grant-${typedHash('research-grant-v1', { commandId: command.commandId, memberIdentity })}`,
        revision: 1, taskId: this.options.taskId, teamId: this.options.teamId, ownerSessionId: this.options.ownerSessionId,
        memberSessionId: memberIdentity.sessionId, memberName: memberIdentity.name,
        roleConfigurationRef: command.payload.roleConfigurationRef, roleConfiguration: configuration,
        policyRef: this.options.policyRef, budgetRef: this.options.budgetRef,
        expiresAt: command.payload.expiresAt, revoked: false,
      });
      state.grants.push(grant);
      return [this.publish(grant)];
    });
  }

  authorize(caller: unknown, toolName?: string): ResearchDelegationGrant {
    const identity = this.identity(caller);
    const grant = this.readState().state.grants.find((candidate) => candidate.memberSessionId === identity.sessionId);
    if (!grant || identity.role !== 'teammate' || identity.name !== grant.memberName || grant.revoked ||
        Date.now() >= Date.parse(grant.expiresAt)) throw new ExperimentError('POLICY_DENIED', 'Research grant is absent, expired or revoked');
    if (toolName !== undefined && !grant.roleConfiguration.tools.some((tool) => tool.name === toolName)) {
      throw new ExperimentError('POLICY_DENIED', 'Tool is outside the delegated Tool Set');
    }
    // Re-check revocation of sources/config on each operation, not just at spawn.
    this.prepareRoleForGrant(grant);
    return clone(grant);
  }

  private prepareRoleForGrant(grant: ResearchDelegationGrant): void {
    const bytes = this.readPublished(grant.roleConfigurationRef, 'role_config');
    if (!same(validateResearchRoleConfiguration(parseJsonStrictV1(bytes.toString('utf8'))), grant.roleConfiguration)) {
      throw new ExperimentError('ARTIFACT_CORRUPT', 'Grant role configuration does not match its published version');
    }
    this.readPublished(grant.roleConfiguration.systemPromptRef, 'role_prompt');
  }

  readInput(caller: unknown, rawRef: unknown): Buffer {
    const ref = expAssertArtifactRef(rawRef, 'inputRef');
    const grant = this.authorize(caller);
    if (!grant.roleConfiguration.allowedInputRefs.some((input) => same(input, ref))) {
      throw new ExperimentError('POLICY_DENIED', 'Input ref is outside the fresh member context');
    }
    return this.readPublished(ref, 'research_input');
  }

  revoke(lead: unknown, raw: unknown): ResearchCommandReceipt {
    const command = validateResearchCommand(raw, (payload) => {
      const o = expNoExtraKeys(payload, ['grantId'], 'revoke.payload');
      return { grantId: expAssertId(o.grantId, 'grantId') };
    });
    return this.mutate(lead, command, null, (state) => {
      const grant = state.grants.find((candidate) => candidate.grantId === command.payload.grantId);
      if (!grant) throw new ExperimentError('NOT_FOUND', 'Grant not found');
      grant.revoked = true;
      grant.revision += 1;
      return [this.publish(grant)];
    });
  }

  recordRoleApplication(lead: unknown, member: unknown, raw: unknown): ArtifactRef {
    this.assertLead(lead);
    const grant = this.authorize(member);
    const o = expNoExtraKeys(raw, [
      'memberSessionId', 'memberName', 'roleConfigurationRef', 'grantId', 'systemPromptSha256',
      'tools', 'readRoots', 'writeRoots', 'modelRoute', 'model', 'context', 'hook', 'evidenceKind',
    ], 'RoleApplication');
    if (o.memberSessionId !== grant.memberSessionId || o.memberName !== grant.memberName || o.grantId !== grant.grantId ||
        !same(o.roleConfigurationRef, grant.roleConfigurationRef) || o.systemPromptSha256 !== grant.roleConfiguration.systemPromptRef.sha256 ||
        !same(o.tools, grant.roleConfiguration.tools.map((tool) => tool.name)) || !same(o.readRoots, grant.roleConfiguration.readRoots) ||
        !same(o.writeRoots, grant.roleConfiguration.writeRoots) || o.modelRoute !== grant.roleConfiguration.modelRoute ||
        o.context !== 'fresh' || o.hook !== 'agent/created' || o.evidenceKind !== 'runtime-hook-installation') {
      throw new ExperimentError('SOURCE_MISMATCH', 'Role application differs from its delegated policy');
    }
    const model = expNoExtraKeys(o.model, ['provider', 'model'], 'RoleApplication.model');
    expAssertId(model.provider, 'model.provider');
    expAssertId(model.model, 'model.model');
    const state = this.readState().state;
    const existing = state.applications.find((application) => application.grantId === grant.grantId);
    if (existing) {
      const previous = parseJsonStrictV1(fs.readFileSync(path.join(this.directory, existing.recordRef.id), 'utf8'));
      if (!same(previous, o)) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Role application replay differs');
      return clone(existing.recordRef);
    }
    const result = this.mutate(lead, {
      schemaVersion: 1, commandId: `application-${grant.grantId}`, taskId: this.options.taskId,
      expectedRevision: state.revision, policyRef: this.options.policyRef, budgetRef: this.options.budgetRef, payload: o,
    }, { memberSessionId: grant.memberSessionId }, (next) => {
      if (next.applications.some((application) => application.grantId === grant.grantId)) {
        throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Role application already exists');
      }
      const recordRef = this.publish(o);
      next.applications.push({ grantId: grant.grantId, recordRef });
      return [recordRef];
    });
    return clone(result.resultRefs[0]);
  }

  prepareHandoff(lead: unknown, member: unknown, raw: unknown): ResearchCommandReceipt {
    const grant = this.authorize(member);
    const command = validateResearchCommand(raw, validateResearchHandoffInput);
    return this.mutate(lead, command, { targetSessionId: grant.memberSessionId }, (state) => {
      const input = command.payload;
      if (state.handoffs.some((record) => record.handoffId === input.handoffId)) {
        throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Handoff identity already exists');
      }
      for (const id of input.dependencies) {
        if (state.handoffs.find((record) => record.handoffId === id)?.status !== 'completed') {
          throw new ExperimentError('DEPENDENCY_NOT_READY', 'Research dependency has no validated completed outputs');
        }
      }
      if (Date.parse(input.deadlineAt) <= Date.now() || Date.parse(input.deadlineAt) > Date.parse(grant.expiresAt)) {
        throw new ExperimentError('POLICY_DENIED', 'Handoff deadline exceeds delegated authorization');
      }
      for (const ref of input.inputRefs) this.readInput(member, ref);
      const record: ResearchHandoffRecord = {
        ...input, fromSessionId: this.options.ownerSessionId, toSessionId: grant.memberSessionId,
        grantId: grant.grantId, budgetRef: this.options.budgetRef, status: 'prepared',
        nativeAcceptanceRef: null, outputs: [], failure: null,
      };
      state.handoffs.push(record);
      return [this.publish(record)];
    });
  }

  /** Only trusted Host adapter supplies the native task acceptance facts. */
  recordHandoffAcceptance(lead: unknown, member: unknown, raw: unknown): ResearchCommandReceipt {
    const grant = this.authorize(member);
    const command = validateResearchCommand(raw, (payload) => {
      const o = expNoExtraKeys(payload, ['handoffId', 'nativeTaskId', 'nativeTaskRevision', 'ownerSessionId'], 'acceptance');
      return { handoffId: expAssertId(o.handoffId, 'handoffId'), nativeTaskId: expAssertId(o.nativeTaskId, 'nativeTaskId'),
        nativeTaskRevision: researchInteger(o.nativeTaskRevision, 'nativeTaskRevision', 1), ownerSessionId: expAssertId(o.ownerSessionId, 'ownerSessionId') };
    });
    return this.mutate(lead, command, { targetSessionId: grant.memberSessionId }, (state) => {
      const record = state.handoffs.find((entry) => entry.handoffId === command.payload.handoffId);
      if (!record || record.toSessionId !== grant.memberSessionId || record.grantId !== grant.grantId || command.payload.ownerSessionId !== grant.memberSessionId) {
        throw new ExperimentError('OWNER_MISMATCH', 'Native task acceptance differs from delegated recipient');
      }
      if (record.status !== 'prepared') throw new ExperimentError('REVISION_CONFLICT', 'Handoff was already accepted or terminated');
      const nativeAcceptanceRef = this.publish(command.payload);
      record.status = 'accepted'; record.nativeAcceptanceRef = nativeAcceptanceRef;
      return [nativeAcceptanceRef, this.publish(record)];
    });
  }

  submitHandoffOutputs(member: unknown, raw: unknown): ResearchCommandReceipt {
    const grant = this.authorize(member);
    const command = validateResearchCommand(raw, (payload) => {
      const o = expNoExtraKeys(payload, ['handoffId', 'outputs'], 'handoff.outputs');
      if (!Array.isArray(o.outputs)) throw new ExperimentError('SCHEMA_VIOLATION', 'outputs must be an array');
      return { handoffId: expAssertId(o.handoffId, 'handoffId'), outputs: o.outputs.map((entry) => {
        const output = expNoExtraKeys(entry, ['kind', 'ref'], 'output');
        return { kind: expAssertId(output.kind, 'kind'), ref: expAssertArtifactRef(output.ref, 'ref') };
      }) };
    });
    return this.mutate(member, command, null, (state) => {
      const record = state.handoffs.find((entry) => entry.handoffId === command.payload.handoffId);
      if (!record || record.toSessionId !== grant.memberSessionId || record.grantId !== grant.grantId) {
        throw new ExperimentError('OWNER_MISMATCH', 'Output caller is not the delegated recipient');
      }
      if (record.status !== 'accepted') throw new ExperimentError('DEPENDENCY_NOT_READY', 'Output submitted before native task acceptance');
      if (Date.now() >= Date.parse(record.deadlineAt)) throw new ExperimentError('POLICY_DENIED', 'Handoff deadline passed');
      const outputs = command.payload.outputs;
      if (outputs.length !== record.expectedOutputs.length || new Set(outputs.map((entry) => entry.kind)).size !== outputs.length ||
          outputs.some((entry) => !record.expectedOutputs.includes(entry.kind))) throw new ExperimentError('INVALID_RESULT', 'Output kinds differ from declared exit contract');
      if (!this.options.verifyOutput) throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'No authoritative output verifier is mounted');
      outputs.forEach((entry) => this.options.verifyOutput!(member, entry.ref, entry.kind));
      record.status = 'completed'; record.outputs = outputs;
      return [this.publish(record)];
    }, true);
  }

  recordReview(reviewer: unknown, raw: unknown): ResearchCommandReceipt {
    const grant = this.authorize(reviewer);
    if (grant.roleConfiguration.roleId !== 'reviewer') throw new ExperimentError('POLICY_DENIED', 'Only Reviewer may create review issues');
    const command = validateResearchCommand(raw, validateReviewIssueInput);
    return this.mutate(reviewer, command, null, (state) => {
      if (state.issues.some((issue) => issue.issueId === command.payload.issueId)) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Review issue identity already exists');
      [command.payload.subjectRef, ...command.payload.evidenceRefs].forEach((ref) => this.readInput(reviewer, ref));
      const firstErrorRef = this.publish({ ...command.payload, reviewerSessionId: grant.memberSessionId });
      const issue: ResearchReviewIssue = { ...command.payload, reviewerSessionId: grant.memberSessionId,
        status: 'open', repairIds: [], recheckRefs: [], firstErrorRef };
      state.issues.push(issue);
      return [firstErrorRef, this.publish(issue)];
    }, true);
  }

  admitRepair(lead: unknown, engineer: unknown, raw: unknown): ResearchCommandReceipt {
    const grant = this.authorize(engineer);
    if (grant.roleConfiguration.roleId !== 'engineer') throw new ExperimentError('POLICY_DENIED', 'Repair requires an Engineer grant');
    const command = validateResearchCommand(raw, (payload) => {
      const o = expNoExtraKeys(payload, ['repairId', 'issueId'], 'repair admission');
      return { repairId: expAssertId(o.repairId, 'repairId'), issueId: expAssertId(o.issueId, 'issueId') };
    });
    return this.mutate(lead, command, { memberSessionId: grant.memberSessionId }, (state) => {
      const issue = state.issues.find((entry) => entry.issueId === command.payload.issueId);
      if (!issue || !['open', 'unresolved'].includes(issue.status)) throw new ExperimentError('DEPENDENCY_NOT_READY', 'Issue is not open for repair');
      if (state.repairs.some((entry) => entry.repairId === command.payload.repairId)) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Repair identity already exists');
      if (state.repairs.some((entry) => entry.issueId === issue.issueId && entry.status === 'admitted')) throw new ExperimentError('DEPENDENCY_NOT_READY', 'Issue already has a pending repair');
      [issue.subjectRef, ...issue.evidenceRefs].forEach((ref) => this.readInput(engineer, ref));
      if (!this.options.rootLedger) throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Repair requires the shared root budget ledger');
      const prefix = `team-repair-${grant.grantId}-`;
      const chargeId = `${prefix}${typedHash('team-repair-id-v1', command.payload.repairId)}`;
      const admissionRef = this.publish({ ...command.payload, grantId: grant.grantId, oldSubjectRef: issue.subjectRef, firstErrorRef: issue.firstErrorRef });
      const chargeHash = this.options.rootLedger.consumeRepair({ chargeId, evidenceRef: admissionRef,
        delegatedLimit: { chargePrefix: prefix, maxAttempts: grant.roleConfiguration.limits.maxRepairAttempts } });
      const chargeRef = this.publish({ chargeId, chargeHash, budgetRef: grant.budgetRef, admissionRef });
      const attempt: ResearchRepairAttempt = { ...command.payload, engineerSessionId: grant.memberSessionId, grantId: grant.grantId,
        oldSubjectRef: issue.subjectRef, newSubjectRef: null, status: 'admitted', diffRef: null, checkRefs: [], callRefs: [], chargeRef,
        firstErrorRef: issue.firstErrorRef, failureDiagnosticRef: null };
      state.repairs.push(attempt); issue.repairIds.push(attempt.repairId);
      return [admissionRef, chargeRef, this.publish(attempt), this.publish(issue)];
    });
  }

  submitRepair(engineer: unknown, raw: unknown): ResearchCommandReceipt {
    const grant = this.authorize(engineer);
    if (grant.roleConfiguration.roleId !== 'engineer') throw new ExperimentError('POLICY_DENIED', 'Only Engineer may submit repairs');
    const command = validateResearchCommand(raw, (payload) => {
      const o = expNoExtraKeys(payload, ['repairId', 'newSubjectRef', 'diffRef', 'checkRefs', 'callRefs'], 'repair submission');
      const refs = (value: unknown, field: string) => {
        if (!Array.isArray(value)) throw new ExperimentError('SCHEMA_VIOLATION', `${field} must be an array`);
        return value.map((ref) => expAssertArtifactRef(ref, field));
      };
      return { repairId: expAssertId(o.repairId, 'repairId'), newSubjectRef: expAssertArtifactRef(o.newSubjectRef, 'newSubjectRef'),
        diffRef: expAssertArtifactRef(o.diffRef, 'diffRef'), checkRefs: refs(o.checkRefs, 'checkRefs'), callRefs: refs(o.callRefs, 'callRefs') };
    });
    return this.mutate(engineer, command, null, (state) => {
      const attempt = state.repairs.find((entry) => entry.repairId === command.payload.repairId);
      if (!attempt || attempt.engineerSessionId !== grant.memberSessionId || attempt.grantId !== grant.grantId) throw new ExperimentError('OWNER_MISMATCH', 'Repair producer differs from admitted member');
      if (attempt.status !== 'admitted') throw new ExperimentError('REVISION_CONFLICT', 'Repair already submitted');
      if (!command.payload.checkRefs.length || command.payload.newSubjectRef.sha256 === attempt.oldSubjectRef.sha256) throw new ExperimentError('INVALID_RESULT', 'Repair requires new content and checks');
      if (!this.options.verifyOutput) throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Repair output verifier is unavailable');
      this.options.verifyOutput(engineer, command.payload.newSubjectRef, 'implementation');
      this.options.verifyOutput(engineer, command.payload.diffRef, 'diff');
      command.payload.checkRefs.forEach((ref) => this.options.verifyOutput!(engineer, ref, 'check'));
      command.payload.callRefs.forEach((ref) => this.options.verifyOutput!(engineer, ref, 'model_call'));
      Object.assign(attempt, command.payload, { status: 'submitted' });
      const issue = state.issues.find((entry) => entry.issueId === attempt.issueId)!;
      issue.status = 'addressed';
      return [this.publish(attempt), this.publish(issue)];
    }, true);
  }

  recheckReview(reviewer: unknown, raw: unknown): ResearchCommandReceipt {
    const grant = this.authorize(reviewer);
    if (grant.roleConfiguration.roleId !== 'reviewer') throw new ExperimentError('POLICY_DENIED', 'Only Reviewer may close issues');
    const command = validateResearchCommand(raw, (payload) => {
      const o = expNoExtraKeys(payload, ['issueId', 'repairId', 'recheckRef', 'resolved'], 'review recheck');
      if (typeof o.resolved !== 'boolean') throw new ExperimentError('SCHEMA_VIOLATION', 'resolved must be boolean');
      return { issueId: expAssertId(o.issueId, 'issueId'), repairId: expAssertId(o.repairId, 'repairId'),
        recheckRef: expAssertArtifactRef(o.recheckRef, 'recheckRef'), resolved: o.resolved };
    });
    return this.mutate(reviewer, command, null, (state) => {
      const issue = state.issues.find((entry) => entry.issueId === command.payload.issueId);
      const repair = state.repairs.find((entry) => entry.repairId === command.payload.repairId);
      if (!issue || !repair || repair.issueId !== issue.issueId || repair.status !== 'submitted' || issue.status !== 'addressed') {
        throw new ExperimentError('DEPENDENCY_NOT_READY', 'Review recheck requires the submitted repair');
      }
      [issue.subjectRef, ...issue.evidenceRefs, repair.newSubjectRef!, repair.diffRef!, ...repair.checkRefs].forEach((ref) => this.readInput(reviewer, ref));
      if (!this.options.verifyOutput) throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Recheck output verifier is unavailable');
      this.options.verifyOutput(reviewer, command.payload.recheckRef, 'review');
      issue.recheckRefs.push(command.payload.recheckRef); issue.status = command.payload.resolved ? 'closed' : 'unresolved';
      return [this.publish(issue)];
    }, true);
  }

  failRepair(engineer: unknown, raw: unknown): ResearchCommandReceipt {
    const grant = this.authorize(engineer);
    if (grant.roleConfiguration.roleId !== 'engineer') throw new ExperimentError('POLICY_DENIED', 'Repair failure must come from assigned Engineer');
    const command = validateResearchCommand(raw, (payload) => {
      const o = expNoExtraKeys(payload, ['repairId', 'diagnosticRef'], 'repair failure');
      return { repairId: expAssertId(o.repairId, 'repairId'), diagnosticRef: expAssertArtifactRef(o.diagnosticRef, 'diagnosticRef') };
    });
    return this.mutate(engineer, command, null, (state) => {
      const repair = state.repairs.find((entry) => entry.repairId === command.payload.repairId);
      if (!repair || repair.engineerSessionId !== grant.memberSessionId || repair.grantId !== grant.grantId) throw new ExperimentError('OWNER_MISMATCH', 'Failure is not from admitted repair producer');
      if (repair.status !== 'admitted') throw new ExperimentError('REVISION_CONFLICT', 'Repair already terminated');
      if (!this.options.verifyOutput) throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Diagnosis verifier is unavailable');
      this.options.verifyOutput(engineer, command.payload.diagnosticRef, 'failure_diagnostic');
      repair.status = 'failed'; repair.failureDiagnosticRef = command.payload.diagnosticRef;
      const issue = state.issues.find((entry) => entry.issueId === repair.issueId)!;
      issue.status = 'unresolved';
      return [this.publish(repair), this.publish(issue)];
    }, true);
  }

  failHandoff(member: unknown, raw: unknown): ResearchCommandReceipt {
    const grant = this.authorize(member);
    const command = validateResearchCommand(raw, (payload) => {
      const o = expNoExtraKeys(payload, ['handoffId', 'diagnosticRef', 'reason'], 'handoff failure');
      return { handoffId: expAssertId(o.handoffId, 'handoffId'), diagnosticRef: expAssertArtifactRef(o.diagnosticRef, 'diagnosticRef'), reason: expAssertId(o.reason, 'reason') };
    });
    return this.mutate(member, command, null, (state) => {
      const handoff = state.handoffs.find((entry) => entry.handoffId === command.payload.handoffId);
      if (!handoff || handoff.toSessionId !== grant.memberSessionId || handoff.grantId !== grant.grantId) throw new ExperimentError('OWNER_MISMATCH', 'Handoff failure is from a different member');
      if (handoff.status !== 'accepted') throw new ExperimentError('REVISION_CONFLICT', 'Handoff was not accepted or already terminated');
      if (!this.options.verifyOutput) throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Diagnosis verifier is unavailable');
      this.options.verifyOutput(member, command.payload.diagnosticRef, 'failure_diagnostic');
      handoff.status = 'failed'; handoff.failure = command.payload.reason;
      handoff.outputs = [{ kind: 'failure_diagnostic', ref: command.payload.diagnosticRef }];
      return [this.publish(handoff)];
    }, true);
  }

  summarizeTeam(lead: unknown) {
    this.assertLead(lead);
    const before = this.getTeamResearch(lead);
    const budget = this.options.rootLedger?.snapshot() ?? null;
    const after = this.getTeamResearch(lead);
    const counts = { completed: 0, failed: 0, cancelled: 0, running: 0, notRun: 0 };
    for (const handoff of after.handoffs) {
      if (handoff.status === 'prepared') counts.notRun++;
      else if (handoff.status === 'accepted') counts.running++;
      else counts[handoff.status]++;
    }
    return {
      schemaVersion: 1, taskId: this.options.taskId,
      consistency: { atomic: false, status: before.revision === after.revision ? 'sampled_stable' : 'stale',
        teamRevisionBefore: before.revision, teamRevisionAfter: after.revision, budgetLedgerHash: budget?.ledgerHash ?? null },
      counts, openIssues: after.issues.filter((issue) => issue.status !== 'closed'), repairs: after.repairs,
      handoffs: after.handoffs, budget,
      blockers: after.grants.filter((grant) => grant.revoked || Date.now() >= Date.parse(grant.expiresAt)).map((grant) =>
        ({ memberSessionId: grant.memberSessionId, reason: grant.revoked ? 'grant_revoked' : 'grant_expired' })),
      capabilities: { budgetQuery: budget ? 'available' : 'unavailable', hostRuntimeStatus: 'not_run', integratedStatus: 'not_run' },
    };
  }

  hasRuntimeStopVerifier(): boolean { return typeof this.options.verifyRuntimeStop === 'function'; }
  getRuntimeTerminationReceipt(lead: unknown, commandId: string, memberName: string): ResearchCommandReceipt | null {
    this.assertLead(lead); expAssertId(commandId, 'commandId');
    const old = this.readState().state.commands.find((entry) => entry.commandId === commandId);
    if (!old) return null;
    const ref = old.receipt.resultRefs[0];
    if (!ref) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Command is not a member termination');
    const bytes = fs.readFileSync(path.join(this.directory, ref.id));
    if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new ExperimentError('ARTIFACT_CORRUPT', 'Termination receipt publication changed');
    const proof = parseJsonStrictV1(bytes.toString('utf8')) as Record<string, unknown>;
    if (proof.evidenceKind !== 'observed_host_status_after_interrupt' || proof.memberName !== memberName || proof.taskId !== this.options.taskId) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Termination command was reused for another target');
    return clone(old.receipt);
  }
  recordRuntimeTermination(lead: unknown, member: unknown, raw: unknown): ResearchCommandReceipt {
    this.assertLead(lead); const actual = this.identity(member);
    const command = validateResearchCommand(raw, (payload) => {
      const p = expNoExtraKeys(payload, ['grantId', 'memberSessionId', 'memberName', 'lastStatus', 'observedAt'], 'runtime stop proof');
      if (!['inactive', 'failed'].includes(String(p.lastStatus)) || typeof p.observedAt !== 'string' || !Number.isFinite(Date.parse(p.observedAt))) throw new ExperimentError('SCHEMA_VIOLATION', 'Runtime termination needs observed terminal status and timestamp');
      return { grantId: expAssertId(p.grantId, 'grantId'), memberSessionId: expAssertId(p.memberSessionId, 'memberSessionId'), memberName: expAssertId(p.memberName, 'memberName'), lastStatus: p.lastStatus as 'inactive' | 'failed', observedAt: p.observedAt };
    });
    if (!this.options.verifyRuntimeStop) throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Actual Host stop verifier is unavailable');
    return this.mutate(lead, command, actual, (state) => {
      const proof = command.payload, grant = state.grants.find((entry) => entry.grantId === proof.grantId);
      if (!grant?.revoked || proof.memberSessionId !== actual.sessionId || proof.memberName !== actual.name || grant.memberSessionId !== actual.sessionId) throw new ExperimentError('POLICY_DENIED', 'Member stop proof is not bound to the revoked grant');
      this.options.verifyRuntimeStop!(member, proof);
      const stopRef = this.publish({ schemaVersion: 1, taskId: this.options.taskId, ...proof, evidenceKind: 'observed_host_status_after_interrupt' });
      const refs = [stopRef];
      for (const handoff of state.handoffs.filter((entry) => entry.grantId === grant.grantId && ['prepared', 'accepted'].includes(entry.status))) {
        handoff.status = 'cancelled'; handoff.failure = 'Actual Host member stopped after grant revocation'; handoff.outputs = [{ kind: 'cancellation_fact', ref: stopRef }]; refs.push(this.publish(handoff));
      }
      return refs;
    });
  }

  getTeamResearch(caller: unknown): { revision: number; grants: ResearchDelegationGrant[]; applications: unknown[]; handoffs: ResearchHandoffRecord[];
    issues: ResearchReviewIssue[]; repairs: ResearchRepairAttempt[] } {
    const identity = this.identity(caller);
    const state = this.readState().state;
    if (identity.role === 'lead') this.assertLead(caller);
    else this.authorize(caller);
    const visible = identity.role === 'lead' ? state.grants : state.grants.filter((grant) => grant.memberSessionId === identity.sessionId);
    const ids = new Set(visible.map((grant) => grant.grantId));
    const canRead = (refs: ArtifactRef[]) => identity.role === 'lead' || refs.every((ref) => visible.some((grant) =>
      grant.roleConfiguration.allowedInputRefs.some((allowed) => same(ref, allowed))));
    const visibleIssues = state.issues.filter((issue) => canRead([issue.subjectRef, ...issue.evidenceRefs, ...issue.recheckRefs]));
    const issueIds = new Set(visibleIssues.map((issue) => issue.issueId));
    return {
      revision: state.revision, grants: clone(visible),
      handoffs: clone(state.handoffs.filter((record) => identity.role === 'lead' || record.toSessionId === identity.sessionId)),
      issues: clone(visibleIssues),
      repairs: clone(state.repairs.filter((repair) => issueIds.has(repair.issueId) && (identity.role === 'lead' ||
        repair.engineerSessionId === identity.sessionId || canRead([repair.newSubjectRef ?? repair.oldSubjectRef, ...(repair.diffRef ? [repair.diffRef] : []),
          ...repair.checkRefs, ...repair.callRefs])))),
      applications: state.applications.filter((application) => ids.has(application.grantId)).map((application) =>
        ({ recordRef: application.recordRef, record: parseJsonStrictV1(fs.readFileSync(path.join(this.directory, application.recordRef.id), 'utf8')) })),
    };
  }
}
