/**
 * Opt-in DSH member-scope installation. Mirrors the verified source APIs, not
 * spawn.prompt pseudo-system reminders. No production plugin is auto-mounted.
 */
import { ExperimentError, type ArtifactRef } from '../../contracts/experiments.ts';
import { type ResearchRoleConfiguration } from '../../contracts/team-research.ts';
import { TeamResearchService } from '../../application/team-research-service.ts';
import { ResearchWorkspace } from '../../application/research-workspace.ts';
import { createHash } from 'node:crypto';

type Dispose = () => void;
interface PendingExecution { name: string; arguments: unknown; agent?: ResearchAgent }
interface PromptAssembly { sections: unknown[]; contexts: unknown[]; tools: Array<{ name: string }>; variables: Record<string, string | undefined> }

export interface ResearchAgent {
  id: string;
  ctx: {
    tools: {
      guard(check: (execution: PendingExecution) => string | undefined): Dispose;
      restrict(filter: { allow: readonly string[] }): Dispose;
      presentAs(mode: 'native'): Dispose;
      register(definition: unknown): Dispose;
    };
    systemPrompt: { section(section: { name: string; order: number; text: string; complete: true; interpolate: false }): Dispose };
    on(name: string, listener: (...args: any[]) => unknown, options?: { prepend: boolean }): Dispose;
  };
}

export interface ResearchTeamHost {
  agents: { get(id: string): ResearchAgent | undefined };
  agentTeams: {
    membership(agent: ResearchAgent): { root: ResearchAgent; id: string; role: 'lead' | 'teammate'; name: string };
    tryMembership(agent: ResearchAgent): { root: ResearchAgent; id: string; role: 'lead' | 'teammate'; name: string } | undefined;
    listMembers(agent: ResearchAgent): Array<{ id: string; name: string; role: string; context?: string; provider?: string; status?: string }>;
    waitForChange?(caller: ResearchAgent, timeoutMs: number, signal: AbortSignal): Promise<unknown>;
    spawnTeammate(lead: ResearchAgent, request: {
      name: string; description: string; prompt: Array<{ type: 'text'; text: string }>;
      context: 'fresh'; provider: string; signal: AbortSignal;
    }): Promise<{ member: { id: string; name: string } }>;
    interrupt(lead: ResearchAgent, targetName: string): { previousStatus: string };
  };
  tools: { guard(check: (execution: PendingExecution) => string | undefined): Dispose };
  on(name: string, listener: (...args: any[]) => unknown): Dispose;
}

export interface ResearchMemberAccess {
  member: ResearchAgent;
  configuration: ResearchRoleConfiguration;
  workspace: ResearchWorkspace;
  authorize(caller: unknown, toolName: string): void;
  readInput(caller: unknown, ref: ArtifactRef): Buffer;
}

export interface TrustedResearchTool {
  effect: 'read' | 'write' | 'execute';
  /** Concrete tool definitions are built per member so their closures are isolated. */
  create(access: ResearchMemberAccess): unknown;
}

export interface RoleApplicationReceipt {
  memberSessionId: string;
  memberName: string;
  roleConfigurationRef: ArtifactRef;
  grantId: string;
  systemPromptSha256: string;
  tools: string[];
  readRoots: string[];
  writeRoots: string[];
  model: { provider: string; model: string };
  modelRoute: string;
  context: 'fresh';
  hook: 'agent/created';
  /** This becomes live evidence only with actual Host session/call events. */
  evidenceKind: 'runtime-hook-installation';
  recordRef: ArtifactRef;
}

interface PendingRole {
  commandId: string;
  expectedRevision: number;
  roleConfigurationRef: ArtifactRef;
  configuration: ResearchRoleConfiguration;
  prompt: string;
  expiresAt: string;
  application: RoleApplicationReceipt | null;
}

export class DshResearchTeamRuntime {
  private readonly host: ResearchTeamHost;
  private readonly lead: ResearchAgent;
  private readonly service: TeamResearchService;
  private readonly options: {
    taskId: string; policyRef: ArtifactRef; budgetRef: ArtifactRef; freshProvider: string;
    modelRoutes: ReadonlyMap<string, { provider: string; model: string }>;
    tools: ReadonlyMap<string, TrustedResearchTool>; maxFileBytes: number;
    installBudgetedModel(member: ResearchAgent, upstream: { provider: string; model: string }, signal: AbortSignal): { provider: string; model: string; dispose(): void };
  };
  private readonly disposers: Dispose[] = [];
  private readonly memberDisposers = new Map<ResearchAgent, Dispose[]>();
  private readonly pending = new Map<string, PendingRole>();
  private disposed = false;
  private readonly lifecycle = new AbortController();

  constructor(
    host: ResearchTeamHost,
    lead: ResearchAgent,
    service: TeamResearchService,
    options: {
      taskId: string; policyRef: ArtifactRef; budgetRef: ArtifactRef; freshProvider: string;
      modelRoutes: ReadonlyMap<string, { provider: string; model: string }>;
      tools: ReadonlyMap<string, TrustedResearchTool>; maxFileBytes: number;
      installBudgetedModel(member: ResearchAgent, upstream: { provider: string; model: string }, signal: AbortSignal): { provider: string; model: string; dispose(): void };
    },
  ) {
    this.host = host;
    this.lead = lead;
    this.service = service;
    service.assertLead(lead);
    this.options = {
      ...options,
      modelRoutes: new Map([...options.modelRoutes].map(([name, route]) => [name, { ...route }])),
      tools: new Map(options.tools),
    };
    if (typeof options.installBudgetedModel !== 'function' ||
        [lead.ctx.tools?.guard, lead.ctx.tools?.restrict, lead.ctx.tools?.presentAs, lead.ctx.tools?.register, lead.ctx.systemPrompt?.section, lead.ctx.on].some((hook) => typeof hook !== 'function') ||
        typeof host.tools?.guard !== 'function' || typeof host.on !== 'function' ||
        typeof host.agentTeams?.spawnTeammate !== 'function' || typeof host.agentTeams?.tryMembership !== 'function') {
      throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Host lacks member lifecycle or monotonic tool guards');
    }
    if (host.agentTeams.listMembers(lead).some((member) => member.role === 'teammate')) {
      throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Research runtime requires a fresh Team; prior member context cannot be adopted');
    }
    this.disposers.push(host.tools.guard((execution) => {
      if (!execution.agent) return undefined;
      const member = host.agentTeams.tryMembership(execution.agent);
      if (!member || member.root !== lead || member.role !== 'teammate') return undefined;
      try {
        if (!this.memberDisposers.has(execution.agent)) return 'Research member has no applied role';
        service.authorize(execution.agent, execution.name);
        return undefined;
      } catch (error: unknown) { return error instanceof Error ? error.message : String(error); }
    }));
    this.disposers.push(host.on('agent/created', ({ agent }: { agent: ResearchAgent }) => {
      const membership = host.agentTeams.tryMembership(agent);
      if (!membership || membership.root !== lead || membership.role !== 'teammate') return;
      const pending = this.pending.get(membership.name);
      if (!pending) throw new ExperimentError('POLICY_DENIED', 'Member was created without an admitted research role');
      this.install(agent, pending);
    }));
    this.disposers.push(host.on('agent/disposed', ({ agent }: { agent: ResearchAgent }) => {
      this.disposeMember(agent);
    }));
  }

  private disposeMember(member: ResearchAgent): void {
    const disposers = this.memberDisposers.get(member);
    this.memberDisposers.delete(member);
    if (disposers) for (const dispose of disposers.reverse()) dispose();
  }

  private install(member: ResearchAgent, pending: PendingRole): void {
    const ctx = member.ctx;
    for (const method of [ctx.tools?.guard, ctx.tools?.restrict, ctx.tools?.presentAs, ctx.tools?.register, ctx.systemPrompt?.section, ctx.on]) {
      if (typeof method !== 'function') throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Member scope lacks role enforcement hooks');
    }
    const actual = this.host.agentTeams.listMembers(this.lead).find((candidate) => candidate.id === member.id);
    if (actual?.context !== 'fresh' || actual.provider !== this.options.freshProvider) {
      throw new ExperimentError('POLICY_DENIED', 'Member provider/context differs from admitted fresh spawn');
    }
    const upstream = this.options.modelRoutes.get(pending.configuration.modelRoute);
    if (!upstream) throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Role model route has no trusted provider/model mapping');
    const receipt = this.service.delegate(this.lead, member, {
      schemaVersion: 1, commandId: pending.commandId, taskId: this.options.taskId,
      expectedRevision: pending.expectedRevision, policyRef: this.options.policyRef, budgetRef: this.options.budgetRef,
      payload: { roleConfigurationRef: pending.roleConfigurationRef, expiresAt: pending.expiresAt },
    });
    const grant = this.service.authorize(member);
    const configuration = grant.roleConfiguration;
    const assertMember = (caller: unknown): void => {
      if (this.disposed || caller !== member || this.host.agents.get(member.id) !== member) {
        throw new ExperimentError('OWNER_MISMATCH', 'Tool call did not carry the exact live member');
      }
      this.service.authorize(caller);
    };
    const authorize = (caller: unknown, toolName: string): void => {
      assertMember(caller);
      this.service.authorize(caller, toolName);
    };
    const workspace = new ResearchWorkspace({
      readRoots: configuration.readRoots, writeRoots: configuration.writeRoots, maxFileBytes: this.options.maxFileBytes,
      authorize: (effect) => {
        assertMember(member);
        const current = this.service.authorize(member);
        if (effect === 'write' && current.roleConfiguration.roleId !== 'engineer') {
          throw new ExperimentError('POLICY_DENIED', 'Only delegated Engineer may modify its workspace');
        }
      },
    });
    const access: ResearchMemberAccess = {
      member, configuration, workspace, authorize,
      readInput: (caller, ref) => { authorize(caller, 'evolver_research_read_input'); return this.service.readInput(caller, ref); },
    };
    const disposers: Dispose[] = [];
    try {
      const model = this.options.installBudgetedModel(member, upstream, this.lifecycle.signal);
      disposers.push(() => model.dispose());
      if (!model.provider || model.model !== upstream.model) throw new ExperimentError('POLICY_DENIED', 'Budgeted model installer changed the configured role model');
      // Empty inherited surface; scope-local Team tools are additionally denied by guard.
      disposers.push(ctx.tools.restrict({ allow: [] }));
      disposers.push(ctx.tools.presentAs('native'));
      disposers.push(ctx.tools.guard((execution) => {
        try { authorize(execution.agent, execution.name); return undefined; }
        catch (error: unknown) { return error instanceof Error ? error.message : String(error); }
      }));
      for (const binding of configuration.tools) {
        const trusted = this.options.tools.get(binding.name);
        if (!trusted || trusted.effect !== binding.effect) throw new ExperimentError('POLICY_DENIED', 'Untrusted tool binding');
        disposers.push(ctx.tools.register(trusted.create(access)));
      }
      disposers.push(ctx.systemPrompt.section({
        name: 'EVOLVER_RESEARCH_ROLE', order: 0, text: pending.prompt, complete: true, interpolate: false,
      }));
      disposers.push(ctx.on('system-prompt/assemble', async (_assembly: PromptAssembly, _context: unknown, next: () => Promise<PromptAssembly>) => {
        assertMember(member);
        const assembly = await next();
        const allowed = new Set(configuration.tools.map((tool) => tool.name));
        return { ...assembly, contexts: [], tools: assembly.tools.filter((tool) => allowed.has(tool.name)),
          variables: { ...assembly.variables, provider: model.provider, model: model.model } };
      }, { prepend: true }));
      disposers.push(ctx.on('agent/request', async (_payload: unknown, next: () => Promise<Record<string, unknown>>) => {
        assertMember(member);
        return { ...await next(), provider: model.provider, model: model.model };
      }, { prepend: true }));
      const application = {
        memberSessionId: member.id, memberName: actual.name, roleConfigurationRef: pending.roleConfigurationRef,
        grantId: grant.grantId, systemPromptSha256: createHash('sha256').update(pending.prompt).digest('hex'),
        tools: configuration.tools.map((tool) => tool.name), readRoots: [...configuration.readRoots], writeRoots: [...configuration.writeRoots],
        model: { provider: model.provider, model: model.model }, modelRoute: configuration.modelRoute,
        context: 'fresh' as const, hook: 'agent/created' as const, evidenceKind: 'runtime-hook-installation' as const,
      };
      if (receipt.status !== 'succeeded') throw new ExperimentError('RECONCILIATION_REQUIRED', 'Role grant failed to commit');
      const recordRef = this.service.recordRoleApplication(this.lead, member, application);
      this.memberDisposers.set(member, disposers);
      pending.application = { ...application, recordRef };
    } catch (error: unknown) {
      for (const dispose of disposers.reverse()) dispose();
      throw error;
    }
  }

  async spawnRole(request: {
    memberName: string; commandId: string; expectedRevision: number; roleConfigurationRef: ArtifactRef; expiresAt: string;
  }, signal: AbortSignal): Promise<RoleApplicationReceipt> {
    if (this.disposed || signal.aborted) throw new ExperimentError('POLICY_DENIED', 'Research role admission is closed');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(request.memberName) || this.pending.has(request.memberName)) {
      throw new ExperimentError('SCHEMA_VIOLATION', 'Role member name is invalid or already pending');
    }
    const prepared = this.service.prepareRole(this.lead, request.roleConfigurationRef);
    if (!this.options.modelRoutes.has(prepared.configuration.modelRoute)) {
      throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Role model route is not configured');
    }
    for (const binding of prepared.configuration.tools) {
      if (this.options.tools.get(binding.name)?.effect !== binding.effect) throw new ExperimentError('POLICY_DENIED', 'Role tool binding not available');
    }
    const pending: PendingRole = { ...request, ...prepared, application: null };
    this.pending.set(request.memberName, pending);
    try {
      const spawned = await this.host.agentTeams.spawnTeammate(this.lead, {
        name: request.memberName, description: `Research ${prepared.configuration.roleId}`,
        prompt: [{ type: 'text', text: `Research task ${this.options.taskId}. Read only the input refs explicitly provided by your delegated role. Report your output refs and unresolved conditions.` }],
        context: 'fresh', provider: this.options.freshProvider, signal: AbortSignal.any([signal, this.lifecycle.signal]),
      });
      if (!pending.application || spawned.member.id !== pending.application.memberSessionId) {
        // A host that bypassed awaited lifecycle must not be silently accepted.
        this.host.agentTeams.interrupt(this.lead, request.memberName);
        throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Host released a member without the awaited role application');
      }
      return { ...pending.application, tools: [...pending.application.tools] };
    } finally { this.pending.delete(request.memberName); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle.abort(new Error('Research runtime disposed'));
    const failures: unknown[] = [];
    for (const member of this.memberDisposers.keys()) {
      const identity = this.host.agentTeams.tryMembership(member);
      if (identity) {
        try { this.host.agentTeams.interrupt(this.lead, identity.name); }
        catch (error: unknown) { failures.push(error); }
      }
    }
    // Keep the member-owned restrictions/guards/request hooks in place: lifting
    // them while a continuable child exists would reopen inherited capabilities.
    // They deny after disposed and are torn down with the member's own scope.
    for (const dispose of this.disposers.reverse()) dispose();
    if (failures.length > 0) throw new AggregateError(failures, 'Research member interruption failed during disposal');
  }
  async cancelRole(caller: unknown, request: { commandId: string; memberName: string; expectedRevision: number }, signal: AbortSignal): Promise<import('../../contracts/research-command.ts').ResearchCommandReceipt> {
    this.service.assertLead(caller);
    const replay = this.service.getRuntimeTerminationReceipt(caller, request.commandId, request.memberName);
    if (replay) return replay;
    if (!this.host.agentTeams.waitForChange || !this.service.hasRuntimeStopVerifier()) throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Member cancellation requires actual Host wait/status and verifier capabilities');
    const row = this.host.agentTeams.listMembers(this.lead).find((entry) => entry.role === 'teammate' && entry.name === request.memberName), member = row && this.host.agents.get(row.id);
    if (!row || !member || !this.memberDisposers.has(member)) throw new ExperimentError('OWNER_MISMATCH', 'Cancellation target is not an installed actual research member');
    const grant = this.service.getTeamResearch(this.lead).grants.find((entry) => entry.memberSessionId === member.id);
    if (!grant) throw new ExperimentError('DEPENDENCY_NOT_READY', 'Member has no research delegation');
    this.service.revoke(this.lead, { schemaVersion: 1, commandId: `${request.commandId}-revoke`, taskId: this.options.taskId, expectedRevision: request.expectedRevision,
      policyRef: this.options.policyRef, budgetRef: this.options.budgetRef, payload: { grantId: grant.grantId } });
    this.host.agentTeams.interrupt(this.lead, row.name);
    const deadline = Date.now() + 30000;
    while (true) {
      const current = this.host.agentTeams.listMembers(this.lead).find((entry) => entry.id === member.id);
      if (current?.status === 'inactive' || current?.status === 'failed') return this.service.recordRuntimeTermination(this.lead, member, { schemaVersion: 1, commandId: request.commandId,
        taskId: this.options.taskId, expectedRevision: this.service.getTeamResearch(this.lead).revision, policyRef: this.options.policyRef, budgetRef: this.options.budgetRef,
        payload: { grantId: grant.grantId, memberSessionId: member.id, memberName: row.name, lastStatus: current.status, observedAt: new Date().toISOString() } });
      if (!current || !current.status || Date.now() >= deadline || signal.aborted) throw new ExperimentError('RECONCILIATION_REQUIRED', 'Grant revoked, but actual member stopping has not been proved');
      await this.host.agentTeams.waitForChange(this.lead, 10000, signal);
    }
  }
}
