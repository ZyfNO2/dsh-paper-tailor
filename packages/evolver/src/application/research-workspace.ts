/**
 * File access for research-owned tools. No shell, directory creation or link
 * mutation is exposed. Host tool guards must deny alternate filesystem tools.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ExperimentError } from '../contracts/experiments.ts';
import { researchPathWithin } from '../contracts/team-research.ts';

export interface ResearchWorkspaceOptions {
  readRoots: readonly string[];
  writeRoots: readonly string[];
  /** Re-check actual caller/grant on EVERY operation, including after revocation. */
  authorize: (effect: 'read' | 'write') => void;
  maxFileBytes: number;
}

function denied(message: string): never {
  throw new ExperimentError('POLICY_DENIED', message);
}

function validateSpelling(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') ||
      /(^|[\\/])\.\.([\\/]|$)/.test(value) || /^\\\\[?.]\\/.test(value)) {
    denied('Research file paths must be absolute, without traversal or device prefixes');
  }
  const root = path.parse(value).root;
  const suffix = value.slice(root.length);
  if (suffix.includes(':') || (process.platform === 'win32' && suffix.split(/[\\/]/).some((part) => /[. ]$/.test(part)))) {
    denied('Alternate streams and ambiguous Windows path spellings are forbidden');
  }
  return path.resolve(value);
}

function checkAncestors(target: string): void {
  let cursor = target;
  for (;;) {
    if (fs.lstatSync(cursor).isSymbolicLink()) denied('Research workspace refuses symbolic links and junctions');
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class ResearchWorkspace {
  private readonly readRoots: readonly string[];
  private readonly writeRoots: readonly string[];
  private readonly rootIdentity = new Map<string, { dev: number; ino: number }>();
  private readonly authorize: ResearchWorkspaceOptions['authorize'];
  private readonly maxFileBytes: number;

  constructor(options: ResearchWorkspaceOptions) {
    if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1) {
      throw new ExperimentError('SCHEMA_VIOLATION', 'maxFileBytes must be a positive safe integer');
    }
    this.authorize = options.authorize;
    this.maxFileBytes = options.maxFileBytes;
    this.readRoots = this.resolveRoots(options.readRoots);
    this.writeRoots = this.resolveRoots(options.writeRoots);
    if (this.writeRoots.some((root) => !this.readRoots.some((read) => researchPathWithin(read, root)))) {
      denied('Write roots must be contained by read roots');
    }
  }

  private resolveRoots(roots: readonly string[]): readonly string[] {
    return Object.freeze(roots.map((root) => {
      const absolute = validateSpelling(root);
      checkAncestors(absolute);
      if (!fs.lstatSync(absolute).isDirectory()) denied('A workspace root must be an existing directory');
      const real = fs.realpathSync.native(absolute);
      const stats = fs.lstatSync(real);
      this.rootIdentity.set(real, { dev: stats.dev, ino: stats.ino });
      return real;
    }));
  }

  /** Validate again at the operation boundary, not just at configuration time. */
  private resolveFile(raw: string, effect: 'read' | 'write', allowMissing: boolean): string {
    this.authorize(effect);
    const target = validateSpelling(raw);
    const roots = effect === 'read' ? this.readRoots : this.writeRoots;
    const root = roots.find((candidate) => researchPathWithin(candidate, target));
    if (!root || roots.includes(target)) denied(`File is outside the granted ${effect} scope`);
    // Prevent replacement of an admitted root by a link after construction.
    checkAncestors(root);
    const pinned = this.rootIdentity.get(root)!;
    const current = fs.lstatSync(root);
    if (current.dev !== pinned.dev || current.ino !== pinned.ino) denied('Workspace root filesystem identity changed');
    if (!researchPathWithin(root, fs.realpathSync.native(root)) ||
        !researchPathWithin(fs.realpathSync.native(root), root)) denied('Workspace root identity changed');
    checkAncestors(path.dirname(target));
    const parent = fs.realpathSync.native(path.dirname(target));
    if (!researchPathWithin(root, parent)) denied('File parent resolves outside its granted root');
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(target);
    } catch (error: unknown) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return target;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
      denied('Research access only admits regular files without symbolic or hard links');
    }
    if (!researchPathWithin(root, fs.realpathSync.native(target))) denied('File resolves outside its granted root');
    return target;
  }

  private checkHandle(target: string, fd: number, effect: 'read' | 'write'): fs.Stats {
    this.resolveFile(target, effect, false);
    const byPath = fs.lstatSync(target);
    const byHandle = fs.fstatSync(fd);
    if (!byHandle.isFile() || byHandle.nlink !== 1 || byHandle.dev !== byPath.dev || byHandle.ino !== byPath.ino) {
      denied('File identity changed while opening the research file');
    }
    return byHandle;
  }

  private readHandle(fd: number, target: string): Buffer {
    const stats = this.checkHandle(target, fd, 'read');
    if (stats.size > this.maxFileBytes) denied('File exceeds the role file-byte ceiling');
    // A bounded read cannot allocate arbitrarily after a concurrent file growth.
    const buffer = Buffer.alloc(Math.min(stats.size + 1, this.maxFileBytes + 1));
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count !== stats.size || fs.fstatSync(fd).size !== stats.size) {
      throw new ExperimentError('REVISION_CONFLICT', 'Research file changed during the read');
    }
    this.checkHandle(target, fd, 'read');
    return buffer.subarray(0, count);
  }

  readFile(raw: string): { bytes: Buffer; sha256: string } {
    const target = this.resolveFile(raw, 'read', false);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const bytes = this.readHandle(fd, target);
      return { bytes, sha256: digest(bytes) };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** null means create-only; overwrites require the exact previous content hash. */
  writeFile(raw: string, content: Uint8Array, expectedSha256: string | null): { sha256: string; byteLength: number } {
    if (!(content instanceof Uint8Array) || content.byteLength > this.maxFileBytes) {
      throw new ExperimentError('POLICY_DENIED', 'Research write exceeds its file-byte ceiling');
    }
    if (expectedSha256 !== null && !/^[0-9a-f]{64}$/.test(expectedSha256)) {
      throw new ExperimentError('SCHEMA_VIOLATION', 'Overwrite requires a lowercase sha256 or null for create-only');
    }
    const target = this.resolveFile(raw, 'write', expectedSha256 === null);
    const flags = expectedSha256 === null
      ? fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR
      : fs.constants.O_RDWR;
    const fd = fs.openSync(target, flags | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      this.checkHandle(target, fd, 'write');
      if (expectedSha256 !== null && digest(this.readHandle(fd, target)) !== expectedSha256) {
        throw new ExperimentError('REVISION_CONFLICT', 'Research write rejected a stale file version');
      }
      this.authorize('write');
      let written = 0;
      while (written < content.byteLength) {
        const count = fs.writeSync(fd, content, written, content.byteLength - written, written);
        if (count === 0) throw new ExperimentError('SOURCE_MISMATCH', 'Research write made no progress');
        written += count;
      }
      fs.ftruncateSync(fd, content.byteLength);
      fs.fsyncSync(fd);
      this.checkHandle(target, fd, 'write');
      const committed = this.readHandle(fd, target);
      if (digest(committed) !== digest(content)) {
        throw new ExperimentError('REVISION_CONFLICT', 'Research file bytes differ after commit');
      }
      return { sha256: digest(committed), byteLength: committed.byteLength };
    } finally {
      fs.closeSync(fd);
    }
  }
}
