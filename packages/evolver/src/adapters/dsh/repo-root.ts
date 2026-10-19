/**
 * Repo-root resolution for the host adapters.
 *
 * WHY THIS EXISTS
 * ---------------
 * A host extension is loaded by a DSH process whose working directory is whatever
 * the operator's shell was in — frequently NOT the repository. Config values that
 * name repository assets (fixtures, skills, protocol files, artifact roots) are
 * written repo-relative so a published profile contains no absolute path, which
 * means something has to resolve them against the repository rather than `cwd`.
 *
 * `process.cwd()` is the wrong base: it made the shipped profile work only when the
 * host happened to be started from the checkout. This module derives the base from
 * the adapter file's OWN location instead, so it is correct wherever the host is
 * launched from and wherever the tree is checked out.
 *
 * The depth is fixed by the layout this package ships with:
 *
 *   <repo>/packages/evolver/src/adapters/dsh/repo-root.ts
 *     1 up: dsh -> adapters
 *     2 up: adapters -> src
 *     3 up: src -> evolver
 *     4 up: evolver -> packages
 *     5 up: packages -> <repo>
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, derived from this file's location (not from `process.cwd()`). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

/**
 * Resolve a trusted-config path against the repository root.
 *
 * An absolute value is returned unchanged, so a local overlay may still point
 * outside the tree (another disk, a shared fixtures directory) without this
 * helper second-guessing it.
 */
export function resolveRepoPath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}
