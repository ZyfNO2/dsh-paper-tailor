/**
 * Domain layer: Task aggregate, idempotency handling, revision control,
 * single-writer host lock, and atomic persistence.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  type Task,
  type TaskSpec,
  type Command,
  type Receipt,
  type Operation,
  type OperationStatus,
  type TaskSnapshot,
  toTaskSnapshot,
  EvolverError,
  validateCommand,
  validateTaskSpec,
  validateNonEmptyString,
} from '../contracts/index.ts';

export interface HostLockInfo {
  hostId: string;
  pid: number;
  acquiredAt: string;
  nonce: string;
}

export class TaskAggregate {
  private readonly _task: Task;

  private constructor(task: Task) {
    this._task = task;
  }

  static create(
    id: string,
    ownerSessionId: string,
    title: string | undefined,
    spec: TaskSpec
  ): TaskAggregate {
    validateNonEmptyString(id, 'taskId');
    validateNonEmptyString(ownerSessionId, 'ownerSessionId');

    const now = new Date().toISOString();
    const task: Task = {
      id,
      ownerSessionId,
      revision: 1,
      title: title ? title.trim() : undefined,
      spec: JSON.parse(JSON.stringify(spec)),
      operations: {},
      campaigns: {},
      receipts: {},
      createdAt: now,
      updatedAt: now,
    };
    return new TaskAggregate(task);
  }

  static fromSnapshot(task: Task): TaskAggregate {
    return new TaskAggregate(JSON.parse(JSON.stringify(task)));
  }

  get task(): Readonly<Task> {
    return this._task;
  }

  get id(): string {
    return this._task.id;
  }

  get revision(): number {
    return this._task.revision;
  }

  get ownerSessionId(): string {
    return this._task.ownerSessionId;
  }

  verifyOwner(actorSessionId: string | undefined): void {
    if (!actorSessionId || typeof actorSessionId !== 'string' || actorSessionId.trim().length === 0) {
      throw new EvolverError('OWNER_MISMATCH', 'Caller context must provide a non-empty session owner');
    }
    if (this._task.ownerSessionId !== actorSessionId.trim()) {
      throw new EvolverError(
        'OWNER_MISMATCH',
        `Task owner mismatch: expected "${this._task.ownerSessionId}", got "${actorSessionId.trim()}"`
      );
    }
  }

  saveSpec(
    command: Command,
    spec: TaskSpec,
    actorSessionId: string,
    operationId = `op-${crypto.randomUUID()}`
  ): Receipt {
    this.verifyOwner(actorSessionId);
    const validCmd = validateCommand(command);
    const validSpec = validateTaskSpec(spec);

    // 1. Idempotency check prior to revision check
    const existingReceipt = this._task.receipts[validCmd.commandId];
    if (existingReceipt) {
      // Check payload equivalence
      const currentSpecNormalized = JSON.stringify(this._task.spec);
      const incomingSpecNormalized = JSON.stringify(validSpec);
      if (currentSpecNormalized === incomingSpecNormalized) {
        return existingReceipt;
      }
      throw new EvolverError(
        'IDEMPOTENCY_CONFLICT',
        `Command "${validCmd.commandId}" already executed with a different payload`
      );
    }

    // 2. Revision check
    if (validCmd.expectedRevision !== this._task.revision) {
      throw new EvolverError(
        'REVISION_CONFLICT',
        `Revision conflict: expected revision ${validCmd.expectedRevision}, but current is ${this._task.revision}`
      );
    }

    // 3. Apply mutation
    this._task.spec = JSON.parse(JSON.stringify(validSpec));
    this._task.revision += 1;
    const now = new Date().toISOString();
    this._task.updatedAt = now;

    // Record receipt and operation
    const receipt: Receipt = {
      commandId: validCmd.commandId,
      taskId: this._task.id,
      revision: this._task.revision,
      operationId,
    };
    this._task.receipts[validCmd.commandId] = receipt;

    const op: Operation = {
      id: operationId,
      commandId: validCmd.commandId,
      kind: 'save_spec',
      status: 'succeeded',
      resultRefs: [],
      createdAt: now,
      updatedAt: now,
    };
    this._task.operations[operationId] = op;

    return receipt;
  }

  getOperation(operationId: string, actorSessionId: string): Operation {
    this.verifyOwner(actorSessionId);
    validateNonEmptyString(operationId, 'operationId');
    const op = this._task.operations[operationId];
    if (!op) {
      throw new EvolverError('NOT_FOUND', `Operation "${operationId}" not found on task "${this._task.id}"`);
    }
    return JSON.parse(JSON.stringify(op));
  }

  toSnapshot(): TaskSnapshot {
    return toTaskSnapshot(this._task);
  }
}

export * from './task-adapter.ts';
export * from './host-verifier.ts';
export * from './module-registry.ts';

export class StorageDomain {
  readonly rootDir: string;
  private readonly _lockFilePath: string;
  private readonly _tasksDir: string;
  private _heldLock: HostLockInfo | null = null;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this._lockFilePath = path.join(this.rootDir, 'writer.lock');
    this._tasksDir = path.join(this.rootDir, 'tasks');
    fs.mkdirSync(this._tasksDir, { recursive: true });
  }

  acquireLock(hostId: string): HostLockInfo {
    validateNonEmptyString(hostId, 'hostId');

    if (this._heldLock && this._heldLock.hostId === hostId) {
      return this._heldLock;
    }

    if (fs.existsSync(this._lockFilePath)) {
      try {
        const raw = fs.readFileSync(this._lockFilePath, 'utf8');
        const lockInfo = JSON.parse(raw) as HostLockInfo;
        if (lockInfo.hostId !== hostId) {
          // Check if process is still alive
          let isAlive = false;
          try {
            process.kill(lockInfo.pid, 0);
            isAlive = true;
          } catch {
            isAlive = false;
          }

          if (isAlive) {
            throw new EvolverError(
              'HOST_BUSY',
              `Storage root "${this.rootDir}" is already locked by active host "${lockInfo.hostId}" (PID ${lockInfo.pid})`
            );
          }
          // If dead, stale lock can be overwritten
        }
      } catch (err: unknown) {
        if (err instanceof EvolverError) throw err;
        // Ignore parse error and overwrite corrupted lock
      }
    }

    const lock: HostLockInfo = {
      hostId,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      nonce: crypto.randomUUID(),
    };

    // Atomic write lock file using wx flag
    const tmpLock = path.join(this.rootDir, `writer.lock.${Date.now()}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmpLock, JSON.stringify(lock, null, 2), 'utf8');
    fs.renameSync(tmpLock, this._lockFilePath);
    this._heldLock = lock;
    return lock;
  }

  releaseLock(hostId: string): void {
    if (this._heldLock && this._heldLock.hostId === hostId) {
      if (fs.existsSync(this._lockFilePath)) {
        try {
          const raw = fs.readFileSync(this._lockFilePath, 'utf8');
          const lockInfo = JSON.parse(raw) as HostLockInfo;
          if (lockInfo.nonce === this._heldLock.nonce) {
            fs.unlinkSync(this._lockFilePath);
          }
        } catch {
          // Lock already gone
        }
      }
      this._heldLock = null;
    }
  }

  private _assertLockHeld(): void {
    if (!this._heldLock) {
      throw new EvolverError('HOST_BUSY', 'Host does not hold an active writer lock on storage');
    }
    if (!fs.existsSync(this._lockFilePath)) {
      throw new EvolverError('HOST_BUSY', 'Storage writer lock was lost or removed');
    }
    const raw = fs.readFileSync(this._lockFilePath, 'utf8');
    const lockInfo = JSON.parse(raw) as HostLockInfo;
    if (lockInfo.nonce !== this._heldLock.nonce) {
      throw new EvolverError('HOST_BUSY', 'Storage writer lock was superseded by another host');
    }
  }

  putTask(aggregate: TaskAggregate): void {
    this._assertLockHeld();
    const task = aggregate.task;
    const taskPath = path.join(this._tasksDir, `${task.id}.json`);
    const tmpPath = path.join(this._tasksDir, `${task.id}.${Date.now()}.${crypto.randomUUID()}.tmp`);
    const content = JSON.stringify(task, null, 2);
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, taskPath);
  }

  getTask(taskId: string): TaskAggregate {
    validateNonEmptyString(taskId, 'taskId');
    const taskPath = path.join(this._tasksDir, `${taskId}.json`);
    if (!fs.existsSync(taskPath)) {
      throw new EvolverError('NOT_FOUND', `Task "${taskId}" not found in storage`);
    }
    const raw = fs.readFileSync(taskPath, 'utf8');
    const task = JSON.parse(raw) as Task;
    return TaskAggregate.fromSnapshot(task);
  }

  hasTask(taskId: string): boolean {
    return fs.existsSync(path.join(this._tasksDir, `${taskId}.json`));
  }

  computeStorageHash(): string {
    const files = fs.readdirSync(this._tasksDir).filter((f) => f.endsWith('.json')).sort();
    const hash = crypto.createHash('sha256');
    for (const f of files) {
      const buf = fs.readFileSync(path.join(this._tasksDir, f));
      hash.update(f);
      hash.update(buf);
    }
    return hash.digest('hex');
  }
}
