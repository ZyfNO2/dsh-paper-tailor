import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SkillRegistry, renderSkillContent } from '@deepseek-ai/dsh-skill';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { apply, PUBLIC_RESEARCH_SKILLS } from '../../packages/evolver/src/adapters/dsh/research-skill-entries.ts';

test('packaged skills discover and load through native registry outside the source workspace; unload removes them', async () => {
  const ctx = new Context(), registry = new SkillRegistry(ctx), dispose: Array<() => void> = [];
  apply({ get: (name: string) => name === 'skills' ? registry : undefined, on: (_name: string, fn: () => void) => dispose.push(fn) } as unknown as Context);
  const catalog = await registry.list({ cwd: 'C:/' });
  assert.deepEqual(catalog.filter((s: any) => s.invocation.userInvocable).map((s: any) => s.name).sort(), [...PUBLIC_RESEARCH_SKILLS].sort());
  assert.ok(catalog.every((s: any) => !('content' in s)), 'catalog exposes metadata, not all workflow bodies');
  for (const name of PUBLIC_RESEARCH_SKILLS) {
    const skill = await registry.get(name, { cwd: 'C:/' });
    assert.ok(skill); assert.equal(skill.provider, 'dsh-paper');
    assert.ok(renderSkillContent(skill).includes('evolver_get_research_bootstrap'));
    assert.ok(existsSync(skill.resourceBase.path));
  }
  const tailor = await registry.get('academic-tailor');
  assert.ok(readFileSync(join(tailor.resourceBase.path, 'references/stages.md'), 'utf8').includes('模块匹配'));
  for (const name of ['research-workspace-sync', 'research-bootstrap-brainstorm', 'research-bootstrap-initialize', 'workspace-paper-wiki', 'workspace-paper-extract']) {
    const skill = await registry.get(name); assert.ok(skill); assert.equal(skill.invocation.userInvocable, false); assert.equal(skill.invocation.modelInvocable, true);
  }
  for (const fn of dispose) fn();
  assert.equal((await registry.list()).length, 0);
});

test('missing native skill service fails activation explicitly', () => {
  assert.throws(() => apply({ get: () => undefined } as unknown as Context), /RESEARCH_SKILLS_UNAVAILABLE/);
});
