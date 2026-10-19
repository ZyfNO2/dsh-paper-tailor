import type { Context } from '@deepseek-ai/cordis';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
const { parse } = createRequire(import.meta.url)('yaml') as { parse(text: string): Record<string, unknown> };

export const name = 'evolver-research-skills';
export const inject = ['skills'];
export const PUBLIC_RESEARCH_SKILLS = ["paper-start", "organize-wiki", "brain-storm", "make-dag", "analyze-results", "research-team", "research-review", "research-resume", "academic-tailor"] as const;
// Existing workflow skills remain loadable by name, without cluttering the human menu.
const WORKFLOW_SKILLS = ['research-workspace-sync', 'research-bootstrap-brainstorm', 'research-bootstrap-initialize', 'workspace-paper-wiki', 'workspace-paper-extract', 'research-takeover'] as const;
interface Skills { register(skill: { name: string; description: string; content: string; source: string; provider: string; resourceBase: { kind: 'directory'; path: string }; invocation: { userInvocable: boolean; modelInvocable: boolean } }): () => void }
export function apply(ctx: Context): void {
  const skills = ctx.get('skills') as Skills;
  if (typeof skills?.register !== 'function') throw new Error('RESEARCH_SKILLS_UNAVAILABLE: native skills registry is required');
  const disposers: Array<() => void> = [];
  try {
    for (const skillName of [...PUBLIC_RESEARCH_SKILLS, ...WORKFLOW_SKILLS]) {
      const file = fileURLToPath(new URL(`../../../../../.dsh/skills/${skillName}/SKILL.md`, import.meta.url));
      const raw = readFileSync(file, 'utf8');
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
      if (!match) throw new Error(`Invalid packaged Skill: ${skillName}`);
      const meta = parse(match[1]);
      if (meta.name !== skillName || typeof meta.description !== 'string' || !meta.description.trim() || !match[2].trim()) throw new Error(`Invalid packaged Skill metadata: ${skillName}`);
      disposers.push(skills.register({ name: skillName, description: meta.description, content: match[2].trim(), source: file, provider: 'dsh-paper', resourceBase: { kind: 'directory', path: dirname(file) }, invocation: { modelInvocable: true, userInvocable: (PUBLIC_RESEARCH_SKILLS as readonly string[]).includes(skillName) } }));
    }
  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error; }
  ctx.on('dispose', () => { for (const dispose of disposers.reverse()) dispose(); });
}
