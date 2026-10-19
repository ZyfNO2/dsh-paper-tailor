import { GeneralWikiService } from '../../packages/evolver/src/application/general-wiki-service.ts';
import { ResearchCycleService } from '../../packages/evolver/src/application/research-cycle-service.ts';
import { applyResearchCycleTools } from '../../packages/evolver/src/adapters/dsh/research-cycle-tools.ts';
import { paperLibraryResolver } from '../../packages/evolver/src/adapters/dsh/research-bootstrap-graph-tools.ts';
/**
 * Research bootstrap HOST acceptance (BE-03): query projection, trusted action bridge,
 * Agent workflow dispatch and the restart sweep.
 *
 * Spec: docs/mvp/redesign-2026-10-08/RESEARCH-BOOTSTRAP-BE-03-INTEGRATION-SPEC-2026-10-10.md §3–§4.
 * The plugin `apply` runs against a stub Cordis context with a REAL workspace directory, the
 * real BE-02 store/services and a real on-disk paper library.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { componentEntryContentHash } from '../../packages/evolver/src/contracts/research-bootstrap.ts';
import { PaperLibrary } from '../../packages/evolver/src/application/paper-library.ts';
import { ResearchBootstrapStore } from '../../packages/evolver/src/application/research-bootstrap-store.ts';
import { ResearchBootstrapGraphService } from '../../packages/evolver/src/application/research-bootstrap-graph-service.ts';
import { ResearchBootstrapIntentService } from '../../packages/evolver/src/application/research-bootstrap-intent-service.ts';
import { apply as applyHost } from '../../packages/evolver/src/adapters/dsh/research-bootstrap-host.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('native cycle read accepts legacy paper runs without optional scheduling fields', async t => {
  const seed = seedWorkspace(); t.after(seed.cleanup);
  const store = new ResearchBootstrapStore(seed.workspace);
  const service = new ResearchCycleService({ workspaceRoot: seed.workspace, bootstrapStore: store, resolver: paperLibraryResolver(seed.workspace) });
  service.startCycle({ kind: 'user', identity: 'user', actionId: 'start' }, { commandId: 'legacy-read', researchId: seed.researchId, selectedIdeaId: seed.ideaId, expectedBootstrapRevision: store.readStateOrEmpty().revision, expectedCycleRevision: 0 });
  const tools = new Map<string, any>();
  applyResearchCycleTools({ tools: { register: (tool: any) => tools.set(tool.name, tool) } } as never, { workspaceRegistry: { list: () => [{ id: 'w', title: 'w', path: seed.workspace, sessionIds: ['reader'] }] } });
  const value = await tools.get('evolver_get_research_cycle').execute({ researchId: seed.researchId }, { agent: { id: 'reader' } });
  assert.equal(value.runs.length, 1); assert.equal(value.runs[0].status, 'queued');
  assert.equal(value.runs[0].nodeId, store.readStateOrEmpty().researches[0].graph!.nodes.find(n => n.kind === 'hypothesis')!.nodeId);
  assert.equal(Object.hasOwn(value.runs[0], 'executionPolicy'), false);
  assert.deepEqual(value, JSON.parse(JSON.stringify(value)), 'tool projection must be lossless JSON without dropping undefined fields');
});

interface Harness {
  workspace: string;
  researchId: string;
  ideaId: string;
  bindingToken: string;
  route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void };
  agent: { woken: string[]; idle: () => Promise<void> };
  tools: string[];
  get(url: string): Promise<{ status: number; body: any }>;
  post(url: string, body: unknown): Promise<{ status: number; body: any }>;
  revision(): number;
  preStep(text: string, kind?: string, id?: string, decisionKind?: string): Promise<any>;
  cleanup(): void;
}

function seedWorkspace(): { workspace: string; researchId: string; ideaId: string; bindingToken: string; cleanup: () => void } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootstrap-host-'));
  const store = new ResearchBootstrapStore(workspace, { lockTimeoutMs: 2_000, lockPollIntervalMs: 5 });
  // A real paper library entry, published so it carries a revision and components.
  const library = new PaperLibrary(path.join(workspace, '.dsh', 'research', 'papers'), workspace);
  const quote = 'The gate re-weights channel features in the encoder.';
  const imported = library.import(workspace, 'fixture-paper.pdf', Buffer.from('fixture source bytes'), [`${quote}\nSecond line of page one.`]);
  const published = library.publish(workspace, imported.id, {
    baseRevision: null, title: 'Fixture Paper',
    sections: [{ heading: 'Method', summary: '整体方法', page: 1, quote }],
    components: [{ kind: 'Module', name: 'Attention Gate', description: 'a gating module', page: 1, quote }],
    submitted: 'all',
  });
  const resolver = { getPaper: (paperId: string) => paperId === published.id ? { paperId: published.id, sourceSha256: published.sha256, revision: published.revision, title: published.title, sections: published.sections, components: published.components } : null };
  const graph = new ResearchBootstrapGraphService(store, { resolver });
  const intent = new ResearchBootstrapIntentService(store, { resolver });
  const created = intent.saveResearchContract({
    baseRevision: 0, operationId: 'seed-contract', patch: { title: '宿主测试研究', goal: '改进小样本分割' },
    origin: { kind: 'user_action', identity: 'user', actionId: 'seed' },
  });
  const researchId = created.result.researchId;
  const component = published.components[0];
  const publishedIdea = intent.publishResearchIdeas({
    researchId, baseRevision: store.readStateOrEmpty().revision, operationId: 'seed-idea',
    contractRevision: store.readStateOrEmpty().researches.find((entry) => entry.researchId === researchId)!.contract.revision,
    run: { agentIdentity: 'session-1' },
    ideas: [{
      title: '门控增强', hypothesis: '假设：门控提升泛化', basis: 'grounded',
      evidenceRefs: [{ paperId: published.id, sourceSha256: published.sha256, assetRevision: published.revision!, assetKind: 'component', entryIndex: 0, contentHash: componentEntryContentHash(component), page: component.page, quote: component.quote, locator: null, snapshot: { label: component.name, kind: component.kind, description: component.description, page: component.page, quote: component.quote } }],
      atomicChange: '插入门控', validationPlan: '对比 mIoU', proposedSlot: 'Variable',
    }],
  });
  const ideaId = publishedIdea.result.ideaIds[0];
  graph.selectResearchIdeas({ researchId, baseRevision: store.readStateOrEmpty().revision, operationId: 'seed-select', ideaIds: [ideaId], actor: { identity: 'user', actionId: 'seed-select' } });
  graph.initializeGraph({ researchId, baseRevision: store.readStateOrEmpty().revision, operationId: 'seed-init', contractRevision: store.readStateOrEmpty().researches.find((entry) => entry.researchId === researchId)!.contract.revision });
  // The candidate the UI would see, from the graph's own slot table.
  const state = store.readStateOrEmpty();
  const activeGraph = state.researches.find((entry) => entry.researchId === researchId)!.graph!;
  const baselineNode = activeGraph.nodes.find((node) => node.kind === 'baseline')!;
  const baselineSlot = activeGraph.slots.find((slot) => slot.name === 'Baseline')!;
  const bindingToken = `paper:${published.id}:0@${published.revision}@${componentEntryContentHash(component)}`;
  return {
    workspace, researchId, ideaId, bindingToken,
    cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }),
    __unused: { baselineNode, baselineSlot },
  } as never;
}

function fakeRes(): { res: { statusCode: number; headers: Record<string, string>; setHeader(k: string, v: string): void; end(b?: string): void }; bodyText: () => string } {
  const state = { body: '' };
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { res.headers[k] = v; },
    end(body?: string) { state.body = body ?? ''; },
  };
  return { res, bodyText: () => state.body };
}

async function confirmHostPrerequisites(h: Harness, researchId: string): Promise<void> {
  const g = (await h.get('/evolver/research-bootstrap?sessionId=session-1')).body.bootstrap.researches.find((r: any) => r.researchId === researchId).general;
  for (const node of g.graph.nodes.filter((n: any) => ['goal', 'materials', 'protocol'].includes(n.kind))) {
    const response = await h.post('/evolver/research-bootstrap/actions?sessionId=session-1', { type: 'confirm_general_manual_node', operationId: `host-prerequisite-${node.nodeId}-${h.revision()}`, baseRevision: h.revision(), researchId, nodeId: node.nodeId, sourceRefs: node.kind === 'goal' ? [] : g.sources.map((s: any) => s.sourceId), reason: 'Host 正向 fixture 显式确认前置' });
    assert.equal(response.body.ok, true, JSON.stringify(response.body));
  }
}
function fakeReq(url: string, method: string, raw?: string): unknown {
  return {
    url, method,
    on(event: string, callback: (chunk?: Buffer) => void) {
      if (event === 'data' && raw !== undefined) callback(Buffer.from(raw));
      if (event === 'end') queueMicrotask(() => callback());
      return this;
    },
    destroy() { /* bounded body guard */ },
  };
}

function harness(options: { seedRunningRun?: boolean; authRejection?: number } = {}): Harness {
  const seed = seedWorkspace();
  if (options.seedRunningRun === true) {
    const store = new ResearchBootstrapStore(seed.workspace);
    const state = store.readStateOrEmpty();
    const research = state.researches.find((entry) => entry.researchId === seed.researchId)!;
    new ResearchBootstrapStore(seed.workspace).mutate({
      operationId: 'seed-running', kind: 'begin_brainstorm_run', researchId: seed.researchId,
      baseRevision: state.revision,
      requestPayload: { op: 'begin_brainstorm_run', researchId: seed.researchId },
      apply: (context) => {
        const target = context.state.researches.find((entry) => entry.researchId === seed.researchId)!;
        target.brainstormRuns.push({
          runId: 'run-seeded-running', operationId: 'seed-running', agentIdentity: 'session-1', modelIdentity: null,
          contractRevision: research.contract.revision, inputRefs: [], inputEnvironmentIds: [], inputNotes: null,
          status: 'running', ideaIds: [], itemErrors: [], duplicates: [], emptyResultReason: null, error: null,
          startedAt: context.now(), finishedAt: null,
        });
        return { changed: true, result: { runId: 'run-seeded-running' } };
      },
    });
  }
  const tools: string[] = [];
  const routes: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }> = [];
  const agent = (() => {
    const hooks = new Map<string, Array<(payload: unknown, next?: () => Promise<unknown>) => void>>();
    const woken: string[] = [];
    return {
      id: 'session-1', session: { header: { cwd: undefined } },
      ctx: { on: (name: string, listener: (payload: unknown, next?: () => Promise<unknown>) => void) => { hooks.set(name, [...(hooks.get(name) ?? []), listener]); return () => undefined; } },
      inbox: undefined,
      followup: (message: unknown) => { woken.push(JSON.stringify(message)); },
      hooks, woken,
      async idle() {
        for (const listener of hooks.get('agent/status') ?? []) (listener as (payload: unknown) => void)({ status: 'idle' });
      },
    };
  })();
  let workflowHook: any;
  const ctx = {
    logger: { warn: () => undefined },
    on: (name: string, listener: unknown) => { if (name === 'agent/pre-step') workflowHook = listener; return () => undefined; },
    tools: {
      register: (tool: { name: string }) => { tools.push(tool.name); },
      get: (name: string) => (name.startsWith('evolver_') ? {} : undefined),
    },
    get(name: string) {
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'ws-1', path: seed.workspace, title: '宿主测试工程', sessionIds: ['session-1'] }] };
      if (name === 'connection') return { requestRejection: () => options.authRejection };
      if (name === 'webServer') return { register: (route: never) => { routes.push(route); return () => undefined; } };
      if (name === 'tools') return this.tools;
      if (name === 'agents') return { get: (id: string) => (id === 'session-1' ? agent : undefined) };
      return undefined;
    },
  };
  applyHost(ctx as never, {
    workspaceRegistry: { list: () => [{ id: 'ws-1', path: seed.workspace, title: '宿主测试工程', sessionIds: ['session-1'] }] },
    agents: { get: (id: string) => (id === 'session-1' ? agent : undefined) },
    probeRunner: async () => [
      { observationId: 'obs-fake-1', probe: 'host_identity' as const, status: 'observed' as const, at: '2026-10-10T00:00:00.000Z', value: { platform: 'win32' }, error: null, source: { kind: 'structured_host' as const }, durationMs: 1 },
    ],
  });
  const route = routes.find((entry) => entry.path === '/evolver/research-bootstrap')!;
  assert.ok(route, 'the single bootstrap route must be registered');
  const request = async (method: string, urlSuffix: string, body?: unknown) => {
    const { res, bodyText } = fakeRes();
    route.handler(fakeReq(`http://localhost${urlSuffix}`, method, body === undefined ? undefined : JSON.stringify(body)), res);
    await new Promise((resolve) => setImmediate(resolve));
    let parsed: any;
    try { parsed = JSON.parse(bodyText()); } catch { parsed = bodyText(); }
    return { status: res.statusCode, body: parsed };
  };
  return {
    workspace: seed.workspace, researchId: seed.researchId, ideaId: seed.ideaId, bindingToken: seed.bindingToken,
    route, agent, tools,
    get: (url: string) => request('GET', url),
    post: (url: string, body: unknown) => request('POST', url, body),
    revision: () => new ResearchBootstrapStore(seed.workspace).readStateOrEmpty().revision,
    preStep: (text: string, kind = 'user', id?: string, decisionKind = 'enter') => workflowHook({ agent, messages: [{ id, source: { kind }, content: [{ type: 'text', text }] }] }, async () => ({ kind: decisionKind, messages: [] })),
    cleanup: seed.cleanup,
  };
}

test('natural-language host hook loads persistence skill without a slash command and ignores tool text', async () => {
  const h = harness();
  try {
    const injected = await h.preStep('实验完了，数据分析吧');
    assert.equal(injected.messages.length, 1);
    assert.match(JSON.stringify(injected.messages), /研究工作区连续推进/);
    assert.equal((await h.preStep('更新工作台', 'tool')).messages.length, 0);
    assert.equal((await h.preStep('只讨论工作台设计，不要更新')).messages.length, 0);
  } finally { h.cleanup(); }
});

test('natural research requests and contextual follow-ups load guidance once per human turn', async () => {
  const h = harness();
  try {
    const store = new ResearchBootstrapStore(h.workspace);
    store.mutate({ operationId: 'test-clear-active', baseRevision: h.revision(), kind: 'test_fixture', researchId: null, requestPayload: {}, apply: context => { context.state.activeResearchId = null; return { changed: true, result: {} }; } });
    assert.equal((await h.preStep('那先看看小目标这条，尽量简单一点。', 'user', 'no-context')).messages.length, 0);
    const first = await h.preStep('我想基于这篇论文做点改进，先帮我看看。', 'user', 'human-1');
    assert.equal(first.messages.length, 1);
    assert.equal(first.kind, 'enter', 'preserve the actual DSH 0.2 decision');
    assert.match(JSON.stringify(first.messages), /只有本地 Markdown 或聊天总结不算完成/);
    assert.match(JSON.stringify(first.messages), /最小研究草稿/);
    assert.equal((await h.preStep('我想基于这篇论文做点改进，先帮我看看。', 'user', 'human-1')).messages.length, 0);
    for (const [i, text] of ['你觉得有什么适合先试的方向？', '那先看看小目标这条，尽量简单一点。', '先帮我把实验安排好，我自己去跑。', '我跑完了，结果在这里，你帮我看看。', '这个提升是不是也有代价？结果可靠吗？', '那我们接下来做什么比较合适？', '我又补了两条，放一起比较一下。', '把我们做过的事整理一下，下次继续。', '我们继续之前那个 YOLO 研究，现在到哪一步了？'].entries()) {
      assert.equal((await h.preStep(text, 'user', `human-next-${i}`)).messages.length, 1, text);
    }
    for (const text of ['好的', '谢谢', '嗯，我看看', '这个有点意思', '先这样吧', '只讨论，先不要保存', '先别写入，分析一下实验结果']) {
      assert.equal((await h.preStep(text, 'user', `ignore-${text}`)).messages.length, 0, text);
    }
    assert.equal((await h.preStep('把实验安排好', 'tool', 'untrusted')).messages.length, 0);
    assert.equal((await h.preStep('安排实验计划', 'user', 'rejected', 'reject')).messages.length, 0);
    assert.equal((await h.preStep('安排实验计划', 'user', 'rejected', 'enter')).messages.length, 1, 'a rejected step must not consume guidance');
    assert.equal((await h.preStep('安排实验计划', 'user', 'legacy', 'continue')).messages.length, 1);
  } finally { h.cleanup(); }
});

test('BE-03 host: GET projects the bootstrap state with entry-level evidence states', async () => {
  const h = harness();
  try {
    const read = await h.get('/evolver/research-bootstrap?sessionId=session-1');
    assert.equal(read.status, 200);
    assert.equal(read.body.schemaVersion, 1);
    assert.equal(read.body.scope, 'workspace-files');
    assert.equal(read.body.workspace.title, '宿主测试工程');
    assert.equal(read.body.bootstrap.revision > 0, true);
    const research = read.body.bootstrap.researches[0];
    assert.equal(research.researchId, h.researchId);
    assert.equal(research.contract.goal, '改进小样本分割');
    const ideaEvidence = research.evidence.filter((entry: { where: string }) => entry.where.startsWith(`idea:${h.ideaId}@`));
    assert.equal(ideaEvidence.length, 1);
    assert.equal(ideaEvidence[0].status, 'current', 'a fresh published component assesses current');
    assert.ok(read.body.bootstrap.graph !== null);
    assert.ok(read.body.bootstrap.slots.length >= 7, 'universal slots are projected');
    assert.deepEqual(read.body.bootstrap.selectedIdeaIds, [h.ideaId]);
    // Exact tool inventory of this mount, including takeover and external-result tools.
    assert.deepEqual([...new Set(h.tools)].sort(), [
      'evolver_get_research_bootstrap', 'evolver_initialize_research_graph', 'evolver_list_evidence_candidates',
      'evolver_map_slot_candidates', 'evolver_prepare_general_wiki_task', 'evolver_probe_research_environment', 'evolver_publish_general_wiki_task', 'evolver_publish_research_ideas', 'evolver_read_general_wiki_task',
      'evolver_save_research_contract', 'evolver_set_slot_component', 'evolver_update_research_idea',
      'evolver_validate_research_ideas',
      'evolver_adopt_research_takeover', 'evolver_bind_research_takeover', 'evolver_check_takeover_freshness',
      'evolver_decide_external_result', 'evolver_read_research_takeover', 'evolver_refresh_research_takeover',
      'evolver_register_external_result', 'evolver_review_external_results',
      'evolver_save_research_takeover_snapshot', 'evolver_start_research_takeover',
    ].sort());
  } finally { h.cleanup(); }
});

test('BE-03 host: auth rejection, unknown path and wrong method behave like the paper-library route', async () => {
  const denied = harness({ authRejection: 401 });
  try {
    // Auth runs before anything else, exactly like the paper-library route.
    const rejected = await denied.get('/evolver/research-bootstrap?sessionId=session-1');
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.error, 'AUTH_REQUIRED');
    const rejectedAction = await denied.post('/evolver/research-bootstrap/actions?sessionId=session-1', { type: 'start_research' });
    assert.equal(rejectedAction.status, 401);
  } finally { denied.cleanup(); }
  const h = harness();
  try {
    const missingSession = await h.get('/evolver/research-bootstrap');
    assert.equal(missingSession.status, 400);
    const unknownPath = await h.get('/evolver/research-bootstrap/other?sessionId=session-1');
    assert.equal(unknownPath.status, 404);
    const wrongMethod = await h.get('/evolver/research-bootstrap/actions?sessionId=session-1');
    assert.equal(wrongMethod.status, 405);
  } finally { h.cleanup(); }
});

test('BE-03 host: user actions persist through the trusted services with child-operation confirm', async () => {
  const h = harness();
  try {
    const before = h.revision();
    // start_research (a second research): the bridge performs the trusted write.
    const started = await h.post('/evolver/research-bootstrap/actions?sessionId=session-1', {
      type: 'start_research', researchId: null, baseRevision: before, operationId: 'ui-op-start',
      draft: { question: '如何提升泛化？', objective: '研究门控', guardrails: ['不使用外部数据'] },
    });
    assert.equal(started.body.ok, true);
    assert.equal(started.body.state, 'final');
    assert.equal(started.body.revision, before + 1);
    const researchId = started.body.resultRefs[0].key;
    const state = new ResearchBootstrapStore(h.workspace).readStateOrEmpty();
    const created = state.researches.find((entry) => entry.researchId === researchId)!;
    assert.equal(created.contract.researchQuestion, '如何提升泛化？');
    assert.equal(created.contract.autonomy, 'plan_only');

    // save + confirm: two store steps under ONE root operationId (child `:confirm`).
    const confirmed = await h.post('/evolver/research-bootstrap/actions?sessionId=session-1', {
      type: 'save_research_contract', researchId, baseRevision: started.body.revision,
      operationId: 'ui-op-save', patch: { objective: '研究门控（修订）' }, confirm: true, contractRevision: created.contract.revision,
    });
    assert.equal(confirmed.body.ok, true);
    const after = new ResearchBootstrapStore(h.workspace).readStateOrEmpty();
    const confirmedResearch = after.researches.find((entry) => entry.researchId === researchId)!;
    assert.equal(confirmedResearch.contract.status, 'confirmed');
    // The recorded action identity is the ROOT user action (the click), not the
    // internal child operation id the confirm step used for its own CAS/receipt.
    assert.equal(confirmedResearch.contract.confirmations.at(-1)!.actionId, 'ui-op-save');

    // Same operationId + same payload replays without writing again.
    const replay = await h.post('/evolver/research-bootstrap/actions?sessionId=session-1', {
      type: 'start_research', researchId: null, baseRevision: before, operationId: 'ui-op-start',
      draft: { question: '如何提升泛化？', objective: '研究门控', guardrails: ['不使用外部数据'] },
    });
    assert.equal(replay.body.revision, started.body.revision, 'replay returns the original result');

    // A stale base is an honest rejection, not an overwrite.
    const stale = await h.post('/evolver/research-bootstrap/actions?sessionId=session-1', {
      type: 'save_research_contract', researchId, baseRevision: 0, operationId: 'ui-op-stale',
      patch: { objective: 'x' }, confirm: false, contractRevision: confirmedResearch.contract.revision,
    });
    assert.equal(stale.body.ok, false);
    assert.ok(String(stale.body.reason).includes('REVISION_CONFLICT'));
  } finally { h.cleanup(); }
});

test('BE-03 host: idea selection, slot binding and lock all persist; locked rebinding is refused', async () => {
  const h = harness();
  try {
    const read = await h.get('/evolver/research-bootstrap?sessionId=session-1');
    const revision = read.body.bootstrap.revision;
    // Deselect the seeded idea through the bridge.
    const deselected = await h.post('/evolver/research-bootstrap/actions?sessionId=session-1', {
      type: 'select_research_ideas', researchId: h.researchId, baseRevision: revision, operationId: 'ui-op-deselect', ideaIds: [],
    });
    assert.equal(deselected.body.ok, true);
    assert.deepEqual(new ResearchBootstrapStore(h.workspace).readStateOrEmpty().researches.find((entry) => entry.researchId === h.researchId)!.selectionProof!.ideaIds, []);

    // Bind a component to the baseline slot with the projected candidate token.
    const slotId = read.body.bootstrap.slots.find((slot: { name: string }) => slot.name === 'Baseline')!.slotId;
    const graph = new ResearchBootstrapStore(h.workspace).readStateOrEmpty().researches.find((entry) => entry.researchId === h.researchId)!.graph!;
    const baselineNode = graph.nodes.find((node: { kind: string }) => node.kind === 'baseline')!.nodeId;
    const bound = await h.post('/evolver/research-bootstrap/actions?sessionId=session-1', {
      type: 'set_slot_component', researchId: h.researchId, baseRevision: deselected.body.revision,
      operationId: 'ui-op-bind', nodeId: baselineNode, slotId, ref: { token: h.bindingToken },
    });
    assert.equal(bound.body.ok, true, JSON.stringify(bound.body));
    assert.equal(bound.body.state, 'final');
    const boundState = new ResearchBootstrapStore(h.workspace).readStateOrEmpty();
    const boundGraph = boundState.researches.find((entry) => entry.researchId === h.researchId)!.graph!;
    assert.equal(boundGraph.slots.find((slot: { slotId: string }) => slot.slotId === slotId)!.currentRef!.kind, 'paper_component');

    // Lock, then refuse a rebinding.
    const locked = await h.post('/evolver/research-bootstrap/actions?sessionId=session-1', {
      type: 'set_slot_locked', researchId: h.researchId, baseRevision: bound.body.revision,
      operationId: 'ui-op-lock', slotId, locked: true,
    });
    assert.equal(locked.body.ok, true);
    const rebound = await h.post('/evolver/research-bootstrap/actions?sessionId=session-1', {
      type: 'set_slot_component', researchId: h.researchId, baseRevision: locked.body.revision,
      operationId: 'ui-op-bind-2', nodeId: baselineNode, slotId, ref: { token: h.bindingToken },
    });
    assert.equal(rebound.body.ok, false);
    assert.ok(String(rebound.body.reason).includes('SLOT_LOCKED'));

    // A forged token that does not resolve is refused with a precise reason.
    const forged = await h.post('/evolver/research-bootstrap/actions?sessionId=session-1', {
      type: 'set_slot_component', researchId: h.researchId, baseRevision: bound.body.revision,
      operationId: 'ui-op-bind-3', nodeId: baselineNode, slotId,
      ref: { token: `paper:${'a'.repeat(64)}:0@rev@${'b'.repeat(64)}` },
    });
    assert.equal(forged.body.ok, false);
    assert.ok(String(forged.body.reason).includes('SOURCE_MISSING') || String(forged.body.reason).includes('unrecognized'));
  } finally { h.cleanup(); }
});

test('BE-03 host: generation dispatches to the real agent as queued, begins the run and marks INCOMPLETE_OUTPUT on idle', async () => {
  const h = harness();
  try {
    const read = await h.get('/evolver/research-bootstrap?sessionId=session-1');
    const dispatched = await h.post('/evolver/research-bootstrap/actions?sessionId=session-1', {
      type: 'generate_brainstorm', researchId: h.researchId, baseRevision: read.body.bootstrap.revision,
      operationId: 'ui-op-generate',
    });
    assert.equal(dispatched.body.ok, true);
    assert.equal(dispatched.body.state, 'queued', 'generation is queued, never claimed saved');
    const runId = dispatched.body.resultRefs[0].key;
    assert.equal(h.agent.woken.length, 1);
    const wake = h.agent.woken[0];
    assert.ok(wake.includes('ui-op-generate'), 'the wake carries the host-registered root operationId');
    assert.ok(wake.includes(runId), 'the wake carries the begun run id');
    const run = new ResearchBootstrapStore(h.workspace).readStateOrEmpty()
      .researches.find((entry) => entry.researchId === h.researchId)!.brainstormRuns
      .find((entry: { runId: string }) => entry.runId === runId)!;
    assert.equal(run.status, 'running');
    assert.equal(run.agentIdentity, 'session-1');

    // The agent drains its wakes without publishing → interrupted, content kept.
    await h.agent.idle();
    const after = new ResearchBootstrapStore(h.workspace).readStateOrEmpty()
      .researches.find((entry) => entry.researchId === h.researchId)!.brainstormRuns
      .find((entry: { runId: string }) => entry.runId === runId)!;
    assert.equal(after.status, 'interrupted');
    assert.equal(after.error!.code, 'INCOMPLETE_OUTPUT');
  } finally { h.cleanup(); }
});

test('BE-03 host: initialize dispatch and probe write through the same store', async () => {
  const h = harness();
  try {
    const read = await h.get('/evolver/research-bootstrap?sessionId=session-1');
    const initialized = await h.post('/evolver/research-bootstrap/actions?sessionId=session-1', {
      type: 'initialize_research_graph', researchId: h.researchId, baseRevision: read.body.bootstrap.revision,
      operationId: 'ui-op-init', selectedIdeaIds: [h.ideaId], contractRevision: read.body.bootstrap.researches[0].contract.revision,
    });
    assert.equal(initialized.body.ok, true);
    assert.equal(initialized.body.state, 'queued');
    assert.equal(h.agent.woken.length, 1);
    assert.ok(h.agent.woken[0].includes(h.ideaId), 'the init wake names the user-selected ideas');

    const probe = await h.post('/evolver/research-bootstrap/actions?sessionId=session-1', {
      type: 'probe_research_environment', researchId: h.researchId, baseRevision: initialized.body.revision, operationId: 'ui-op-probe',
    });
    assert.equal(probe.body.ok, true, JSON.stringify(probe.body));
    assert.equal(probe.body.state, 'final');
    const state = new ResearchBootstrapStore(h.workspace).readStateOrEmpty();
    const observations = state.researches.find((entry) => entry.researchId === h.researchId)!.environment;
    assert.equal(observations.length, 1);
    assert.equal(observations[0].probe, 'host_identity');
  } finally { h.cleanup(); }
});

test('generic host bridge persists and re-reads no-paper research without waking an Agent', async () => {
  const h = harness();
  try {
    const url = '/evolver/research-bootstrap/actions?sessionId=session-1';
    const create = { type: 'create_general_research', operationId: 'general-create', baseRevision: h.revision(), title: '材料研究', question: '温度与强度', domains: ['工程'], methods: ['engineering', 'observation'], entryMode: 'idea_only' };
    const saved = await h.post(url, create);
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
    assert.equal(saved.body.state, 'final');
    assert.equal(h.agent.woken.length, 0);
    const read = await h.get('/evolver/research-bootstrap?sessionId=session-1');
    const research = read.body.bootstrap.researches.find((r: any) => r.researchId === saved.body.researchId);
    assert.equal(research.general.ideas[0].question, '温度与强度');
    assert.equal(research.general.graph.nodes.filter((n: any) => n.kind === 'analysis').length, 2);
    const replay = await h.post(url, create);
    assert.equal(replay.body.researchId, saved.body.researchId);
    const moved = await h.post(url, { type: 'save_general_layout', operationId: 'general-layout', baseRevision: h.revision(), researchId: saved.body.researchId, positions: { [research.general.graph.nodes[0].nodeId]: { x: 200, y: 300 } } });
    assert.equal(moved.body.ok, true, JSON.stringify(moved.body));
    const edited = await h.post(url, { type: 'save_general_idea', operationId: 'general-edit', baseRevision: h.revision(), researchId: saved.body.researchId, ideaId: research.general.ideas[0].ideaId, question: '批次是否混淆温度效应？', rationale: '', verificationPlan: '按批次整理', sourceRefs: [] });
    assert.equal(edited.body.ok, true, JSON.stringify(edited.body));
    assert.equal(edited.body.ideaRevision, 2);
    assert.equal(h.agent.woken.length, 0);
    const forged = await h.post(url, { ...create, operationId: 'forged', baseRevision: h.revision(), owner: 'another-workspace' });
    assert.notEqual(forged.body.ok, true);
  } finally { h.cleanup(); }
});

test('dedicated portable package host route exports, imports new research, replays and rejects forged envelopes', async () => {
  const h = harness();
  try {
    const actions = '/evolver/research-bootstrap/actions?sessionId=session-1', endpoint = '/evolver/research-bootstrap/package?sessionId=session-1';
    const created = await h.post(actions, { type: 'create_general_research', operationId: 'package-create', baseRevision: h.revision(), title: '包测试', question: '研究问题', domains: [], methods: ['engineering'], entryMode: 'idea_only' });
    assert.equal(created.body.ok, true);
    const exported = await h.get(`${endpoint}&researchId=${created.body.researchId}`);
    assert.equal(exported.status, 200); assert.equal(exported.body.kind, 'general_portable_package');
    const input = { operationId: 'package-import', baseRevision: h.revision(), title: '新包研究', package: exported.body };
    const saved = await h.post(endpoint, input); assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
    assert.notEqual(saved.body.researchId, created.body.researchId); assert.equal(saved.body.status, 'needs_review');
    const replay = await h.post(endpoint, input); assert.equal(replay.body.replayed, true); assert.equal(replay.body.researchId, saved.body.researchId);
    const read = await h.get('/evolver/research-bootstrap?sessionId=session-1');
    const g = read.body.bootstrap.researches.find((r: any) => r.researchId === saved.body.researchId).general;
    assert.equal(g.importedHistory[0].actor.identity, 'web-ui:session-1'); assert.equal(g.requireHumanConfirmation, true);
    const archived = await h.get(`${endpoint}&researchId=${saved.body.researchId}&importId=${saved.body.importId}`);
    assert.equal(archived.status, 200); assert.equal(archived.body.researchId, created.body.researchId);
    const denied = await h.post(endpoint, { ...input, operationId: 'forged-package', baseRevision: h.revision(), identity: 'forged' });
    assert.equal(denied.status, 400); assert.equal(denied.body.ok, false);
    const stale = await h.post(endpoint, { ...input, operationId: 'stale-package' }); assert.equal(stale.body.ok, false);
    assert.equal(h.agent.woken.length, 0);
  } finally { h.cleanup(); }
});

test('dedicated package route requires authenticated workspace session for reads and imports', async () => {
  const h = harness({ authRejection: 401 });
  try {
    assert.equal((await h.get('/evolver/research-bootstrap/package?sessionId=session-1&researchId=unknown')).status, 401);
    assert.equal((await h.post('/evolver/research-bootstrap/package?sessionId=session-1', {})).status, 401);
  } finally { h.cleanup(); }
});

test('generic trusted graph recovery actions persist and project undo/redo without waking agents', async () => {
  const h = harness();
  try {
    const url = '/evolver/research-bootstrap/actions?sessionId=session-1';
    const created = await h.post(url, { type: 'create_general_research', operationId: 'undo-create', baseRevision: h.revision(), title: '恢复测试', question: '研究问题', domains: [], methods: ['engineering'], entryMode: 'idea_only' });
    assert.equal(created.body.ok, true);
    const researchId = created.body.researchId;
    const saved = await h.post(url, { type: 'save_general_node', operationId: 'undo-add', baseRevision: h.revision(), researchId, node: { title: '新步骤', kind: 'manual', goal: '', inputs: [], method: '', output: '', completionCriterion: '', join: 'all' } });
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
    const recover = async (type: string, operationId: string) => h.post(url, { type, operationId, baseRevision: h.revision(), researchId });
    const undo = await recover('undo_general_graph_edit', 'undo-action'); assert.equal(undo.body.ok, true, JSON.stringify(undo.body));
    const view = (await h.get('/evolver/research-bootstrap?sessionId=session-1')).body.bootstrap.researches.find((r: any) => r.researchId === researchId);
    assert.equal(view.general.editHistory.future.length, 1); assert.ok(!view.general.graph.nodes.some((n: any) => n.nodeId === saved.body.nodeId));
    assert.equal((await recover('redo_general_graph_edit', 'redo-action')).body.ok, true);
    assert.equal((await recover('clear_general_edit_history', 'clear-action')).body.ok, true);
    assert.equal((await recover('undo_general_graph_edit', 'empty-action')).body.ok, false);
    assert.equal(h.agent.woken.length, 0);
  } finally { h.cleanup(); }
});

test('generic trusted workflow bridge persists confirmation switch, rejects identity spoofing, projects actual policy states', async () => {
  const h = harness();
  try {
    const url = '/evolver/research-bootstrap/actions?sessionId=session-1';
    const created = await h.post(url, { type: 'create_general_research', operationId: 'policy-create', baseRevision: h.revision(), title: '确认策略测试', question: '试验问题', domains: [], methods: ['engineering'], entryMode: 'existing_data' });
    assert.equal(created.body.ok, true);
    const read = await h.get('/evolver/research-bootstrap?sessionId=session-1');
    const research = read.body.bootstrap.researches.find((r: any) => r.researchId === created.body.researchId), g = research.general;
    const profile = { title: research.title, domains: g.domains, methods: g.methods, entryMode: g.entryMode, reference: g.reference, constraints: g.constraints, pendingQuestions: g.pendingQuestions, limits: g.limits, requireHumanConfirmation: false };
    const toggled = await h.post(url, { type: 'save_general_profile', operationId: 'policy-toggle', baseRevision: h.revision(), researchId: research.researchId, profile });
    assert.equal(toggled.body.ok, true, JSON.stringify(toggled.body));
    const after = await h.get('/evolver/research-bootstrap?sessionId=session-1');
    const saved = after.body.bootstrap.researches.find((r: any) => r.researchId === research.researchId);
    assert.equal(saved.general.requireHumanConfirmation, false); assert.equal(saved.workflow[0].status, 'policy_ready'); assert.equal(saved.general.nodeConfirmations.length, 0);
    const spoofed = await h.post(url, { type: 'confirm_general_manual_node', operationId: 'spoof', baseRevision: h.revision(), researchId: research.researchId, nodeId: g.graph.nodes[0].nodeId, sourceRefs: [], reason: 'test', identity: 'fake-user' });
    assert.equal(spoofed.body.ok, false); assert.equal(h.agent.woken.length, 0);
    const exported = await h.get(`/evolver/research-bootstrap/export?sessionId=session-1&researchId=${research.researchId}`);
    assert.equal(exported.status, 200); assert.equal(exported.body.kind, 'general_research_export');
  } finally { h.cleanup(); }
});

test('generic material host actions preserve parser errors and expose bounded research-scoped preview', async () => {
  const h = harness();
  try {
    const actions = '/evolver/research-bootstrap/actions?sessionId=session-1';
    const created = await h.post(actions, { type: 'create_general_research', operationId: 'data-create', baseRevision: h.revision(), title: '实验数据', question: '温度与强度', domains: [], methods: ['engineering'], entryMode: 'existing_data' });
    const researchId = created.body.researchId;
    const source = await h.post(actions, { type: 'import_general_material', operationId: 'data-upload', baseRevision: h.revision(), researchId, filename: '强度.csv', mediaType: 'text/csv', contentBase64: Buffer.from('温度,强度\n20,10\n40,\n').toString('base64'), nature: 'user_observation', description: '', purpose: '分析' });
    assert.equal(source.body.ok, true, JSON.stringify(source.body));
    assert.equal(source.body.parseStatus, 'parsed');
    const datasetId = source.body.datasetIds[0];
    const url = `/evolver/research-bootstrap/data?sessionId=session-1&researchId=${researchId}&datasetId=${datasetId}`;
    const read = await h.get(url);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.preview.rows[1].raw[1], '');
    assert.equal(read.body.preview.rows[1].values[1], null);
    assert.equal(read.body.limits.previewRows, 100);
    const fields = read.body.preview.dataset.fields;
    fields[0].role = 'variable'; fields[0].unit = '°C'; fields[1].role = 'outcome'; fields[1].unit = 'MPa';
    const mapped = await h.post(actions, { type: 'save_general_dictionary', operationId: 'data-map', baseRevision: h.revision(), researchId, datasetId, fields, conditions: [], excludedRows: [], processingReason: '人工确认' });
    assert.equal(mapped.body.ok, true, JSON.stringify(mapped.body));
    assert.equal(mapped.body.version, 2);
    assert.equal((await h.get(url + '&limit=101')).status, 400);
    assert.equal((await h.get(url.replace(researchId, h.researchId))).status, 400);
    assert.equal(h.agent.woken.length, 0);
  } finally { h.cleanup(); }
});

test('inference host freezes actual samples, derives actor, requires consent, persists exact replay and denies revoked reads', async () => {
  const h = harness();
  try {
    const actions = '/evolver/research-bootstrap/actions?sessionId=session-1';
    const call = (type: string, payload: Record<string, unknown>, operationId = `inference-${type}-${h.revision()}`) => h.post(actions, { type, operationId, baseRevision: h.revision(), ...payload });
    const created = await call('create_general_research', { title: '推断宿主fixture', question: '验证数据绑定', domains: [], methods: ['engineering'], entryMode: 'existing_data' }), researchId = created.body.researchId;
    const upload = await call('import_general_material', { researchId, filename: 'samples.csv', mediaType: 'text/csv', contentBase64: Buffer.from('sample,value\nA,1\nB,2\nC,3\n').toString('base64'), nature: 'simulation', description: 'host fixture', purpose: '验证' });
    const g = (await h.get('/evolver/research-bootstrap?sessionId=session-1')).body.bootstrap.researches.find((r: any) => r.researchId === researchId).general;
    const fields = g.datasets[0].fields; fields[0].role = 'sample'; fields[1].type = 'number'; fields[1].role = 'outcome'; fields[1].unit = 'MPa';
    assert.equal((await call('save_general_dictionary', { researchId, datasetId: upload.body.datasetIds[0], fields, conditions: [], excludedRows: [], processingReason: '绑定身份和单位' })).body.ok, true);
    const payload = { researchId, nodeId: g.graph.nodes.find((n: any) => n.kind === 'analysis').nodeId, title: '单样本t', datasetId: upload.body.datasetIds[0], datasetVersion: 2, valueColumn: 1, sampleColumn: 0, groups: null, rowRange: { start: 0, end: 3 }, spec: { method: 'one_sample_t', confidence: 0.95, referenceMean: 0, missingPolicy: 'complete_cases', assumptions: { independenceConfirmed: true, samplingRationale: 'fixture independent samples', normalityRationale: 'fixture numerical verification' } }, requiredConditions: [], limitations: ['不作为真实实测或支持判断'] };
    const forged = await call('save_general_inference_plan', { ...payload, actor: { identity: 'forged' } }); assert.equal(forged.status, 400); assert.equal(forged.body.error, 'INVALID_INPUT');
    const saved = await call('save_general_inference_plan', payload); assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
    const store = new ResearchBootstrapStore(h.workspace), general = () => store.readStateOrEmpty().researches.find(r => r.researchId === researchId)!.general!;
    assert.notEqual(general().inferencePlans[0].actor.identity, 'forged'); assert.equal(general().inferenceRuns.length, 0);
    await confirmHostPrerequisites(h, researchId);
    const execute = { researchId, planId: saved.body.planId, planVersion: saved.body.version, authorize: true };
    assert.equal((await call('execute_general_inference', { ...execute, authorize: false })).body.ok, false);
    const done = await call('execute_general_inference', execute, 'inference-exact-run'); assert.equal(done.body.status, 'completed', JSON.stringify(done.body));
    const replay = await call('execute_general_inference', execute, 'inference-exact-run'); assert.equal(replay.body.runId, done.body.runId); assert.equal(general().inferenceRuns.length, 1);
    const endpoint = `/evolver/research-bootstrap/inference?sessionId=session-1&researchId=${researchId}&runId=${done.body.runId}`;
    const read = await h.get(endpoint); assert.equal(read.status, 200); assert.equal(read.body.result.content.result.estimate, 2); assert.match(read.body.result.content.result.warnings.join(' '), /simulation/); assert.equal(general().reviews.length, 0);
    assert.equal((await h.post(endpoint, {})).status, 405);
    assert.equal((await call('set_general_source_access', { researchId, sourceId: upload.body.sourceId, allowed: false, reason: '撤销权限' })).body.ok, true);
    assert.equal((await h.get(endpoint)).status, 403);
  } finally { h.cleanup(); }
  const denied = harness({ authRejection: 401 });
  try { assert.equal((await denied.get('/evolver/research-bootstrap/inference?sessionId=session-1&researchId=x&runId=y')).status, 401); } finally { denied.cleanup(); }
});

test('general analysis host bridge distinguishes save/compute/review, stamps reviewer and projects stale versions', async () => {
  const h = harness();
  try {
    const actions = '/evolver/research-bootstrap/actions?sessionId=session-1';
    const call = async (type: string, payload: Record<string, unknown>, operationId = `analysis-${type}-${h.revision()}`) => h.post(actions, { type, operationId, baseRevision: h.revision(), ...payload });
    const created = await call('create_general_research', { title: '白名单统计', question: '如何解释已有强度记录', domains: [], methods: ['engineering'], entryMode: 'existing_data' });
    const researchId = created.body.researchId;
    const upload = await call('import_general_material', { researchId, filename: 'a.csv', mediaType: 'text/csv', contentBase64: Buffer.from('temp,strength\n20,10\n40,20\n').toString('base64'), nature: 'user_observation', description: '', purpose: '描述统计' });
    const read = (await h.get('/evolver/research-bootstrap?sessionId=session-1')).body;
    const research = read.bootstrap.researches.find((r: any) => r.researchId === researchId);
    const datasetId = upload.body.datasetIds[0];
    const fields = research.general.datasets[0].fields;
    fields[0].role = 'variable'; fields[0].unit = '°C'; fields[1].role = 'outcome'; fields[1].unit = 'MPa';
    await call('save_general_dictionary', { researchId, datasetId, fields, conditions: [], excludedRows: [], processingReason: '确认单位' });
    const nodeId = research.general.graph.nodes.find((n: any) => n.kind === 'analysis').nodeId;
    const plan = await call('save_general_analysis_plan', { researchId, nodeId, title: '描述强度', goal: '不验证因果', datasetId, datasetVersion: 2, method: 'descriptive', numericColumns: [1], groupBy: [], sampleColumns: [], rowRange: { start: 0, end: 2 }, missingPolicy: 'available_cases', missingGroupPolicy: 'separate', requiredConditions: [], comparisonScope: '本表同单位记录', limitations: ['非总体推断'] });
    assert.equal(plan.body.ok, true, JSON.stringify(plan.body));
    const store = new ResearchBootstrapStore(h.workspace);
    assert.equal(store.readStateOrEmpty().researches.find(r => r.researchId === researchId)!.general!.calculations.length, 0);
    const payload = { researchId, planId: plan.body.planId, planVersion: plan.body.version, authorize: true };
    const blocked = await call('calculate_general_descriptive', payload);
    assert.equal(blocked.body.status, 'blocked'); assert.match(blocked.body.firstError.message, /等待前置/);
    await confirmHostPrerequisites(h, researchId);
    const denied = await call('calculate_general_descriptive', { ...payload, authorize: false });
    assert.equal(denied.body.ok, false);
    const calculated = await call('calculate_general_descriptive', payload, 'host-exact-calculation');
    assert.equal(calculated.body.ok, true, JSON.stringify(calculated.body)); assert.equal(calculated.body.status, 'completed');
    const repeated = await call('calculate_general_descriptive', payload, 'host-exact-calculation');
    assert.equal(repeated.body.calculationId, calculated.body.calculationId);
    const artifact = await h.get(`/evolver/research-bootstrap/calculation?sessionId=session-1&researchId=${researchId}&calculationId=${calculated.body.calculationId}`);
    assert.equal(artifact.status, 200); assert.equal(artifact.body.result.content.summaries[0].statistics.mean, 15);
    const reviewInput = { researchId, nodeId, calculationIds: [calculated.body.calculationId], sourceRefs: [], judgment: 'insufficient', reason: '只有描述，不确认假设', support: [], counterEvidence: [], gaps: ['缺对照'], applicability: '本版本已有数据', nextActions: ['补对照记录'] };
    const reviewed = await call('review_general_evidence', reviewInput);
    assert.equal(reviewed.body.ok, true, JSON.stringify(reviewed.body));
    const forged = await call('review_general_evidence', { ...reviewInput, reviewer: { identity: 'invented' } });
    assert.equal(forged.body.ok, false);
    const before = store.readStateOrEmpty().researches.find(r => r.researchId === researchId)!.general!;
    assert.equal(before.reviews[0].reviewer.identity, 'web-ui:session-1');
    await call('save_general_dictionary', { researchId, datasetId, fields, conditions: [], excludedRows: [0], processingReason: '新处理版本' });
    const refreshed = (await h.get('/evolver/research-bootstrap?sessionId=session-1')).body.bootstrap.researches.find((r: any) => r.researchId === researchId);
    const completedRecord = refreshed.analysis.calculations.find((c: any) => c.calculationId === calculated.body.calculationId);
    assert.equal(completedRecord.freshness.status, 'needs_review');
    assert.equal(refreshed.analysis.reviews[0].freshness.status, 'needs_review');
    assert.equal(completedRecord.status, 'completed');
    assert.equal(refreshed.analysis.calculations.find((c: any) => c.calculationId === blocked.body.calculationId).status, 'blocked');
    assert.equal(h.agent.woken.length, 0);
  } finally { h.cleanup(); }
});

test('generic metric host bridge freezes versions, validates ownership and projects actual artifacts without waking agents', async () => {
  const h = harness();
  try {
    const actions = '/evolver/research-bootstrap/actions?sessionId=session-1';
    const call = (type: string, payload: Record<string, unknown>, operationId = `metric-${type}-${h.revision()}`) => h.post(actions, { type, operationId, baseRevision: h.revision(), ...payload });
    const created = await call('create_general_research', { title: '指标接线测试', question: '已有记录如何比较', domains: [], methods: ['engineering'], entryMode: 'existing_data' });
    const researchId = created.body.researchId;
    const upload = await call('import_general_material', { researchId, filename: 'metric.csv', mediaType: 'text/csv', contentBase64: Buffer.from('value\n1\n3\n').toString('base64'), nature: 'user_observation', description: '测试 fixture，非用户实验', purpose: '核验' });
    let research = (await h.get('/evolver/research-bootstrap?sessionId=session-1')).body.bootstrap.researches.find((r: any) => r.researchId === researchId);
    const datasetId = upload.body.datasetIds[0], fields = research.general.datasets[0].fields;
    fields[0].type = 'number'; fields[0].role = 'outcome'; fields[0].unit = 'MPa';
    assert.equal((await call('save_general_dictionary', { researchId, datasetId, fields, conditions: [], excludedRows: [], processingReason: '确认单位' })).body.ok, true);
    const suggestion = await call('suggest_general_metrics', { researchId, protocolId: research.general.metricProtocols[0].protocolId });
    assert.equal(suggestion.body.ok, true, JSON.stringify(suggestion.body));
    research = (await h.get('/evolver/research-bootstrap?sessionId=session-1')).body.bootstrap.researches.find((r: any) => r.researchId === researchId);
    const { protocolId, version: _version, createdAt: _at, contextHash: _hash, ...draft } = research.general.metricProtocols.at(-1);
    const save = { researchId, protocolId, protocol: { ...draft, status: 'frozen' } };
    const frozen = await call('save_general_metric_protocol', save, 'metric-freeze-exact');
    assert.equal(frozen.body.ok, true, JSON.stringify(frozen.body));
    assert.equal((await call('save_general_metric_protocol', save, 'metric-freeze-exact')).body.version, frozen.body.version);
    assert.equal((await call('save_general_metric_protocol', { ...save, researchId: h.researchId })).body.ok, false);
    const plan = await call('save_general_analysis_plan', { researchId, nodeId: research.general.graph.nodes.find((n: any) => n.kind === 'analysis').nodeId, title: '指标描述', goal: '测试数学汇总', datasetId, datasetVersion: 2, method: 'descriptive', numericColumns: [0], groupBy: [], sampleColumns: [], rowRange: { start: 0, end: 2 }, missingPolicy: 'available_cases', missingGroupPolicy: 'separate', requiredConditions: [], comparisonScope: '本表已登记记录', limitations: ['不作科研判断'], metricContext: { protocolId, version: frozen.body.version, variantKey: 'baseline', label: 'baseline', role: 'baseline', parentKey: null } });
    assert.equal(plan.body.ok, true, JSON.stringify(plan.body));
    await confirmHostPrerequisites(h, researchId);
    const run = await call('calculate_general_descriptive', { researchId, planId: plan.body.planId, planVersion: plan.body.version, authorize: true });
    assert.equal(run.body.status, 'completed', JSON.stringify(run.body));
    const reportInput = { researchId, report: { protocolId, version: frozen.body.version, label: '来源中的记录', sourceId: upload.body.sourceId, locator: 'value 列，原始两行', values: [{ metricId: draft.metrics[0].metricId, value: 2, unit: 'MPa' }], conditions: [], note: '来源报告不能冒充本地运行' } };
    assert.equal((await call('register_general_metric_report', reportInput, 'metric-report-exact')).body.ok, true);
    assert.equal((await call('register_general_metric_report', reportInput, 'metric-report-exact')).body.ok, true);
    const read = await h.get('/evolver/research-bootstrap?sessionId=session-1');
    assert.equal(read.status, 200); research = read.body.bootstrap.researches.find((r: any) => r.researchId === researchId);
    assert.equal(research.metrics.rows.length, 2); assert.equal(research.metrics.reports.length, 1);
    assert.equal(research.metrics.rows[0].cells[0].value, 2); assert.equal(research.metrics.rows[0].check, 'provenance_checked');
    assert.equal(research.metrics.rows[1].origin, 'source_reported'); assert.equal(research.metrics.rows[1].selectionStatus, 'not_eligible');
    assert.equal(research.general.reviews.length, 0); assert.equal(h.agent.woken.length, 0);
    const source = research.general.sources[0];
    fs.writeFileSync(path.join(h.workspace, '.dsh', 'research', 'materials', 'raw', source.sha256), 'tampered');
    const unavailable = await h.get('/evolver/research-bootstrap?sessionId=session-1');
    assert.equal(unavailable.status, 200, JSON.stringify(unavailable.body));
    assert.ok(unavailable.body.bootstrap.researches.find((r: any) => r.researchId === researchId).metrics.rows.every((r: any) => r.check === 'unavailable'));
  } finally { h.cleanup(); }
});

test('BE-03 host: the startup sweep marks orphaned running runs interrupted without touching finished ones', async () => {
  const h = harness({ seedRunningRun: true });
  try {
    const state = new ResearchBootstrapStore(h.workspace).readStateOrEmpty();
    const run = state.researches.find((entry) => entry.researchId === h.researchId)!.brainstormRuns
      .find((entry: { runId: string }) => entry.runId === 'run-seeded-running')!;
    assert.equal(run.status, 'interrupted', 'the sweep ran during apply()');
    assert.equal(run.error!.code, 'INTERRUPTED');
  } finally { h.cleanup(); }
});

test('fact pack Host actions freeze/version/read exact scope and enforce revocation without waking agents', async () => {
  const h = harness();
  try {
    const actions = '/evolver/research-bootstrap/actions?sessionId=session-1';
    const call = (type: string, payload: Record<string, unknown>, operationId = `facts-${type}-${h.revision()}`) => h.post(actions, { type, operationId, baseRevision: h.revision(), ...payload });
    const created = await call('create_general_research', { title: '报告宿主边界', question: '已有记录说明什么？', domains: [], methods: [], entryMode: 'existing_data' });
    const researchId = created.body.researchId;
    const upload = await call('import_general_material', { researchId, filename: 'facts.csv', mediaType: 'text/csv', contentBase64: Buffer.from('value\n0\n2\n').toString('base64'), nature: 'simulation', description: '行为测试', purpose: '边界检查' });
    const sourceId = upload.body.sourceId, selection = { sourceIds: [sourceId], calculationIds: [], knowledgeRefs: [], reviewIds: [] };
    const payload = { researchId, title: '冻结事实', selection };
    const saved = await call('create_general_report_fact_pack', payload, 'facts-freeze');
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
    assert.equal((await call('create_general_report_fact_pack', payload, 'facts-freeze')).body.packId, saved.body.packId);
    const url = `/evolver/research-bootstrap/report?sessionId=session-1&researchId=${researchId}&packId=${saved.body.packId}&version=1`;
    const read = await h.get(url);
    assert.equal(read.status, 200, JSON.stringify(read.body)); assert.equal(read.body.result.pack.sources[0].nature, 'simulation');
    assert.equal(read.body.result.freshness.status, 'current');
    assert.equal((await h.get(url.replace('&version=1', '&version=999'))).status, 400);
    assert.equal((await h.get(url.replace('&version=1', '&version=2'))).status, 404);
    assert.equal((await h.get(url.replace(researchId, h.researchId))).status, 404);
    assert.equal((await h.get(url.replace('session-1', 'unknown-session'))).status, 400);
    assert.equal((await call('create_general_report_fact_pack', { ...payload, selection: { ...selection, sourceIds: ['foreign'] } })).body.ok, false);
    const spoofed = await call('set_general_source_access', { researchId, sourceId, allowed: false, reason: '撤销', actor: { identity: 'fake' } });
    assert.equal(spoofed.status, 400); assert.ok(spoofed.body.error);
    const second = await call('create_general_report_fact_pack', { ...payload, packId: saved.body.packId });
    assert.equal(second.body.version, 2); assert.equal((await h.get(url)).status, 200);
    const stale = await h.post(actions, { type: 'create_general_report_fact_pack', ...payload, operationId: 'facts-stale', baseRevision: 0 });
    assert.equal(stale.body.ok, false);
    assert.equal((await call('set_general_source_access', { researchId, sourceId, allowed: false, reason: '明确撤销' })).body.ok, true);
    assert.equal((await h.get(url)).status, 403);
    const raw = await h.get(`/evolver/research-bootstrap/data?sessionId=session-1&researchId=${researchId}&sourceId=${sourceId}`);
    assert.equal(raw.status, 403);
    const projected = (await h.get('/evolver/research-bootstrap?sessionId=session-1')).body.bootstrap.researches.find((r: any) => r.researchId === researchId);
    assert.equal(projected.reports.packs[0].access, 'revoked');
    assert.equal(projected.general.sourceAccess[0].actor.identity, 'web-ui:session-1');
    assert.equal(projected.general.sources.length, 1, 'owner history is distinct from task permission');
    assert.equal((await call('set_general_source_access', { researchId, sourceId, allowed: true, reason: '恢复' })).body.ok, true);
    assert.equal((await h.get(url)).status, 200); assert.equal(h.agent.woken.length, 0);
  } finally { h.cleanup(); }
});

test('fact pack GET requires a trusted connection and GET method', async () => {
  const h = harness({ authRejection: 401 });
  try { assert.equal((await h.get('/evolver/research-bootstrap/report?sessionId=session-1&researchId=x&packId=x')).status, 401); }
  finally { h.cleanup(); }
  const allowed = harness();
  try { assert.equal((await allowed.post('/evolver/research-bootstrap/report?sessionId=session-1', {})).status, 405); }
  finally { allowed.cleanup(); }
});

test('trusted Host explicitly adopts a human Reviewer action into a future node without starting execution', async () => {
  const h = harness();
  try {
    const actions = '/evolver/research-bootstrap/actions?sessionId=session-1';
    const call = (type: string, payload: Record<string, unknown>, operationId = `adopt-${type}-${h.revision()}`) => h.post(actions, { type, operationId, baseRevision: h.revision(), ...payload });
    const created = await call('create_general_research', { title: '采纳边界', question: '原问题', domains: [], methods: [], entryMode: 'idea_only' });
    const researchId = created.body.researchId;
    const read = () => h.get('/evolver/research-bootstrap?sessionId=session-1');
    const initial = (await read()).body.bootstrap.researches.find((r: any) => r.researchId === researchId);
    const reviewed = await call('review_general_evidence', { researchId, nodeId: initial.general.graph.nodes.find((n: any) => n.kind === 'review').nodeId, calculationIds: [], sourceRefs: [], judgment: 'insufficient', reason: '未知输入', support: [], counterEvidence: [], gaps: ['缺资料'], applicability: '仅规划', nextActions: ['明确采集材料的范围'] });
    assert.equal(reviewed.body.ok, true, JSON.stringify(reviewed.body));
    const origin = { kind: 'human_review', reviewId: reviewed.body.reviewId, actionIndex: 0 }, task = { title: '材料范围', goal: '回答需要哪些材料', method: '列出纳入条件', completionCriterion: '可检查的采集清单与未知项' }, payload = { researchId, authorize: true, origin, task };
    assert.equal((await call('adopt_general_review_action', { ...payload, authorize: false })).body.ok, false);
    const spoofed = await call('adopt_general_review_action', { ...payload, actor: { identity: 'invented' } }); assert.equal(spoofed.status, 400);
    const saved = await call('adopt_general_review_action', payload, 'adopt-exact'); assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
    assert.equal((await call('adopt_general_review_action', payload, 'adopt-exact')).body.nodeId, saved.body.nodeId);
    const research = (await read()).body.bootstrap.researches.find((r: any) => r.researchId === researchId), node = research.general.graph.nodes.find((n: any) => n.nodeId === saved.body.nodeId);
    assert.equal(node.goal, task.goal); assert.equal(node.execution, 'not_started'); assert.equal(node.task.actor.identity, 'web-ui:session-1');
    assert.deepEqual(node.task.origin, origin); assert.equal(research.general.calculations.length, 0);
    assert.equal(h.agent.woken.length, 0);
    assert.equal((await call('adopt_general_review_action', { ...payload, origin: { ...origin, reviewId: 'foreign' } })).body.ok, false);
  } finally { h.cleanup(); }
});

test('Wiki host persists boards, scopes source/OKF reads and refuses late publication after task cancellation', async () => {
  const h = harness();
  try {
    const actions = '/evolver/research-bootstrap/actions?sessionId=session-1';
    const created = await h.post(actions, { type: 'create_general_research', operationId: 'wiki-create', baseRevision: h.revision(), title: 'Wiki host', question: '条件比较', domains: [], methods: ['observation'], entryMode: 'existing_data' });
    const researchId = created.body.researchId;
    const source = await h.post(actions, { type: 'import_general_material', operationId: 'wiki-material', baseRevision: h.revision(), researchId, filename: 'wiki.txt', mediaType: 'text/plain', contentBase64: Buffer.from('模拟记录：温度20°C。').toString('base64'), nature: 'simulation', description: '', purpose: '验收' });
    const entry = await h.post(actions, { type: 'save_general_knowledge', operationId: 'wiki-entry', baseRevision: h.revision(), researchId, entry: { kind: 'wiki', title: '条件', category: '概念', content: '待核对', nature: 'unknown', sourceRefs: [source.body.sourceId], calculationIds: [], nodeIds: [], input: '', output: '', conditions: [], parameters: [], operation: 'manual', archived: false } });
    const board = await h.post(actions, { type: 'save_general_wiki_board', operationId: 'wiki-board', baseRevision: h.revision(), researchId, board: { boardId: 'host-board', title: '条件板', cards: [{ instanceId: 'c', entryId: entry.body.entryId, x: 30, y: 40, width: 300, height: 330, group: '' }], links: [], view: { x: 0, y: 0, scale: 1 } } });
    assert.equal(board.body.ok, true, JSON.stringify(board.body)); assert.equal(h.agent.woken.length, 0);
    const uri = '/evolver/research-bootstrap/wiki?sessionId=session-1&researchId=' + researchId;
    const read = await h.get(uri + '&op=source&sourceId=' + source.body.sourceId); assert.equal(read.status, 200); assert.match(read.body.text, /20°C/);
    assert.equal((await h.get(uri + '&op=okf')).status, 200); assert.equal((await h.get(uri.replace('session-1', 'session-foreign') + '&op=lint')).status, 400);
    assert.equal((await h.get(uri + '&op=source&sourceId=foreign')).status, 400);
    assert.equal((await h.post(uri + '&op=lint', {})).status, 405);
    const queued = await h.post(actions, { type: 'start_general_wiki_task', operationId: 'wiki-start', baseRevision: h.revision(), researchId, taskKind: 'query', sourceIds: [source.body.sourceId], goal: '温度条件？' });
    assert.equal(queued.body.ok, true, JSON.stringify(queued.body)); assert.equal(queued.body.state, 'queued'); assert.equal(h.agent.woken.length, 1);
    const cancelled = await h.post(actions, { type: 'fail_general_wiki_task', operationId: 'wiki-cancel', baseRevision: h.revision(), researchId, taskId: queued.body.taskId }); assert.equal(cancelled.body.ok, true);
    const service = new GeneralWikiService(new ResearchBootstrapStore(h.workspace));
    assert.throws(() => service.publish({ researchId, operationId: 'late-publish', baseRevision: h.revision(), taskId: queued.body.taskId, result: '迟到产物', entries: [] }), /已经结束/);
    assert.throws(() => service.taskContext(researchId, queued.body.taskId), /待执行/);
    const auth = harness({ authRejection: 401 }); try { assert.equal((await auth.get(uri + '&op=lint')).status, 401); } finally { auth.cleanup(); }
  } finally { h.cleanup(); }
});
