/**
 * Application layer: EvolverService orchestration.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import {
  type TaskSnapshot,
  type TaskSpec,
  type Command,
  type Receipt,
  type Operation,
  EvolverError,
  validateCommand,
  validateTaskSpec,
  validateNonEmptyString,
} from '../contracts/index.ts';
import {
  TaskAggregate,
  StorageDomain,
  TaskAdapter,
  HostVerifier,
  type ExecutionTarget,
  type VerifiedResult,
} from '../domain/index.ts';

export interface CallerActor {
  sessionId: string;
  agentId?: string;
}

export * from './search-state-store.ts';
export * from './search-feedback-orchestration.ts';
export * from './research-budget.ts';
export * from './search-partial-report.ts';
export * from './search-strategy-policy.ts';

export class EvolverService {
  readonly storage: StorageDomain;
  readonly hostId: string;

  constructor(storage: StorageDomain, hostId = `host-${process.pid}`) {
    this.storage = storage;
    this.hostId = hostId;
    this.storage.acquireLock(this.hostId);
  }

  dispose(): void {
    this.storage.releaseLock(this.hostId);
  }

  createTask(
    commandId: string,
    title: string | undefined,
    draftSpec: TaskSpec | undefined,
    actor: CallerActor
  ): TaskSnapshot {
    validateNonEmptyString(commandId, 'commandId');
    if (!actor || !actor.sessionId || actor.sessionId.trim().length === 0) {
      throw new EvolverError('OWNER_MISMATCH', 'createTask requires an active session actor');
    }

    const taskId = `task-${commandId}`;
    if (this.storage.hasTask(taskId)) {
      // If task already exists with this commandId, check if it's the same owner and return it
      const existing = this.storage.getTask(taskId);
      existing.verifyOwner(actor.sessionId);
      return existing.toSnapshot();
    }

    const defaultSpec: TaskSpec = draftSpec ? validateTaskSpec(draftSpec) : { protocolId: 'stitch-cpu-v1' };
    const aggregate = TaskAggregate.create(taskId, actor.sessionId.trim(), title, defaultSpec);
    this.storage.putTask(aggregate);
    return aggregate.toSnapshot();
  }

  getTask(taskId: string, actor: CallerActor): TaskSnapshot {
    validateNonEmptyString(taskId, 'taskId');
    if (!actor || !actor.sessionId) {
      throw new EvolverError('OWNER_MISMATCH', 'getTask requires an active session actor');
    }
    const aggregate = this.storage.getTask(taskId);
    aggregate.verifyOwner(actor.sessionId);
    return aggregate.toSnapshot();
  }

  saveSpec(
    command: Command,
    spec: TaskSpec,
    actor: CallerActor
  ): { revision: number; receipt: Receipt } {
    const validCmd = validateCommand(command);
    if (!actor || !actor.sessionId) {
      throw new EvolverError('OWNER_MISMATCH', 'saveSpec requires an active session actor');
    }
    const aggregate = this.storage.getTask(validCmd.taskId);
    aggregate.verifyOwner(actor.sessionId);

    const receipt = aggregate.saveSpec(validCmd, spec, actor.sessionId);
    this.storage.putTask(aggregate);
    return { revision: receipt.revision, receipt };
  }

  getOperation(taskId: string, operationId: string, actor: CallerActor): Operation {
    validateNonEmptyString(taskId, 'taskId');
    validateNonEmptyString(operationId, 'operationId');
    if (!actor || !actor.sessionId) {
      throw new EvolverError('OWNER_MISMATCH', 'getOperation requires an active session actor');
    }
    const aggregate = this.storage.getTask(taskId);
    aggregate.verifyOwner(actor.sessionId);
    return aggregate.getOperation(operationId, actor.sessionId);
  }

  async runBaseline(
    command: Command,
    actor: CallerActor,
    adapter = new TaskAdapter(),
    verifier = new HostVerifier()
  ): Promise<{ receipt: Receipt; operation: Operation; verifiedResult?: VerifiedResult }> {
    const validCmd = validateCommand(command);
    if (!actor || !actor.sessionId) {
      throw new EvolverError('OWNER_MISMATCH', 'runBaseline requires an active session actor');
    }
    const aggregate = this.storage.getTask(validCmd.taskId);
    aggregate.verifyOwner(actor.sessionId);

    const operationId = `op-${crypto.randomUUID()}`;
    const runId = `run-${validCmd.taskId}-${Date.now()}`;
    const now = new Date().toISOString();

    const op: Operation = {
      id: operationId,
      commandId: validCmd.commandId,
      kind: 'run_baseline',
      status: 'running',
      resultRefs: [],
      createdAt: now,
      updatedAt: now,
    };
    aggregate.task.operations[operationId] = op;

    const receipt: Receipt = {
      commandId: validCmd.commandId,
      taskId: validCmd.taskId,
      revision: aggregate.task.revision,
      operationId,
    };
    aggregate.task.receipts[validCmd.commandId] = receipt;
    this.storage.putTask(aggregate);

    try {
      const target: ExecutionTarget = {
        kind: 'baseline',
        baseline: {
          id: 'baseline-small-conv',
          revision: 1,
          sourceHash: 'source-conv2d-relu-pool-fc',
          configHash: 'config-8ch-2class-batch4',
          adapterId: 'adapter-cpu-torch',
        },
      };

      const manifest = await adapter.prepare(target, runId);
      const facts = await adapter.execute(manifest);
      const verifiedResult = verifier.verify(manifest, facts);

      op.status = 'succeeded';
      op.resultRefs = [path.join(manifest.outputDir, 'verified-result.json').replace(/\\/g, '/')];
      op.updatedAt = new Date().toISOString();
      this.storage.putTask(aggregate);

      return { receipt, operation: op, verifiedResult };
    } catch (err: unknown) {
      op.status = 'failed';
      op.error = {
        code: err instanceof EvolverError ? err.code : 'INVALID_RESULT',
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      };
      op.updatedAt = new Date().toISOString();
      this.storage.putTask(aggregate);
      throw err;
    }
  }

  stopOperation(
    taskId: string,
    operationId: string,
    commandId: string,
    actor: CallerActor,
    adapter?: TaskAdapter
  ): Operation {
    validateNonEmptyString(taskId, 'taskId');
    validateNonEmptyString(operationId, 'operationId');
    validateNonEmptyString(commandId, 'commandId');
    if (!actor || !actor.sessionId) {
      throw new EvolverError('OWNER_MISMATCH', 'stopOperation requires an active session actor');
    }
    const aggregate = this.storage.getTask(taskId);
    aggregate.verifyOwner(actor.sessionId);

    const op = aggregate.task.operations[operationId];
    if (!op) {
      throw new EvolverError('NOT_FOUND', `Operation "${operationId}" not found on task "${taskId}"`);
    }

    if (adapter) {
      adapter.stopRun(operationId);
    }

    if (op.status === 'running' || op.status === 'accepted') {
      op.status = 'cancelled';
      op.updatedAt = new Date().toISOString();
      this.storage.putTask(aggregate);
    }

    return JSON.parse(JSON.stringify(op));
  }
}
