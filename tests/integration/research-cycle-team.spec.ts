import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleTeamCapability, nativeCycleExecutors } from '../../packages/evolver/src/adapters/dsh/research-cycle-team.ts';

function hostFixture(options: { publish?: boolean } = {}) {
  const hooks = new Set<(payload: any) => void>();
  const tools = new Map<string, any>(), tasks: any[] = [], members: any[] = [];
  let guard: (execution: any) => string | undefined;
  let context: any, allowed: string[] = [], skill: any;
  const preSteps: any[] = [];
  const statusHooks: any[] = [];
  const scope = { tools: { restrict: (filter: any) => { allowed = filter.allow; }, presentAs: () => {}, guard: (check: any) => { guard = check; }, register: (tool: any) => { tools.set(tool.name, tool); } },
    systemPrompt: { section: () => {}, context: (value: any) => { context = value; } }, skills: { register: (value: any) => { skill = value; } }, on: (name: string, listener: any) => { if (name === 'agent/pre-step') preSteps.push(listener); if (name === 'agent/status') statusHooks.push(listener); } };
  const lead = { id: 'lead', ctx: scope };
  (scope as any).inject = (_dependencies: string[], apply: any) => apply(scope);
  const team = { membership: () => ({ id: 'lead' }), tryMembership: (agent: any) => ({ root: lead, name: agent.name }),
    listTasks: () => tasks, listMembers: () => members,
    createTask: async (caller: any, input: any) => { assert.equal(caller, lead); const task = { ...input, id: `task-${tasks.length}`, revision: 1, status: 'pending' }; tasks.push(task); return task; },
    getTask: (_caller: any, id: string) => tasks.find((t) => t.id === id),
    updateTask: async (_caller: any, input: any) => { const task = tasks.find((t) => t.id === input.taskId); assert.equal(input.expectedRevision, task.revision); task.revision++; task.status = input.action === 'complete' ? 'completed' : input.owner ? 'in_progress' : 'pending'; return task; },
    spawnTeammate: async (_caller: any, request: any) => { const agent = { id: 'actual-member', name: request.name, ctx: scope }; members.push({ ...agent, status: 'inactive' }); for (const hook of hooks) hook({ agent }); return { member: agent }; },
    sendMessage: async () => {
      assert.ok(context.text().includes('selectedIdeaRef'));
      // An idle spawn before mailbox claim is not the assignment's terminal edge.
      for (const hook of statusHooks) hook({ status: 'idle' });
      for (const hook of preSteps.slice(1)) await hook({ messages: [{ source: { kind: 'team-message' } }] }, async () => ({}));
      if (options.publish !== false) tools.get('evolver_publish_assigned_artifact').execute({ payloadJson: JSON.stringify({ schemaVersion: 1, kind: 'proposal' }) }, { concludeTurn: () => {} });
      for (const hook of statusHooks) hook({ status: 'idle' });
    },
    waitForChange: async () => {}, interrupt: () => {},
  };
  const host = { get: (name: string) => name === 'agents' ? { get: () => lead } : name === 'agentTeams' ? team : name === 'skills' ? scope.skills : undefined,
    on: (_name: string, hook: any) => { hooks.add(hook); return () => hooks.delete(hook); } };
  return { host, lead, tasks, tools, preSteps, team, guard: (input: any) => guard(input), allowed: () => allowed, skill: () => skill };
}

test('native adapter stamps actual member, reuses task board, isolates tools and validates completion order', async () => {
  const fixture = hostFixture();
  assert.equal(cycleTeamCapability(fixture.host, 'lead').available, true);
  const executor = nativeCycleExecutors(fixture.host, 'lead', 'run-1').get('hypothesis')!;
  const controller = new AbortController();
  await executor.prepare!({ stepId: 'step-1', attemptId: 'attempt-1' } as any, controller.signal);
  assert.equal(executor.memberIdentity, 'actual-member');
  assert.equal(executor.nativeTask?.teamId, 'lead');
  assert.deepEqual(fixture.allowed(), ['skill']);
  assert.equal(fixture.skill().name, 'research-cycle-hypothesis');
  assert.equal(fixture.tasks[0].status, 'in_progress');
  assert.deepEqual(await fixture.preSteps[0]({ messages: [{ source: { kind: 'subagent-settled', senderSessionId: 'actual-member' } }] }, () => { throw new Error('must not wake another coordinator'); }), { kind: 'reject' });
  let published = 0;
  await executor.execute({ step: { inputRefs: [] }, run: { selectedIdeaRef: null }, snapshot: {}, publish: () => { published++; return { id: 'artifact', sha256: 'a'.repeat(64) }; } } as any, controller.signal);
  assert.equal(published, 1);
  assert.equal(fixture.tasks[0].status, 'in_progress', 'native completion must wait for service validation');
  assert.match(fixture.guard({ name: 'write', agent: {} })!, /inactive/);
  await executor.completed!();
  assert.equal(fixture.tasks[0].status, 'completed');
  await executor.dispose!();
  assert.equal(fixture.tasks[0].status, 'completed');
});

test('missing native capabilities fail explicitly instead of accepting a permanently queued run', () => {
  const host = { get: () => undefined, on: () => () => {} };
  assert.equal(cycleTeamCapability(host, 'session').available, false);
  assert.throws(() => nativeCycleExecutors(host, 'session', 'run'), /原生 Agent Team/);
});

test('a settled assigned member without an artifact fails promptly and leaves the native task incomplete', async () => {
  const fixture = hostFixture({ publish: false });
  const executor = nativeCycleExecutors(fixture.host, 'lead', 'missing-result').get('hypothesis')!;
  const signal = AbortSignal.timeout(200);
  await executor.prepare!({ stepId: 'step-1', attemptId: 'attempt-1' } as any, signal);
  fixture.team.waitForChange = async () => { throw new Error('must detect settlement without waiting for the deadline'); };
  await assert.rejects(() => executor.execute({ step: { inputRefs: [] }, run: { selectedIdeaRef: null }, snapshot: {} } as any, signal), /without publishing/);
  assert.equal(fixture.tasks[0].status, 'in_progress');
  await executor.dispose!();
  assert.equal(fixture.tasks[0].status, 'pending');
});

test('failed/cancelled adapter disposal releases its native task without marking it completed', async () => {
  const fixture = hostFixture();
  const executor = nativeCycleExecutors(fixture.host, 'lead', 'run-1').get('hypothesis')!;
  await executor.prepare!({ stepId: 'step-1', attemptId: 'attempt-1' } as any, new AbortController().signal);
  await executor.dispose!();
  assert.equal(fixture.tasks[0].status, 'pending');
});

test('generic native role hints use baseline-free schema and honor an expired research deadline', async () => {
  const fixture = hostFixture();
  const executor = nativeCycleExecutors(fixture.host, 'lead', 'general-run', 'general').get('planner')!;
  await executor.prepare!({ stepId: 'planner-step', attemptId: 'planner-attempt' } as any, new AbortController().signal);
  assert.ok(fixture.skill().content.includes('researchMode:"general"'));
  assert.ok(fixture.skill().content.includes('method,procedure,completionCriteria'));
  assert.ok(!fixture.skill().content.includes('baseline, change, dataset'));
  await executor.dispose!();
  const expiredFixture = hostFixture();
  const expired = nativeCycleExecutors(expiredFixture.host, 'lead', 'expired', 'general', new Date(Date.now() - 1000).toISOString()).get('hypothesis')!;
  await assert.rejects(() => expired.prepare!({ stepId: 'expired-step', attemptId: 'expired-attempt' } as any, new AbortController().signal), /deadline/);
  assert.equal(expiredFixture.tasks.length, 0);
});
