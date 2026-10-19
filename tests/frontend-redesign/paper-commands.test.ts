import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import { SkillRegistry, renderSkillContent } from '@deepseek-ai/dsh-skill';
import { admitPaperSource, readAdmittedPaperSource, sourceArgument } from '../../packages/evolver/src/application/paper-source-request.ts';
import { apply, workspacePaperLibrary } from '../../packages/evolver/src/adapters/dsh/paper-library-host.ts';
import { PaperCommandRunStore } from '../../packages/evolver/src/application/paper-command-runs.ts';

/**
 * Resolve a real pdfjs-dist module for the PDF extraction path.
 *
 * `pdfModulePath` is host configuration: the released plugin receives it from its
 * profile overlay, never from the repository. The tests still need a REAL module
 * (a stub would make a PDF silently unreadable), so this resolves the caller's
 * configured path first and otherwise asks the local install, failing loudly
 * rather than falling back to a developer's absolute path.
 *
 * Set PDF_MODULE_PATH to a `pdf.mjs` (or legacy `pdf.mjs`) to point elsewhere.
 */
function resolvePdfModule(): string {
  const configured = process.env.PDF_MODULE_PATH?.trim();
  if (configured !== undefined && configured !== '') return configured;
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    throw new Error(
      'pdfjs-dist is not installed in this tree and PDF_MODULE_PATH is unset. ' +
        'Run `npm install pdfjs-dist@6.3.289` or set PDF_MODULE_PATH to a pdf.mjs file.',
    );
  }
}

test('directory receipts admit only selected sources, reject changes and another workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-commands-'));
  try {
    const workspace = path.join(root, 'workspace'), source = path.join(root, 'source with spaces');
    fs.mkdirSync(workspace); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'one.md'), 'A real source text for testing evidence and isolation.');
    fs.writeFileSync(path.join(source, 'skip.exe'), 'not a paper');
    assert.deepEqual(sourceArgument(workspace, `"${source}" 仅整理方法`), { source, instruction: '仅整理方法' });
    assert.deepEqual(sourceArgument(workspace, '全部论文'), { instruction: '全部论文' });
    assert.throws(() => sourceArgument(workspace, './missing.pdf'), /SOURCE_NOT_FOUND/);
    const receipt = admitPaperSource(workspace, source);
    assert.equal(receipt.files.length, 1);
    assert.equal(readAdmittedPaperSource(workspace, receipt.requestId, 'file-1').bytes.toString(), 'A real source text for testing evidence and isolation.');
    assert.throws(() => readAdmittedPaperSource(workspace, '../x', 'file-1'), /INVALID_SOURCE_REQUEST/);
    assert.throws(() => readAdmittedPaperSource(workspace, receipt.requestId, 'file-2'), /SOURCE_NOT_ADMITTED/);
    assert.throws(() => readAdmittedPaperSource(path.join(root, 'other'), receipt.requestId, 'file-1'), /ENOENT/);
    const receiptPath = path.join(workspace, '.dsh', 'research', 'source-requests', `${receipt.requestId}.json`);
    const original = fs.readFileSync(receiptPath, 'utf8');
    fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, files: [{ ...receipt.files[0], bytes: 2 ** 40 }] }));
    assert.throws(() => readAdmittedPaperSource(workspace, receipt.requestId, 'file-1'), /INVALID_SOURCE_RECEIPT/);
    fs.writeFileSync(receiptPath, original);
    fs.writeFileSync(path.join(source, 'one.md'), 'Changed source.');
    assert.throws(() => readAdmittedPaperSource(workspace, receipt.requestId, 'file-1'), /SOURCE_CHANGED/);
    const abort = new AbortController(); abort.abort(new Error('cancelled'));
    assert.throws(() => admitPaperSource(workspace, source, abort.signal), /cancelled/);
  } finally { fs.rmSync(root, { recursive: true }); }
});

/** The real SKILL.md body the host's filesystem provider would load (frontmatter stripped). */
function skillBody(name: string): string {
  const file = path.join(process.cwd(), '.dsh', 'skills', name, 'SKILL.md');
  return fs.readFileSync(file, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

interface PreStepDecision { kind: string; messages: readonly unknown[] }
/**
 * Minimal stand-in for one DSH Agent: a scoped event context that dispatches
 * `agent/pre-step` waterfalls, a session header, the `snapshotEvents()` the
 * tool-run context reads for owned uploads, and the real pending-input shape
 * (`inbox.nextTurn` / `inbox.nextStep`) that `agent.cancel()` clears.
 *
 * @param queued - collects every `followup()` message, so tests can read the wake line.
 * @param options.withInbox - `false` models an Agent that exposes no readable inbox.
 */
function fakeAgent(id: string, cwd: string, queued: unknown[], options: { withInbox?: boolean } = {}) {
  const hooks: ((payload: unknown, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>)[] = [];
  const statusHooks: ((payload: unknown) => unknown)[] = [];
  const ctx = { on: (name: string, listener: never) => {
    // `agent/status` is the plain (non-waterfall) notification the loop emits when its
    // driver drains every pending wake; `agent/pre-step` is the waterfall. Both are
    // agent-scoped, so a test can drive the exact edges the real host drives.
    if (name === 'agent/status') {
      const register = (handler: (payload: unknown) => unknown) => { statusHooks.push(handler); return () => { const index = statusHooks.indexOf(handler); if (index >= 0) statusHooks.splice(index, 1); }; };
      return register(listener as unknown as (payload: unknown) => unknown);
    }
    assert.equal(name, 'agent/pre-step');
    hooks.push(listener);
    return () => { const index = hooks.indexOf(listener); if (index >= 0) hooks.splice(index, 1); };
  } };
  const pending = { nextTurn: [] as { id?: string }[], nextStep: [] as { id?: string }[] };
  return {
    id, session: { header: { cwd }, snapshotEvents: () => [] as unknown[] }, ctx, hooks,
    ...(options.withInbox === false ? {} : { inbox: pending }),
    followup: (message: { id?: string }) => { pending.nextTurn.push(message); queued.push(message); },
    /** Model the host's `agent.cancel()`: both pending lists are cleared. */
    cancel: () => { pending.nextTurn.length = 0; pending.nextStep.length = 0; },
    /** Model the loop's `kick()` finally-block edge: the driver went idle. */
    idle: () => { for (const hook of [...statusHooks]) void hook({ agent: { id }, status: 'idle' }); },
    /** Model `setPhase` entering the running phase. */
    running: () => { for (const hook of [...statusHooks]) void hook({ agent: { id }, status: 'running' }); },
    /** Drive the registered pre-step waterfall exactly as the agent loop does. */
    async preStep(messages: readonly { id?: string }[], signal = new AbortController().signal): Promise<PreStepDecision> {
      // Model `inbox.claim(target, turn)`: the claimed batch leaves the pending lists.
      for (const claimed of messages) {
        for (const list of [pending.nextStep, pending.nextTurn]) {
          const index = list.findIndex((message) => message.id === claimed.id);
          if (index >= 0) list.splice(index, 1);
        }
      }
      const step = { messages, signal };
      const inner = () => Promise.resolve({ kind: 'enter', messages } as PreStepDecision);
      let chain = inner;
      for (const hook of [...hooks].reverse()) { const next = chain; chain = () => hook(step, next); }
      return chain();
    },
  };
}

/** The V4 producer kind this plugin's own context lines must carry. */
const PRODUCER_KIND = 'plugin:evolver-paper-commands';
/**
 * Assert the host's session-format-V4 message-source admission rule.
 *
 * Verified verbatim in the host bundle (`lib/types/message-sources.js`):
 *
 * ```js
 * function source(message) {
 *   const value = message["source"];
 *   if (!isSessionFormatJsonObject(value) || typeof value["kind"] !== "string"
 *       || value["kind"].length === 0 || value["kind"] === "plugin")
 *     throw new SessionFormatError("format v4 message requires a producer-owned source kind");
 * }
 * ```
 *
 * `'plugin'` is the RETIRED V3 wrapper (`{kind:'plugin', plugin:'…'}`). V4
 * rejects it while the message is admitted to `user/message`, which ends the
 * whole turn before any step or tool call. The isolated real host observed
 * exactly `turn/end reason={"kind":"error","error":{"message":"format v4 message
 * requires a producer-owned source kind"}}` with `turns=0` and no `step/start`.
 * The canonical V4 shape for a non-first-party producer is `` `plugin:${plugin}` ``
 * (host `producerKind(plugin, role)`; the V3→V4 migration rewrites the wrapper
 * to that kind and drops the `plugin` field).
 *
 * This helper exists because an adapter-level test that only checks
 * `kind !== 'user'` cannot catch the V3 wrapper: `'plugin'` satisfies
 * `kind !== 'user'` while V4 rejects it, so the two conditions disagree exactly
 * on the failing value — a fake Context can be fully green while the real host
 * refuses every turn (Spec §6: adapter tests cannot substitute for host
 * admission).
 */
class SessionFormatError extends Error {}
function isSessionFormatJsonObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Verbatim port of the host bundle's V4 admission rule (see the doc comment above). */
function v4Source(message: { source?: unknown }): void {
  const value = message.source as Record<string, unknown> | null | undefined;
  if (!isSessionFormatJsonObject(value) || typeof value!['kind'] !== 'string'
      || (value!['kind'] as string).length === 0 || value!['kind'] === 'plugin')
    throw new SessionFormatError('format v4 message requires a producer-owned source kind');
}
function assertV4Source(source: unknown, where: string): void {
  try { v4Source({ source }); }
  catch (error) { assert.fail(`${where}: ${(error as Error).message}`); }
}
// Self-test: the ported rule must actually reject the retired V3 wrapper and the
// empty kind. Without this, a transcription slip could make every assertion below
// pass vacuously — the exact failure mode that let the P0 ship in the first place.
assert.throws(() => v4Source({ source: { kind: 'plugin', plugin: 'evolver-paper-commands' } }),
  /format v4 message requires a producer-owned source kind/, 'the ported rule must reject the V3 plugin wrapper');
assert.throws(() => v4Source({ source: { kind: '' } }), /producer-owned source kind/, 'the ported rule must reject an empty kind');
assert.doesNotThrow(() => v4Source({ source: { kind: 'plugin:evolver-paper-commands' } }), 'the ported rule must admit the canonical producer kind');
assert.doesNotThrow(() => v4Source({ source: { kind: 'skill-invocation', name: 'x', form: 'instructions' } }), 'the ported rule must admit first-party kinds');

/** Messages a step ADDS beyond the batch it claimed — i.e. the injections. */
function injectedBy(decision: PreStepDecision, claimed: readonly unknown[]): unknown[] {
  return decision.messages.slice(claimed.length);
}

/** Register the real skills into a real SkillRegistry, so loading is genuinely exercised. */
function skillRegistry(): { ctx: Context; registry: SkillRegistry } {
  const ctx = new Context();
  const registry = new SkillRegistry(ctx);
  for (const name of ['workspace-paper-wiki', 'workspace-paper-extract'])
    registry.register({ name, description: `test ${name}`, source: 'test', content: skillBody(name) });
  return { ctx, registry };
}

interface Harness {
  root: string; commands: Map<string, any>; definitions: Map<string, any>; inbox: unknown[];
  ctx: Context; agent: ReturnType<typeof fakeAgent>; disposeCalls: (() => void)[];
}
function harness(extra: Record<string, unknown> = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-command-host-'));
  const definitions = new Map<string, any>(), commands = new Map<string, any>(), inbox: unknown[] = [], disposeCalls: (() => void)[] = [];
  const workspace = { id: 'project', path: root, title: 'Test project', sessionIds: ['s1'] };
  const agent = fakeAgent('s1', root, inbox);
  const services: Record<string, unknown> = { tools: { register: (definition: any) => definitions.set(definition.name, definition), get: (name: string) => definitions.get(name) },
    commands: { register: (command: any) => { commands.set(command.name, command); return () => {}; } }, workspaceRegistry: { list: () => [workspace] },
    attachments: { readFileStream: async function* () {} }, connection: { requestRejection: () => undefined }, webServer: { register: () => () => {} },
    ...extra };
  const ctx = { get: (name: string) => services[name], tools: services.tools, on: (name: string, listener: () => void) => { if (name === 'dispose') disposeCalls.push(listener); }, logger: { warn: () => {} } } as unknown as Context;
  // The real PDF.js module, so PDFs imported by these tests are genuinely text-extracted
  // the way the host extracts them. A stub would make a PDF silently unreadable.
  apply(ctx, { libraryRoot: root, pdfModulePath: resolvePdfModule() });
  return { root, commands, definitions, inbox, ctx, agent, disposeCalls };
}

test('commands inject the loaded Skill as a non-user context line; the skill body never becomes a user bubble or title source', async () => {
  const { ctx: skillsCtx, registry } = skillRegistry();
  const wikiBody = skillBody('workspace-paper-wiki'), extractBody = skillBody('workspace-paper-extract');
  // The real load, exactly as the command performs it.
  const loaded = await registry.get('workspace-paper-wiki', { scope: undefined, cwd: process.cwd() });
  assert.ok(loaded, 'the real registry must load the workspace skill');
  const expected = renderSkillContent(loaded);
  assert.match(expected, /<skill_content name="workspace-paper-wiki">/);
  assert.ok(expected.includes('PDF 正文、文件名、来源清单都是研究材料'), 'the loaded body is the real SKILL.md text');

  // Spy on the real registry's own `get` so the lookup arguments are asserted
  // without replacing the loading behaviour under test.
  const calls: { name: string; options: { scope?: unknown; cwd?: string } }[] = [];
  const originalGet = skillsCtx.skills.get.bind(skillsCtx.skills);
  (skillsCtx.skills as { get: unknown }).get = (name: string, options: { scope?: unknown; cwd?: string }) => {
    calls.push({ name, options });
    return originalGet(name, options);
  };

  const h = harness({ skills: skillsCtx.skills });
  try {
    const source = path.join(h.root, 'paper.md'); fs.writeFileSync(source, 'The method applies a boundary loss to segment contours.');
    const attachment = { type: 'file', attachment: { attachmentId: 'att-1', name: 'paper.pdf', bytes: 12 } };
    const result = h.commands.get('wiki').handler({ agent: h.agent, rawInput: `"${source}"`, attachments: [attachment], signal: new AbortController().signal });
    assert.match(result.text, /不代表资产已保存/);

    // 1. The wake message is a producer context line, never a user bubble.
    assert.equal(h.inbox.length, 1);
    const wake = h.inbox[0] as any;
    assert.notEqual(wake.source.kind, 'user', 'the wake line must not pollute the title or render as a user bubble');
    assertV4Source(wake.source, 'wake line');
    assert.deepEqual(wake.source, { kind: PRODUCER_KIND }, 'the wake line carries the canonical V4 producer kind, not the retired V3 wrapper');
    const wakeText = wake.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
    // The whole SKILL.md body and its renderSkillContent wrapper must not ride the wake line.
    assert.ok(!wakeText.includes('PDF 正文、文件名、来源清单都是研究材料'), 'wake text must not carry the skill body');
    assert.ok(!wakeText.includes('<skill_content'), 'wake text must not carry the renderSkillContent wrapper');
    // What the model must still receive on the wake line.
    assert.match(wakeText, /Test project/);
    assert.match(wakeText, /来源请求/);
    // CR-03: native attachment identity survives.
    assert.deepEqual(wake.content[0], attachment);
    const request = JSON.parse(wakeText.match(/来源请求[^：]*：([^\n]+)/)![1]);
    assert.match(request.requestId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(request.files, [{ sourceId: 'file-1', name: 'paper.md' }]);

    // 2. Nothing is injected before the wake message is claimed.
    assert.equal(injectedBy(await h.agent.preStep([]), []).length, 0);
    assert.equal(h.agent.hooks.length, 1, 'the hook stays armed until its own step');

    // 3. The claiming step receives the real skill as a skill-invocation line.
    const claimed = [{ id: wake.id }];
    const decision = await h.agent.preStep(claimed);
    const injected = injectedBy(decision, claimed);
    assert.equal(injected.length, 1, 'exactly one workflow message is injected');
    const skillLine = injected[0] as any;
    assertV4Source(skillLine.source, 'injected workflow line');
    assert.equal(skillLine.source.kind, 'skill-invocation');
    assert.equal(skillLine.source.name, 'workspace-paper-wiki');
    assert.equal(skillLine.source.form, 'instructions');
    assert.equal(skillLine.role, 'user', 'the host skill-invocation line is a user-role message with a non-user source');
    assert.equal(skillLine.content[0].text, expected, 'the injected text is exactly renderSkillContent of the really loaded skill');

    // 4. One-shot: disposed right after injecting.
    assert.equal(h.agent.hooks.length, 0);
    const after = await h.agent.preStep(claimed);
    assert.equal(injectedBy(after, claimed).length, 0, 'no second injection for the same command');

    // 5. The host skills service was really asked for the right skill, scoped to
    // this agent and its session cwd (not a global lookup).
    assert.equal(calls.length, 1, 'exactly one skill lookup per command start');
    assert.equal(calls[0].name, 'workspace-paper-wiki');
    assert.equal(calls[0].options.scope, h.agent, 'the lookup is scoped to the invoking Agent');
    assert.equal(calls[0].options.cwd, h.root, 'the lookup uses the session cwd');
    assert.ok(!extractBody.includes('PDF 正文、文件名、来源清单都是研究材料'));
    assert.notEqual(expected, extractBody);
  } finally { fs.rmSync(h.root, { recursive: true }); }
});

test('cancelled, failed, disposed and other-agent workflows never inject', async () => {
  const { ctx: skillsCtx, registry } = skillRegistry();
  const wikiBody = skillBody('workspace-paper-wiki');

  // Cancellation before the step boundary disarms the hook and injects nothing.
  const cancelled = harness({ skills: skillsCtx.skills });
  try {
    const abort = new AbortController();
    cancelled.commands.get('wiki').handler({ agent: cancelled.agent, rawInput: '全部论文', attachments: [], signal: abort.signal });
    abort.abort(new Error('user cancelled'));
    const claimed = [{ id: (cancelled.inbox[0] as any).id }];
    const decision = await cancelled.agent.preStep(claimed);
    assert.equal(injectedBy(decision, claimed).length, 0, 'a cancelled command injects nothing');
    assert.equal(cancelled.agent.hooks.length, 0, 'cancellation removes the hook');
  } finally { fs.rmSync(cancelled.root, { recursive: true }); }

  // The command's own step signal being aborted also suppresses injection.
  const abortedStep = harness({ skills: skillsCtx.skills });
  try {
    abortedStep.commands.get('wiki').handler({ agent: abortedStep.agent, rawInput: '全部论文', attachments: [], signal: new AbortController().signal });
    const controller = new AbortController(); controller.abort(new Error('turn aborted'));
    const claimed = [{ id: (abortedStep.inbox[0] as any).id }];
    const decision = await abortedStep.agent.preStep(claimed, controller.signal);
    assert.equal(injectedBy(decision, claimed).length, 0, 'an aborted step injects nothing');
    assert.equal(abortedStep.agent.hooks.length, 0);
  } finally { fs.rmSync(abortedStep.root, { recursive: true }); }

  // Plugin dispose removes the hook and no later step can inject.
  const disposed = harness({ skills: skillsCtx.skills });
  try {
    disposed.commands.get('wiki').handler({ agent: disposed.agent, rawInput: '全部论文', attachments: [], signal: new AbortController().signal });
    for (const listener of disposed.disposeCalls) listener();
    assert.equal(disposed.agent.hooks.length, 0, 'ctx dispose removes the hook');
    const claimed = [{ id: (disposed.inbox[0] as any).id }];
    const decision = await disposed.agent.preStep(claimed);
    assert.equal(injectedBy(decision, claimed).length, 0, 'a disposed plugin injects nothing');
  } finally { fs.rmSync(disposed.root, { recursive: true }); }

  // Another agent in the same workspace shares assets but not workflow context.
  const shared = harness({ skills: skillsCtx.skills });
  try {
    const other = fakeAgent('s2', shared.root, []);
    shared.commands.get('wiki').handler({ agent: shared.agent, rawInput: '全部论文', attachments: [], signal: new AbortController().signal });
    const wakeId = (shared.inbox[0] as any).id;
    const own = await shared.agent.preStep([{ id: wakeId }]);
    assert.equal((injectedBy(own, [{ id: wakeId }])[0] as any).source.kind, 'skill-invocation');
    // The other agent has no hook at all, so the same message id injects nothing there.
    assert.equal(other.hooks.length, 0, 'workflow hooks are per-agent, never global');
    const claimed = [{ id: wakeId }];
    const foreign = await other.preStep(claimed);
    assert.equal(injectedBy(foreign, claimed).length, 0);
  } finally { fs.rmSync(shared.root, { recursive: true }); }

  // A user cancel clears the Agent inbox without aborting the command's RPC
  // signal (verified in dsh-client-connection: the request abort only fires on a
  // client disconnect before the response completes). The discarded wake message
  // must therefore disarm the hook on its own.
  const cancelledTurn = harness({ skills: skillsCtx.skills });
  try {
    cancelledTurn.commands.get('wiki').handler({ agent: cancelledTurn.agent, rawInput: '全部论文', attachments: [], signal: new AbortController().signal });
    assert.equal(cancelledTurn.agent.hooks.length, 1);
    cancelledTurn.agent.cancel();
    const claimed = [{ id: 'unrelated-step' }];
    const decision = await cancelledTurn.agent.preStep(claimed);
    assert.equal(injectedBy(decision, claimed).length, 0);
    assert.equal(cancelledTurn.agent.hooks.length, 0, 'a discarded wake message disarms the hook');
  } finally { fs.rmSync(cancelledTurn.root, { recursive: true }); }

  // An Agent without a readable inbox must NOT be treated as cancelled: the hook
  // stays armed until its own message is claimed.
  const noInboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-command-noinbox-'));
  try {
    const definitions = new Map<string, any>(), commands = new Map<string, any>(), queued: unknown[] = [];
    const workspace = { id: 'project', path: noInboxRoot, title: 'Test project', sessionIds: ['s1'] };
    const agent = fakeAgent('s1', noInboxRoot, queued, { withInbox: false });
    const services: Record<string, unknown> = { skills: skillsCtx.skills, tools: { register: (definition: any) => definitions.set(definition.name, definition), get: (name: string) => definitions.get(name) },
      commands: { register: (command: any) => { commands.set(command.name, command); return () => {}; } }, workspaceRegistry: { list: () => [workspace] },
      attachments: { readFileStream: async function* () {} }, connection: { requestRejection: () => undefined }, webServer: { register: () => () => {} } };
    const ctx = { get: (name: string) => services[name], tools: services.tools, on: () => {}, logger: { warn: () => {} } } as unknown as Context;
    apply(ctx, { libraryRoot: noInboxRoot, pdfModulePath: 'not-used-for-md' });
    commands.get('wiki').handler({ agent, rawInput: '全部论文', attachments: [], signal: new AbortController().signal });
    const wakeId = (queued[0] as any).id;
    const unrelated = [{ id: 'unrelated-step' }];
    const decision = await agent.preStep(unrelated);
    assert.equal(injectedBy(decision, unrelated).length, 0);
    assert.equal(agent.hooks.length, 1, 'absent inbox capability must not disarm a valid command');
    const claimedOwn = [{ id: wakeId }];
    const own = await agent.preStep(claimedOwn);
    assert.equal((injectedBy(own, claimedOwn)[0] as any).source.kind, 'skill-invocation', 'the valid command still injects at its own step');
  } finally { fs.rmSync(noInboxRoot, { recursive: true }); }

  // Without a skills service the fallback injects SKILL.md text as a producer
  // context line, and must not claim to be a host skill-invocation.
  const fallback = harness();
  try {
    fallback.commands.get('wiki').handler({ agent: fallback.agent, rawInput: '全部论文', attachments: [], signal: new AbortController().signal });
    const claimed = [{ id: (fallback.inbox[0] as any).id }];
    const decision = await fallback.agent.preStep(claimed);
    const injected = injectedBy(decision, claimed);
    assert.equal(injected.length, 1);
    const line = injected[0] as any;
    assertV4Source(line.source, 'file fallback line');
    assert.equal(line.source.kind, PRODUCER_KIND, 'the file fallback must not impersonate skill-invocation');
    assert.notEqual(line.source.kind, 'skill-invocation', 'without the host registry this plugin cannot claim a real skill load');
    assert.equal(line.content[0].text, wikiBody, 'the fallback injects the SKILL.md body');
    assert.ok(!line.content[0].text.includes('description:'), 'frontmatter is not leaked into the model context');
  } finally { fs.rmSync(fallback.root, { recursive: true }); }

  // The degraded notice (no skills service AND no readable SKILL.md) cannot be
  // reached from inside this checkout, because the module's own fallback root
  // resolves to the repo's real `.dsh/skills/<name>/SKILL.md`. Rather than
  // pretend to execute it, guard the invariant at the source level: every
  // message source this adapter constructs must be either the canonical V4
  // producer kind or a first-party kind it is entitled to emit, and no V3
  // `plugin` wrapper may exist anywhere in the file. This covers the notice too.
  const adapterSource = fs.readFileSync(
    path.join(process.cwd(), 'packages', 'evolver', 'src', 'adapters', 'dsh', 'paper-commands.ts'), 'utf8');
  const sourceLiterals = [...adapterSource.matchAll(/source:\s*\{\s*kind:\s*(?:'([^']*)'|([A-Z_]+))/g)]
    .map((match) => match[1] ?? match[2]);
  assert.ok(sourceLiterals.length >= 3, 'the adapter must construct its context lines with explicit source kinds');
  assert.ok(!sourceLiterals.includes('plugin'), "no message source may use the retired V3 'plugin' kind");
  assert.deepEqual([...new Set(sourceLiterals)].sort(), ['PRODUCER_KIND', 'skill-invocation'],
    'every constructed source kind is either this plugin\'s V4 producer kind or the first-party skill-invocation kind');
  assert.equal(PRODUCER_KIND, 'plugin:evolver-paper-commands');
});

test('native commands keep tool preflight, source receipts and scoped publishers preserving the other asset', async () => {
  const { ctx: skillsCtx } = skillRegistry();
  const h = harness({ skills: skillsCtx.skills });
  try {
    assert.deepEqual([...h.commands.keys()], ['wiki', 'extract']);
    const source = path.join(h.root, 'paper.md'); fs.writeFileSync(source, 'The method applies a boundary loss to segment contours.');
    h.commands.get('wiki').handler({ agent: h.agent, rawInput: `"${source}"`, attachments: [], signal: new AbortController().signal });
    const wake = h.inbox[0] as any;
    // The wake line names the command and carries the admitted source refs; the
    // skill name and body arrive only in the injected workflow line.
    assert.match(wake.content.at(-1).text, /用户已执行 \/wiki/);
    assert.ok(!wake.content.at(-1).text.includes('workspace-paper-wiki'), 'the wake line must not name or embed the skill');
    const request = JSON.parse(wake.content.at(-1).text.match(/来源请求[^：]*：([^\n]+)/)![1]);
    const exec = { agent: h.agent } as any;
    const imported = await h.definitions.get('evolver_import_paper_source').execute({ requestId: request.requestId, sourceId: 'file-1' }, exec);
    const wiki = await h.definitions.get('evolver_publish_paper_wiki').execute({ paperId: imported.paperId, title: 'Boundary method', sections: [{ heading: 'Method', summary: 'Boundary loss.', page: 1, quote: 'applies a boundary loss' }] }, exec);
    const component = { kind: 'Module', name: 'Boundary loss', description: 'Contour loss.', page: 1, quote: 'boundary loss to segment contours' };
    const extracted = await h.definitions.get('evolver_publish_paper_components').execute({ paperId: imported.paperId, baseRevision: wiki.revision, components: [component] }, exec);
    assert.equal(extracted.wikiSections, 1); assert.equal(extracted.components, 1);
    const updated = await h.definitions.get('evolver_publish_paper_wiki').execute({ paperId: imported.paperId, baseRevision: extracted.revision, title: 'Updated Wiki', sections: [{ heading: 'Method', summary: 'Updated explanation.', page: 1, quote: 'applies a boundary loss' }] }, exec);
    assert.equal(updated.components, 1);
    assert.equal(workspacePaperLibrary({ id: 'project', path: h.root, title: 'Test project', sessionIds: ['s1'] }).get(h.root, imported.paperId).sections[0].summary, 'Updated explanation.');
    await assert.rejects(() => h.definitions.get('evolver_publish_paper_components').execute({ paperId: imported.paperId, baseRevision: wiki.revision, components: [] }, exec), /REVISION_CONFLICT/);
    h.commands.get('extract').handler({ agent: h.agent, rawInput: imported.paperId, attachments: [], signal: new AbortController().signal });
    const extractWake = h.inbox[1] as any;
    assert.match(extractWake.content.at(-1).text, /用户已执行 \/extract/);
    const extractClaimed = [{ id: extractWake.id }];
    const extractDecision = await h.agent.preStep(extractClaimed);
    assert.equal((injectedBy(extractDecision, extractClaimed)[0] as any).source.name, 'workspace-paper-extract');
    h.definitions.delete('evolver_publish_paper_wiki');
    assert.throws(() => h.commands.get('wiki').handler({ agent: h.agent, rawInput: '', attachments: [], signal: new AbortController().signal }), /RESEARCH_TOOLS_UNAVAILABLE/);
    assert.equal(h.inbox.length, 2, 'a failed preflight queues no wake message');
  } finally { fs.rmSync(h.root, { recursive: true }); }
});

// ---------------------------------------------------------------------------
// WF-03/04/08/12/15 — the durable run record and its lifecycle
// ---------------------------------------------------------------------------

/** The command-runs sidecar, read straight off disk (the same files the UI route reads). */
function runsIn(root: string) {
  const store = new PaperCommandRunStore(root);
  return store.list();
}

/** Drive one command to a real workflow: wake queued, then claimed and injected. */
async function drive(h: Harness, command: 'wiki' | 'extract', rawInput: string, index: number, signal: AbortSignal) {
  h.commands.get(command).handler({ agent: h.agent, rawInput, attachments: [], signal });
  const wake = h.inbox[index] as any;
  await h.agent.preStep([{ id: wake.id }]);
  return wake;
}

/** The admitted source request the wake line carries, as the Agent parses it. */
function sourceRequest(wake: any): { requestId: string; files: Array<{ sourceId: string; name: string }> } {
  return JSON.parse(wake.content.at(-1).text.match(/来源请求[^：]*：([^\n]+)/)![1]);
}

/** A tiny real PDF whose text is extractable, so the default workspace sweep matches it. */
function buildPdf(text: string): Buffer {
  const content = `BT /F1 11 Tf 60 740 Td 14 TL\n(${text.replace(/([()\\])/g, '\\$1')}) Tj T*\nET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; }
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** A minimal ServerResponse stand-in, capturing exactly what the route writes. */
function response() {
  let body = '';
  const res = {
    statusCode: 0, headers: {} as Record<string, string>, ended: false,
    setHeader(name: string, value: string) { res.headers[name] = value; },
    end(chunk?: string) { body = chunk ?? ''; res.ended = true; },
    get body() { return body; },
  };
  return res;
}

test('WF-03/WF-08: an unfinished run is never reported as completed — it records INCOMPLETE_OUTPUT', async () => {
  const { ctx: skillsCtx } = skillRegistry();
  const h = harness({ skills: skillsCtx.skills });
  try {
    const source = path.join(h.root, 'paper.md'); fs.writeFileSync(source, 'The method applies a boundary loss to segment contours.');
    h.commands.get('wiki').handler({ agent: h.agent, rawInput: `"${source}"`, attachments: [], signal: new AbortController().signal });
    const [run] = runsIn(h.root);
    assert.equal(run.command, 'wiki');
    assert.equal(run.status, 'pending', 'the run starts at the command boundary, not at the handler return');
    assert.equal(run.targets.length, 1, 'the admitted source file is frozen as exactly one target');
    assert.equal(run.targets[0].sourceSha256, null, 'a not-yet-imported target has no claimed source hash');

    // The workflow ran, but the Agent stopped after reading without publishing.
    h.agent.running();
    h.agent.idle();
    const [closed] = runsIn(h.root);
    assert.equal(closed.status, 'failed', 'an agent that stopped without publishing cannot be completed');
    assert.equal(closed.finishedAt !== null, true);
    assert.equal(closed.targets[0].outcome, 'failed');
    assert.equal(closed.targets[0].error?.code, 'INCOMPLETE_OUTPUT');
    assert.equal(closed.targets[0].publishAttempts, 0, 'nothing was published, so nothing is claimed as attempted');
    assert.equal(closed.targets[0].wikiSections, 0);
    // §7: the page reads this from the sidecar, and the route must expose it.
    assert.equal(JSON.stringify(closed).includes(process.cwd()), false, 'no absolute path leaks into the record');
  } finally { fs.rmSync(h.root, { recursive: true }); }
});

test('WF-03: /extract records a components-only success with no Wiki sections and no Wiki file', async () => {
  const { ctx: skillsCtx } = skillRegistry();
  const h = harness({ skills: skillsCtx.skills });
  try {
    const source = path.join(h.root, 'paper.md'); fs.writeFileSync(source, 'The method applies a boundary loss to segment contours.');
    const exec = { agent: h.agent } as any;
    // No Wiki first: the whole point of this round is that /extract does not need one.
    await drive(h, 'extract', `"${source}"`, 0, new AbortController().signal);
    const request = sourceRequest(h.inbox[0]);
    const paper = await h.definitions.get('evolver_import_paper_source').execute({ requestId: request.requestId, sourceId: request.files[0].sourceId }, exec);
    const published = await h.definitions.get('evolver_publish_paper_components').execute(
      { paperId: paper.paperId, components: [{ kind: 'Module', name: 'Boundary loss', description: 'Contour loss.', page: 1, quote: 'boundary loss to segment contours' }] }, exec);
    assert.equal(published.wikiSections, 0, 'a components-first paper really has zero Wiki sections');

    h.agent.running();
    h.agent.idle();
    const [run] = runsIn(h.root);
    assert.equal(run.status, 'completed', 'every target was published and re-read, so the batch completes');
    const target = run.targets[0];
    assert.equal(target.paperId, paper.paperId);
    assert.equal(target.outcome, 'saved');
    assert.equal(target.components, 1);
    assert.equal(target.wikiSections, 0);
    assert.equal(target.publishAttempts, 1, 'one publish call, one attempt');
    assert.equal(target.verifiedRevision, published.revision);
    assert.equal(typeof target.verifiedOutputHash, 'string');
    assert.equal(target.error, undefined);
    // WF-03: no placeholder Wiki and no fake Wiki markdown anywhere in this workspace.
    const papersFolder = path.join(h.root, '.dsh', 'research', 'papers');
    const wikiFiles = fs.existsSync(papersFolder)
      ? fs.readdirSync(papersFolder).filter((name) => name.includes(`${paper.paperId}.wiki-`))
      : [];
    assert.deepEqual(wikiFiles, [], `a components-only publish writes no Wiki markdown: ${wikiFiles.join(',')}`);
  } finally { fs.rmSync(h.root, { recursive: true }); }
});

test('WF-10/WF-11: a legal empty result records no_findings; clearing existing components is refused', async () => {
  const { ctx: skillsCtx } = skillRegistry();
  const h = harness({ skills: skillsCtx.skills });
  try {
    const source = path.join(h.root, 'paper.md'); fs.writeFileSync(source, 'The method applies a boundary loss to segment contours.');
    const exec = { agent: h.agent } as any;
    await drive(h, 'extract', `"${source}"`, 0, new AbortController().signal);
    const request = sourceRequest(h.inbox[0]);
    const paper = await h.definitions.get('evolver_import_paper_source').execute({ requestId: request.requestId, sourceId: request.files[0].sourceId }, exec);
    const first = await h.definitions.get('evolver_publish_paper_components').execute(
      { paperId: paper.paperId, components: [{ kind: 'Module', name: 'Boundary loss', description: 'Contour loss.', page: 1, quote: 'boundary loss to segment contours' }] }, exec);

    // WF-11: an empty array after components exist is refused, and nothing is cleared.
    await assert.rejects(() => h.definitions.get('evolver_publish_paper_components').execute(
      { paperId: paper.paperId, baseRevision: first.revision, components: [] }, exec), /COMPONENT_CLEAR_REFUSED/);
    // WF-10: an empty array with a reason, on a paper that has no components yet, is a legal no_findings.
    const other = path.join(h.root, 'other.md'); fs.writeFileSync(other, 'A second source with no independent components at all.');
    await drive(h, 'extract', `"${other}"`, 1, new AbortController().signal);
    const secondRequest = sourceRequest(h.inbox[1]);
    const blank = await h.definitions.get('evolver_import_paper_source').execute({ requestId: secondRequest.requestId, sourceId: secondRequest.files[0].sourceId }, exec);
    const none = await h.definitions.get('evolver_publish_paper_components').execute(
      { paperId: blank.paperId, components: [], noFindingsReason: '本范围无可独立抽取的组件。' }, exec);
    assert.equal(none.components, 0);
    h.agent.running(); h.agent.idle();
    const runs = runsIn(h.root);
    const withFindings = runs.find((r) => r.targets.some((t) => t.paperId === paper.paperId));
    const noFindings = runs.find((r) => r.targets.some((t) => t.paperId === blank.paperId));
    assert.equal(withFindings?.targets.find((t) => t.paperId === paper.paperId)?.outcome, 'saved');
    const target = noFindings?.targets.find((t) => t.paperId === blank.paperId)!;
    assert.equal(target.outcome, 'no_findings', 'a reason-backed empty result is no_findings, not a silent success');
    assert.equal(target.noFindingsReason, '本范围无可独立抽取的组件。');
    assert.equal(target.components, 0);
    // WF-11: the refused clear left the earlier components intact.
    assert.equal(workspacePaperLibrary({ id: 'project', path: h.root, title: 'Test project', sessionIds: ['s1'] }).get(h.root, paper.paperId).components.length, 1);
  } finally { fs.rmSync(h.root, { recursive: true }); }
});

test('WF-10/WF-20: no_findings without a reason is refused with zero writes; a failed publish records the error, not a success', async () => {
  const { ctx: skillsCtx } = skillRegistry();
  const h = harness({ skills: skillsCtx.skills });
  try {
    const source = path.join(h.root, 'paper.md'); fs.writeFileSync(source, 'The method applies a boundary loss to segment contours.');
    const exec = { agent: h.agent } as any;
    await drive(h, 'extract', `"${source}"`, 0, new AbortController().signal);
    const request = sourceRequest(h.inbox[0]);
    const paper = await h.definitions.get('evolver_import_paper_source').execute({ requestId: request.requestId, sourceId: request.files[0].sourceId }, exec);
    // An empty array with no reason must be refused: [] is never a success by itself.
    await assert.rejects(() => h.definitions.get('evolver_publish_paper_components').execute(
      { paperId: paper.paperId, components: [] }, exec), /NO_FINDINGS_REASON_REQUIRED/);
    // A bad quote is refused by the evidence check, and the failure is recorded on the target.
    await assert.rejects(() => h.definitions.get('evolver_publish_paper_components').execute(
      { paperId: paper.paperId, components: [{ kind: 'Module', name: 'X', description: 'd', page: 1, quote: 'a quote that is nowhere in the source' }] }, exec), /EVIDENCE_MISMATCH/);

    h.agent.running(); h.agent.idle();
    const [run] = runsIn(h.root);
    assert.equal(run.status, 'failed', 'no target reached a verified result, so the batch failed');
    const target = run.targets[0];
    assert.equal(target.outcome, 'failed');
    assert.equal(target.components, 0, 'a rejected publish leaves nothing stored');
    assert.equal(target.verifiedOutputHash, null, 'nothing was verified');
    assert.equal(target.error?.code, 'EVIDENCE_MISMATCH', 'the model-visible diagnostic code is what the page needs');
    assert.ok((target.error?.message ?? '').includes('EVIDENCE_MISMATCH'), 'dsh-tools shows only the message, so the code must be in the text');
  } finally { fs.rmSync(h.root, { recursive: true }); }
});

test('WF-06/WF-12: a partial batch keeps successes, reports the failure separately and never rolls back', async () => {
  const { ctx: skillsCtx } = skillRegistry();
  const h = harness({ skills: skillsCtx.skills });
  try {
    const directory = path.join(h.root, 'batch'); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'a.md'), 'First source with a boundary loss to segment contours.');
    fs.writeFileSync(path.join(directory, 'b.md'), 'Second source with a different separable structure entirely.');
    const exec = { agent: h.agent } as any;
    await drive(h, 'extract', `"${directory}"`, 0, new AbortController().signal);
    const request = sourceRequest(h.inbox[0]);
    assert.equal(request.files.length, 2, 'both files are frozen as separate targets');
    const papers = [];
    for (const file of request.files) papers.push(await h.definitions.get('evolver_import_paper_source').execute({ requestId: request.requestId, sourceId: file.sourceId }, exec));
    // Paper A publishes, paper B's quote does not verify.
    await h.definitions.get('evolver_publish_paper_components').execute(
      { paperId: papers[0].paperId, components: [{ kind: 'Module', name: 'Boundary loss', description: 'Contour loss.', page: 1, quote: 'boundary loss to segment contours' }] }, exec);
    await assert.rejects(() => h.definitions.get('evolver_publish_paper_components').execute(
      { paperId: papers[1].paperId, components: [{ kind: 'Module', name: 'Nope', description: 'd', page: 1, quote: 'a quote absent from this source' }] }, exec), /EVIDENCE_MISMATCH/);

    h.agent.running(); h.agent.idle();
    const [run] = runsIn(h.root);
    assert.equal(run.status, 'partial', '8-succeeded/2-failed batches report partial, never completed');
    assert.equal(run.targets.length, 2);
    const saved = run.targets.filter((t) => t.outcome === 'saved');
    const failed = run.targets.filter((t) => t.outcome === 'failed');
    assert.equal(saved.length, 1);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].error?.code, 'EVIDENCE_MISMATCH');
    // WF-12: the saved target keeps its components; the failure did not roll it back.
    const library = workspacePaperLibrary({ id: 'project', path: h.root, title: 'Test project', sessionIds: ['s1'] });
    assert.equal(library.get(h.root, papers[0].paperId).components.length, 1);
    assert.equal(library.get(h.root, papers[1].paperId).components.length, 0);
  } finally { fs.rmSync(h.root, { recursive: true }); }
});

test('repeated discovery preserves one target per source and binds reverse-order imports correctly', async () => {
  const { ctx: skillsCtx } = skillRegistry();
  const h = harness({ skills: skillsCtx.skills });
  try {
    const directory = path.join(h.root, 'batch'); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'a.md'), 'First paper with a boundary loss to segment contours.');
    fs.writeFileSync(path.join(directory, 'b.md'), 'Second paper with a separable structure.');
    const exec = { agent: h.agent } as any;
    await drive(h, 'extract', `"${directory}"`, 0, new AbortController().signal);
    const frozen = runsIn(h.root)[0];
    const discover = () => h.definitions.get('evolver_discover_paper_sources').execute({ path: directory }, exec);
    const discovered = await discover();
    await discover();
    assert.equal(runsIn(h.root)[0].targets.length, 2, 'new receipts must not double the declared batch');
    const imported = [];
    for (const file of [...discovered.files].reverse()) {
      imported.push(await h.definitions.get('evolver_import_paper_source').execute({ requestId: discovered.requestId, sourceId: file.sourceId }, exec));
    }
    const after = runsIn(h.root)[0];
    assert.equal(after.targets[0].targetId, frozen.targets[0].targetId);
    assert.equal(after.targets[0].paperId, imported[1].paperId, 'file A must not bind to the first imported file B');
    assert.equal(after.targets[1].paperId, imported[0].paperId);
    assert.equal(JSON.stringify(after).includes(directory), false, 'stable identities must not expose local paths');

    // A refused import is also associated with its own source rather than the first unbound one.
    h.agent.running(); h.agent.idle();
    await drive(h, 'extract', `"${directory}"`, 1, new AbortController().signal);
    const request = sourceRequest(h.inbox[1]);
    fs.writeFileSync(path.join(directory, 'b.md'), 'Changed after admission, refuse this file.');
    await assert.rejects(() => h.definitions.get('evolver_import_paper_source').execute({ requestId: request.requestId, sourceId: request.files[1].sourceId }, exec), /SOURCE_CHANGED/);
    const failed = runsIn(h.root).find(r => r.runId !== frozen.runId)!;
    assert.equal(failed.targets[0].outcome, 'pending');
    assert.equal(failed.targets[1].error?.code, 'SOURCE_CHANGED');
  } finally { fs.rmSync(h.root, { recursive: true }); }
});

test('discovery outside a declared source cannot enlarge the frozen run or bind unrelated failures', async () => {
  const { ctx: skillsCtx } = skillRegistry(); const h = harness({ skills: skillsCtx.skills });
  try {
    const chosen = path.join(h.root, 'chosen.md'), other = path.join(h.root, 'other.md');
    fs.writeFileSync(chosen, 'The chosen paper describes a boundary loss to segment contours.');
    fs.writeFileSync(other, 'An unrelated source with a separable structure.');
    const exec = { agent: h.agent } as any;
    await drive(h, 'extract', `"${chosen}"`, 0, new AbortController().signal);
    const frozen = runsIn(h.root)[0];
    const discovered = await h.definitions.get('evolver_discover_paper_sources').execute({ path: other }, exec);
    assert.equal(runsIn(h.root)[0].targets.length, 1, 'a broad or unrelated discovery cannot expand user scope');
    const imported = await h.definitions.get('evolver_import_paper_source').execute({ requestId: discovered.requestId, sourceId: discovered.files[0].sourceId }, exec);
    await h.definitions.get('evolver_read_uploaded_paper').execute({ paperId: imported.paperId }, exec);
    await assert.rejects(() => h.definitions.get('evolver_publish_paper_components').execute({ paperId: imported.paperId, components: [] }, exec), /NO_FINDINGS_REASON_REQUIRED/);
    const after = runsIn(h.root)[0];
    assert.equal(after.targets[0].targetId, frozen.targets[0].targetId);
    assert.equal(after.targets[0].paperId, null);
    assert.equal(after.targets[0].publishAttempts, 0);
    assert.deepEqual(after.targets[0].readPages, []);
    assert.equal(after.targets[0].error, undefined);
  } finally { fs.rmSync(h.root, { recursive: true }); }
});

test('identical-content files each bind to the shared asset and receive verified results', async () => {
  const { ctx: skillsCtx } = skillRegistry(); const h = harness({ skills: skillsCtx.skills });
  try {
    const batch = path.join(h.root, 'duplicates'); fs.mkdirSync(batch);
    for (const name of ['a.md', 'b.md']) fs.writeFileSync(path.join(batch, name), 'A method applies a boundary loss to segment contours.');
    const exec = { agent: h.agent } as any;
    await drive(h, 'extract', `"${batch}"`, 0, new AbortController().signal);
    const request = sourceRequest(h.inbox[0]);
    const imported = [];
    for (const file of request.files) imported.push(await h.definitions.get('evolver_import_paper_source').execute({ requestId: request.requestId, sourceId: file.sourceId }, exec));
    assert.equal(imported[0].paperId, imported[1].paperId);
    assert.ok(runsIn(h.root)[0].targets.every(t => t.paperId === imported[0].paperId));
    await h.definitions.get('evolver_read_uploaded_paper').execute({ paperId: imported[0].paperId }, exec);
    await h.definitions.get('evolver_publish_paper_components').execute({ paperId: imported[0].paperId, components: [{ kind: 'Module', name: 'Boundary', description: 'Source method.', page: 1, quote: 'boundary loss to segment contours' }] }, exec);
    h.agent.running(); h.agent.idle();
    const run = runsIn(h.root)[0];
    assert.equal(run.status, 'completed');
    assert.ok(run.targets.every(t => t.outcome === 'saved' && t.verifiedRevision && t.readPages.length === 1));
  } finally { fs.rmSync(h.root, { recursive: true }); }
});

test('an explicit re-run binds existing assets without requiring discovery or re-import', async () => {
  const { ctx: skillsCtx } = skillRegistry(); const h = harness({ skills: skillsCtx.skills });
  try {
    const source = path.join(h.root, 'paper.md'), text = 'A method applies a boundary loss to segment contours.';
    fs.writeFileSync(source, text);
    const library = workspacePaperLibrary({ id: 'project', path: h.root, title: 'Test', sessionIds: ['s1'] });
    const imported = library.import(h.root, 'paper.md', Buffer.from(text), [text]);
    const saved = library.publish(h.root, imported.id, { baseRevision: null, title: 'Paper', sections: [], components: [{ kind: 'Module', name: 'Boundary', description: 'Loss.', page: 1, quote: 'boundary loss to segment contours' }], submitted: 'components' });
    await drive(h, 'extract', `"${source}"`, 0, new AbortController().signal);
    await h.definitions.get('evolver_read_uploaded_paper').execute({ paperId: saved.id }, { agent: h.agent } as any);
    h.agent.running(); h.agent.idle();
    const run = runsIn(h.root)[0];
    assert.equal(run.status, 'completed');
    assert.equal(run.targets[0].paperId, saved.id);
    assert.equal(run.targets[0].outcome, 'reused');
    assert.equal(run.targets[0].sourceSha256, saved.sha256);
    assert.equal(library.get(h.root, saved.id).revision, saved.revision);
  } finally { fs.rmSync(h.root, { recursive: true }); }
});

test('WF-15: cancel keeps saved assets, closes the run as cancelled, and never claims success', async () => {
  const { ctx: skillsCtx } = skillRegistry();
  const h = harness({ skills: skillsCtx.skills });
  try {
    const source = path.join(h.root, 'paper.md'); fs.writeFileSync(source, 'The method applies a boundary loss to segment contours.');
    const exec = { agent: h.agent } as any;
    const controller = new AbortController();
    await drive(h, 'extract', `"${source}"`, 0, controller.signal);
    const request = sourceRequest(h.inbox[0]);
    const paper = await h.definitions.get('evolver_import_paper_source').execute({ requestId: request.requestId, sourceId: request.files[0].sourceId }, exec);
    await h.definitions.get('evolver_publish_paper_components').execute(
      { paperId: paper.paperId, components: [{ kind: 'Module', name: 'Boundary loss', description: 'Contour loss.', page: 1, quote: 'boundary loss to segment contours' }] }, exec);
    // The user cancels before the run is closed.
    h.agent.cancel();
    controller.abort();
    h.agent.running(); h.agent.idle();
    const [run] = runsIn(h.root);
    assert.equal(run.status, 'cancelled');
    assert.equal(run.targets[0].outcome, 'saved', 'a target that already published and verified stays saved');
    assert.equal(run.finishedAt !== null, true);
    assert.equal(workspacePaperLibrary({ id: 'project', path: h.root, title: 'Test project', sessionIds: ['s1'] }).get(h.root, paper.paperId).components.length, 1,
      'cancel preserves everything already saved');
  } finally { fs.rmSync(h.root, { recursive: true }); }
});

test('WF-15: a restart marks leftover runs interrupted without replaying anything', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-run-restart-'));
  try {
    const store = new PaperCommandRunStore(root);
    const run = store.begin({ command: 'wiki', agentSessionId: 's1', targets: [{ targetId: 't1', scope: 'full' }] });
    const second = new PaperCommandRunStore(root);
    assert.equal(second.markInterrupted(), 1);
    const after = second.read(run.runId)!;
    assert.equal(after.status, 'interrupted');
    assert.equal(after.targets.length, 1, 'the frozen target survives the restart');
    assert.equal(second.markInterrupted(), 0, 'the sweep is idempotent and never re-marks a closed run');
    // An explicit user-triggered recovery is a NEW run, never a silent replay.
    const resumed = second.begin({ command: 'wiki', agentSessionId: 's1', targets: [{ targetId: 't1', scope: 'full' }] });
    assert.notEqual(resumed.runId, run.runId);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('QF-04: re-running over an existing library reuses verified results instead of failing them', async () => {
  const { ctx: skillsCtx } = skillRegistry();
  const h = harness({ skills: skillsCtx.skills });
  try {
    // A real PDF at the workspace root, so the default sweep finds it.
    const pdf = path.join(h.root, 'paper.pdf');
    fs.writeFileSync(pdf, buildPdf('A method that applies a boundary loss to segment contours.'));
    const exec = { agent: h.agent } as any;
    // First run, no path: discover -> import -> publish one component.
    h.commands.get('extract').handler({ agent: h.agent, rawInput: '', attachments: [], signal: new AbortController().signal });
    await h.agent.preStep([{ id: (h.inbox[0] as any).id }]);
    const discovered = await h.definitions.get('evolver_discover_paper_sources').execute({}, exec);
    assert.equal(discovered.files.length, 1);
    const imported = await h.definitions.get('evolver_import_paper_source').execute({ requestId: discovered.requestId, sourceId: discovered.files[0].sourceId }, exec);
    await h.definitions.get('evolver_publish_paper_components').execute(
      { paperId: imported.paperId, components: [{ kind: 'Module', name: 'Boundary loss', description: 'Contour loss.', page: 1, quote: 'boundary loss to segment contours' }] }, exec);
    h.agent.running(); h.agent.idle();
    const first = runsIn(h.root)[0];
    assert.equal(first.status, 'completed');
    assert.equal(first.targets[0].outcome, 'saved');

    // Second run over the SAME workspace, still non-empty: discovery finds the file again, but
    // the Agent does not re-import or re-publish (already verified), so it is REUSED — not failed.
    h.commands.get('extract').handler({ agent: h.agent, rawInput: '', attachments: [], signal: new AbortController().signal });
    await h.agent.preStep([{ id: (h.inbox[1] as any).id }]);
    await h.definitions.get('evolver_discover_paper_sources').execute({}, exec);
    h.agent.running(); h.agent.idle();
    const second = runsIn(h.root).find((r) => r.runId !== first.runId)!;
    assert.notEqual(second.status, 'failed', 'an unchanged verified result is not a failure');
    assert.equal(second.targets[0].outcome, 'reused', '§6.4: the verified result is reused');
    assert.equal(second.targets[0].error, undefined);
    // The asset itself is untouched and still visible.
    assert.equal(workspacePaperLibrary({ id: 'project', path: h.root, title: 'Test project', sessionIds: ['s1'] }).get(h.root, imported.paperId).components.length, 1);
  } finally { fs.rmSync(h.root, { recursive: true }); }
});

test('the library route returns schemaVersion 2 with runs and no path fields', async () => {
  const { ctx: skillsCtx } = skillRegistry();
  const routes: any[] = [];
  // Capture the route the plugin really registers, so the response body is asserted
  // through the actual handler rather than a reimplementation of it.
  const h = harness({ skills: skillsCtx.skills, webServer: { register: (route: unknown) => { routes.push(route); return () => {}; } } });
  try {
    const source = path.join(h.root, 'paper.md'); fs.writeFileSync(source, 'The method applies a boundary loss to segment contours.');
    await drive(h, 'wiki', `"${source}"`, 0, new AbortController().signal);
    h.agent.running(); h.agent.idle();

    const route = routes.find((r) => r.path === '/evolver/paper-library');
    assert.ok(route, 'the read-only library route is registered');
    const res = response();
    route.handler({ url: '/evolver/paper-library?sessionId=s1', method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.schemaVersion, 2);
    assert.equal(Array.isArray(body.runs), true, 'the page reads run status from the sidecar, not React state');
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].status, 'failed');
    assert.equal(body.runs[0].targets[0].error.code, 'INCOMPLETE_OUTPUT');
    // No absolute path may reach the browser: the record and the rows carry identities only.
    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes(h.root), 'no workspace path leaks into the route response');
    assert.ok(!serialised.includes('\\'), 'no Windows path separator leaks into the route response');
    // §7 read-only: publishing stays behind the Agent.
    const post = response();
    route.handler({ url: '/evolver/paper-library?sessionId=s1', method: 'POST', headers: {} }, post);
    assert.equal(post.statusCode, 405, 'the read route refuses writes');
  } finally { fs.rmSync(h.root, { recursive: true }); }
});
