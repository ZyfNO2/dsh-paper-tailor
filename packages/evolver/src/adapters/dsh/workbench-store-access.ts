/**
 * Workbench store access layer: the ONLY module that turns a request into a
 * file read.
 *
 * Why this exists (redesign plan R05, §4.1): the v1 projection took an
 * arbitrary absolute `path` from the UI and gated it with
 * `norm.startsWith(root)`, which a sibling directory sharing the root's
 * string prefix satisfies, and joined a caller-supplied `taskId` into the path
 * without validating it. Both are corrected here, and the correction is a
 * separate, testable unit rather than a helper buried in the projection:
 *
 *  - `taskId` must match the store's own task id vocabulary, and the task
 *    directory must resolve (realpath) INSIDE the task root, so `..`, a
 *    junction, or a symlink cannot step outside;
 *  - artifact reads take a typed (taskId, ArtifactRef) pair and resolve the ref
 *    through the operation's published `artifacts.json` index — a path the
 *    store itself published — never through a caller-supplied string;
 *  - the content hash is recomputed and compared on every read, so a mutated
 *    published file is reported as `HASH_MISMATCH` rather than served;
 *  - final-test material and host secret config are refused by name, and a
 *    read failure is distinguished from a legitimate empty/absent artifact.
 *
 * Nothing here decides what a task IS; that is the projection's job. This
 * module only answers "may this read happen, and what exactly was read".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/** An artifact identity as published by an evolver store: id + content hash. */
export interface TypedArtifactRef {
  id: string;
  sha256: string | null;
}

/** Machine-readable refusal reasons. Never collapsed into "not found". */
export type AccessErrorCode =
  | 'INVALID_TASK_ID'
  | 'TASK_NOT_FOUND'
  | 'UNKNOWN_REF'
  | 'REF_HASH_MISMATCH'
  | 'OUT_OF_SCOPE'
  | 'FORBIDDEN_ARTIFACT'
  | 'UNREADABLE';

export interface AccessFailure {
  ok: false;
  code: AccessErrorCode;
  message: string;
}

export type AccessResult<T> = { ok: true; value: T } | AccessFailure;

function fail(code: AccessErrorCode, message: string): AccessFailure {
  return { ok: false, code, message };
}

/**
 * Task ids are the store's own directory names and appear in published refs,
 * command-index keys and receipt taskIds. Restricting to that vocabulary is
 * what makes `path.join(taskRoot, taskId)` safe: no separators, no `..`, no
 * drive letters, no UNC.
 */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidTaskId(taskId: string): boolean {
  return TASK_ID.test(taskId);
}

/** Ref ids are dotted tokens; same reason, same guard. */
const REF_ID = /^[A-Za-z0-9][A-Za-z0-9._|-]{0,255}$/;

export function isValidRefId(refId: string): boolean {
  return REF_ID.test(refId);
}

/**
 * Artifacts the ordinary workbench must never serve: the independent test
 * split's material and host secret configuration. A refusal here is a policy
 * decision recorded in the response, not a filesystem accident.
 */
const FORBIDDEN_NAME_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /final[-_]?test/i, why: 'independent final-test material' },
  { re: /test[-_]?split/i, why: 'independent test split material' },
  { re: /holdout/i, why: 'held-out split material' },
  { re: /(secret|credential|token|apikey|api[-_]?key)/i, why: 'host secret configuration' },
  { re: /(^|[\\/])\.env(\.|$)/i, why: 'environment/secret file' },
];

export function forbiddenReason(name: string): string | null {
  for (const { re, why } of FORBIDDEN_NAME_PATTERNS) {
    if (re.test(name)) return why;
  }
  return null;
}

/**
 * Realpath-aware containment.
 *
 * `path.resolve` alone is defeated by a symlink/junction inside the root, and
 * a plain string prefix is defeated by a sibling directory (`…/artifacts/foo`
 * satisfies a `…/artifacts/foo-bar` root). Comparing resolved paths with a
 * trailing separator fixes the prefix case; `realpathSync` fixes the link case.
 * The target is allowed to not exist (a missing file is a legitimate "absent"),
 * so its nearest existing ancestor is realpath'd instead.
 */
export function containedRealPath(root: string, target: string): string | null {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(path.resolve(root));
  } catch {
    return null;
  }
  const resolved = path.resolve(target);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    real = path.resolve(path.dirname(resolved));
    if (!isInside(realRoot, real)) return null;
    real = path.join(real, path.basename(resolved));
  }
  return isInside(realRoot, real) ? real : null;
}

/** True when `child` is the root itself or lies beneath it, on a segment boundary. */
export function isInside(root: string, child: string): boolean {
  const normRoot = path.resolve(root);
  const normChild = path.resolve(child);
  if (normChild === normRoot) return true;
  return normChild.startsWith(normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep);
}

export function sha256File(file: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** Bounded read of one already-authorized file, with the hash it actually has. */
export interface ReadArtifactOutcome {
  type: 'json' | 'text';
  ref: TypedArtifactRef;
  content: string;
  truncated: boolean;
  byteLength: number;
}

export function readBoundedArtifact(file: string, view: 'summary' | 'detail'): ReadArtifactOutcome | null {
  let raw: Buffer;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    raw = fs.readFileSync(file);
  } catch {
    return null;
  }
  const limit = view === 'detail' ? 64 * 1024 : 4 * 1024;
  return {
    type: path.extname(file).toLowerCase() === '.json' ? 'json' : 'text',
    ref: { id: path.basename(file), sha256: createHash('sha256').update(raw).digest('hex') },
    content: raw.subarray(0, limit).toString('utf8'),
    truncated: raw.length > limit,
    byteLength: raw.length,
  };
}

/**
 * One evolver store root (`artifacts/research-execution`, `artifacts/paper-only`,
 * `artifacts/phase3/experiments`). Resolves a task directory and reads files
 * only underneath it.
 */
export class ScopedRoot {
  // Explicit fields, not parameter properties: this package runs under
  // `--experimental-strip-types`, which erases types without transforming
  // syntax, and parameter properties are exactly the construct it refuses.
  readonly name: string;
  readonly root: string;

  constructor(name: string, root: string) {
    this.name = name;
    this.root = root;
  }

  get exists(): boolean {
    try {
      return fs.statSync(this.root).isDirectory();
    } catch {
      return false;
    }
  }

  /** Resolve `taskId` to its directory, or explain precisely why not. */
  taskDir(taskId: string): AccessResult<string> {
    if (!isValidTaskId(taskId)) {
      return fail('INVALID_TASK_ID', `taskId is not a store task id: ${JSON.stringify(taskId)}`);
    }
    const dir = path.join(this.root, taskId);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      return fail('TASK_NOT_FOUND', `${this.name}: no task directory for ${taskId}`);
    }
    if (!stat.isDirectory()) {
      return fail('TASK_NOT_FOUND', `${this.name}: ${taskId} is not a directory`);
    }
    const real = containedRealPath(this.root, dir);
    if (real === null) {
      return fail('OUT_OF_SCOPE', `${this.name}: ${taskId} resolves outside ${this.name} root`);
    }
    return { ok: true, value: real };
  }

  /** Read a JSON file under an ALREADY-authorized directory. */
  readJsonIn(dir: string, ...segments: string[]): unknown | null {
    if (segments.some((s) => !isValidRefId(s) && s.includes('/') && s.includes('\\'))) return null;
    const target = containedRealPath(dir, path.join(dir, ...segments));
    if (target === null) return null;
    try {
      return JSON.parse(fs.readFileSync(target, 'utf8')) as unknown;
    } catch {
      return null;
    }
  }
}