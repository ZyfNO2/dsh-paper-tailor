import * as fs from 'node:fs';
import * as path from 'node:path';
import { ResearchCoreError } from '../../research-contracts/src/index.ts';

export interface ResolvedResearchRoot {
  workspaceDir: string;
  kind: 'research' | 'legacy' | 'absent';
  researchDir: string;
  projectFile: string;
  legacyDir: string;
  projectExists: boolean;
  legacyExists: boolean;
}

/** `.research/` is the new root. An old `.dsh/research/` stays readable and is not the write target. */
export function resolveResearchRoot(workspaceDir: string): ResolvedResearchRoot {
  if (typeof workspaceDir !== 'string' || workspaceDir.trim().length === 0) {
    throw new ResearchCoreError('INVALID_INPUT', 'workspace directory is required');
  }
  const workspace = path.resolve(workspaceDir);
  const researchDir = path.join(workspace, '.research');
  const projectFile = path.join(researchDir, 'project.json');
  const legacyDir = path.join(workspace, '.dsh', 'research');
  // Refuse directory junctions that redirect authoritative writes outside the project.
  for (const directory of [researchDir, path.join(researchDir, 'sources'), path.join(researchDir, 'artifacts'), projectFile, legacyDir]) {
    if (fs.existsSync(directory)) assertInside(fs.realpathSync(workspace), fs.realpathSync(directory));
  }
  const projectExists = fs.existsSync(projectFile);
  const legacyExists = fs.existsSync(legacyDir);
  const kind = projectExists ? 'research' : legacyExists ? 'legacy' : 'absent';
  return { workspaceDir: workspace, kind, researchDir, projectFile, legacyDir, projectExists, legacyExists };
}

export function assertInside(parent: string, candidate: string): string {
  const root = path.resolve(parent);
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ResearchCoreError('PATH_ESCAPE', 'path leaves the allowed directory');
  }
  return target;
}

/** Resolve existing ancestors too, so an output alias cannot overwrite authoritative state. */
export function exportTarget(workspaceDir: string, outPath: string): string {
  const root = resolveResearchRoot(workspaceDir);
  const target = path.resolve(outPath);
  let ancestor = target;
  const missing: string[] = [];
  while (!fs.existsSync(ancestor)) {
    missing.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new ResearchCoreError('PATH_ESCAPE', 'export has no existing filesystem ancestor');
    ancestor = parent;
  }
  const realTarget = path.join(fs.realpathSync(ancestor), ...missing);
  const workspace = fs.realpathSync(root.workspaceDir);
  for (const forbidden of [path.join(workspace, '.research'), path.join(workspace, '.dsh', 'research')]) {
    const relative = path.relative(forbidden, realTarget);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new ResearchCoreError('PATH_ESCAPE', 'export cannot overwrite research state through a path or alias');
  }
  return target;
}
