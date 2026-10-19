import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ExperimentError, type ArtifactRef } from '../contracts/experiments.ts';
import { typedHash } from '../domain/research-canonical.ts';

export interface RootResearchBudget {
  maxModelCalls: number;
  maxTotalTokens: number;
  maxExecutionSeconds: number;
  maxTrials: number;
  maxRepairAttempts: number;
  perAttemptTimeoutMs: number;
  wallClockDeadlineMs: number;
  allowedDevices: string[];
  maxMemoryBytes: number;
  maxDiskBytes: number;
}

export interface RootBudgetPrecharge {
  trialCount: number;
  executionMs: number;
  modelCalls: number;
  totalTokens: number;
  repairAttempts: number;
  /** Bytes copied into the new search root before any candidate attempt. */
  diskBytes: number;
  evidenceRefs: ArtifactRef[];
}

export interface RootTrialReservation {
  reservationId: string;
  attemptId: string;
  plannedTrials: number;
  maxExecutionMs: number;
  maxMemoryBytes: number;
  /** Per child output directory. Published copies are budgeted at 2x this value. */
  maxOutputBytesPerTrial: number;
  device: string;
}

export interface RootTrialSettlement {
  attemptedTrials: number;
  executionMs: number;
  /** Sum of bytes under the attempted child output directories. */
  stagedOutputBytes: number;
  /** Process peak working-set samples, one value per attempted child. */
  peakWorkingSetBytes: number[];
  /** Must be true only after the runner returned facts for every attempted child. */
  executionFactsComplete: true;
}

export interface RootModelCallReservation {
  reservationId: string;
  requestHash: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
}

export interface RootModelCallSettlement {
  dispatchState: 'not_dispatched' | 'dispatched';
  /** Null means the provider did not return trustworthy usage; a dispatched call is charged at its full reservation. */
  usage: { inputTokens: number; outputTokens: number } | null;
}

interface StoredReservation {
  reservation: RootTrialReservation;
  state: 'reserved' | 'settled';
  reservedAt: string;
  settlement?: RootTrialSettlement & { settlementHash: string; settledAt: string };
}

interface StoredModelCallReservation {
  reservation: RootModelCallReservation;
  state: 'reserved' | 'settled';
  reservedAt: string;
  settlement?: RootModelCallSettlement & { chargedCalls: number; chargedTokens: number; usageEstimated: boolean; reservationExceeded: boolean; settlementHash: string; settledAt: string };
}

interface LedgerState {
  schemaVersion: 1;
  revision: number;
  lastEventHash: string | null;
  searchId: string;
  planRef: ArtifactRef;
  limits: RootResearchBudget;
  startedAt: string;
  deadlineAt: string;
  precharge: RootBudgetPrecharge;
  reservations: Record<string, StoredReservation>;
  modelReservations: Record<string, StoredModelCallReservation>;
  /** Optional for compatibility with previously journaled v1 snapshots. */
  repairCharges?: Record<string, { evidenceRef: ArtifactRef; chargedAt: string }>;
}

const ROOT_METADATA_RESERVE_BYTES = 1024 * 1024;

export interface RootBudgetLedgerOptions {
  directory: string;
  searchId: string;
  planRef: ArtifactRef;
  limits: RootResearchBudget;
  precharge: RootBudgetPrecharge;
}

/**
 * Durable, single-writer accounting for one search root. A reservation is
 * committed before child-process creation. If the host disappears before it
 * publishes complete execution facts, the reservation remains open and blocks
 * new work until explicit reconciliation; this class never refunds uncertainty.
 */
export class RootBudgetLedger {
  private readonly directory: string;
  private readonly statePath: string;
  private readonly eventsPath: string;
  private readonly lockPath: string;
  private readonly searchId: string;
  private readonly planRef: ArtifactRef;
  private readonly limits: RootResearchBudget;
  private readonly precharge: RootBudgetPrecharge;

  constructor(options: RootBudgetLedgerOptions) {
    this.directory = path.resolve(options.directory);
    this.statePath = path.join(this.directory, 'budget-ledger.json');
    this.eventsPath = path.join(this.directory, 'budget-events.jsonl');
    this.lockPath = path.join(this.directory, 'budget-ledger.lock');
    this.searchId = requireId(options.searchId, 'searchId');
    this.planRef = validateRef(options.planRef, 'planRef');
    this.limits = validateBudget(options.limits);
    this.precharge = validatePrecharge(options.precharge);
    fs.mkdirSync(this.directory, { recursive: true });

    this.withLock(() => {
      if (fs.existsSync(this.statePath)) {
        const state = this.readState();
        this.assertSamePlan(state);
        return;
      }
      this.assertWithinBudget(this.precharge, 'precharged baseline evidence');
      const now = Date.now();
      const state: LedgerState = {
        schemaVersion: 1,
        revision: 0,
        lastEventHash: null,
        searchId: this.searchId,
        planRef: this.planRef,
        limits: this.limits,
        startedAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + this.limits.wallClockDeadlineMs).toISOString(),
        precharge: this.precharge,
        reservations: {},
        modelReservations: {},
      };
      this.appendEvent(state, 'ledger_created', { searchId: this.searchId, planRef: this.planRef, precharge: this.precharge });
    });
  }

  /** Reserve the complete serial sweep before the first child process starts. */
  reserveSweep(input: Omit<RootTrialReservation, 'maxExecutionMs' | 'maxMemoryBytes' | 'maxOutputBytesPerTrial'> & { serial?: boolean }): RootTrialReservation {
    const reservation: RootTrialReservation = {
      reservationId: requireId(input.reservationId, 'reservationId'),
      attemptId: requireId(input.attemptId, 'attemptId'),
      plannedTrials: requireInteger(input.plannedTrials, 'plannedTrials', 1),
      maxExecutionMs: 0,
      maxMemoryBytes: 0,
      maxOutputBytesPerTrial: 0,
      device: requireId(input.device, 'device'),
    };

    return this.withLock(() => {
      const state = this.readState();
      this.assertSamePlan(state);
      this.assertNoUnresolvedReservations(state);
      if (input.serial && this.used(state).reservedModelCalls > 0) throw new ExperimentError('HOST_BUSY', 'Research root already has an active or uncertain serial model reservation');
      const prior = state.reservations[reservation.reservationId];
      if (prior) {
        if (prior.reservation.attemptId !== reservation.attemptId ||
            prior.reservation.plannedTrials !== reservation.plannedTrials || prior.reservation.device !== reservation.device) {
          throw new ExperimentError('IDEMPOTENCY_CONFLICT', `reservation id ${reservation.reservationId} was reused with different content`);
        }
        throw new ExperimentError(prior.state === 'reserved' ? 'RECONCILIATION_REQUIRED' : 'IDEMPOTENCY_CONFLICT',
          `reservation ${reservation.reservationId} already exists in state ${prior.state}`);
      }
      if (!state.limits.allowedDevices.includes(reservation.device)) {
        throw new ExperimentError('POLICY_DENIED', `device ${reservation.device} is outside the root budget allowlist`);
      }
      if (Date.now() >= Date.parse(state.deadlineAt)) {
        throw new ExperimentError('BUDGET_EXHAUSTED', `search root wall deadline ${state.deadlineAt} has passed`);
      }
      const used = this.used(state);
      const remainingTrials = state.limits.maxTrials - used.trialCount;
      if (reservation.plannedTrials > remainingTrials) {
        throw new ExperimentError('BUDGET_EXHAUSTED', `sweep requires ${reservation.plannedTrials} trials; root has ${remainingTrials} remaining`);
      }
      const maxExecutionMs = reservation.plannedTrials * state.limits.perAttemptTimeoutMs;
      if (used.executionMs + maxExecutionMs > state.limits.maxExecutionSeconds * 1000) {
        throw new ExperimentError('BUDGET_EXHAUSTED', `sweep reserves ${maxExecutionMs}ms; the root execution-time ceiling would be exceeded`);
      }
      const remainingWallMs = Date.parse(state.deadlineAt) - Date.now();
      if (maxExecutionMs > remainingWallMs) {
        throw new ExperimentError('BUDGET_EXHAUSTED', `sweep requires up to ${maxExecutionMs}ms but only ${Math.max(0, remainingWallMs)}ms remain before the root deadline`);
      }
      // Keep an equal, conservative share for each remaining leaf. The child
      // runner enforces this output cap and the ledger charges both staged and
      // published copies, so an early small run does not consume later nodes' share.
      const searchRootBytes = measureSearchRootBytes(this.directory);
      const remainingDisk = state.limits.maxDiskBytes - searchRootBytes - used.diskBytes - ROOT_METADATA_RESERVE_BYTES;
      const perTrialShare = Math.floor(remainingDisk / Math.max(1, remainingTrials));
      const maxOutputBytesPerTrial = Math.floor(perTrialShare / 2);
      if (maxOutputBytesPerTrial <= 0) {
        throw new ExperimentError('BUDGET_EXHAUSTED', 'no disk allowance remains for a trial output directory');
      }
      const completed: RootTrialReservation = {
        ...reservation,
        maxExecutionMs,
        maxMemoryBytes: state.limits.maxMemoryBytes,
        maxOutputBytesPerTrial,
      };
      state.reservations[completed.reservationId] = {
        reservation: completed,
        state: 'reserved',
        reservedAt: new Date().toISOString(),
      };
      this.appendEvent(state, 'sweep_reserved', completed);
      return completed;
    });
  }

  /** Settle only from process facts returned by the pinned runner. */
  settleSweep(reservationId: string, settlement: RootTrialSettlement): string[] {
    const id = requireId(reservationId, 'reservationId');
    validateSettlement(settlement);
    return this.withLock(() => {
      const state = this.readState();
      this.assertSamePlan(state);
      const current = state.reservations[id];
      if (!current) throw new ExperimentError('NOT_FOUND', `root budget reservation ${id} does not exist`);
      const nextHash = typedHash('search-budget-settlement', settlement);
      if (current.state === 'settled') {
        if (current.settlement?.settlementHash !== nextHash) {
          throw new ExperimentError('RECONCILIATION_REQUIRED', `settled reservation ${id} was replayed with different facts`);
        }
        return [];
      }
      if (settlement.attemptedTrials > current.reservation.plannedTrials) {
        throw new ExperimentError('RECONCILIATION_REQUIRED', `reservation ${id} reports more trials than it reserved`);
      }
      const projectedDiskBytes = settlement.stagedOutputBytes * 2;
      const violations: string[] = [];
      if (settlement.executionMs > current.reservation.maxExecutionMs) violations.push('execution-time');
      if (settlement.peakWorkingSetBytes.some((bytes) => bytes > current.reservation.maxMemoryBytes)) violations.push('memory');
      if (projectedDiskBytes > current.reservation.maxOutputBytesPerTrial * settlement.attemptedTrials) violations.push('disk');
      current.state = 'settled';
      current.settlement = { ...settlement, settlementHash: nextHash, settledAt: new Date().toISOString() };
      this.appendEvent(state, 'sweep_settled', { reservationId: id, settlement: current.settlement });
      if (measureSearchRootBytes(this.directory) + this.used(state).diskBytes > state.limits.maxDiskBytes) violations.push('search-root-disk');
      return violations;
    });
  }

  /** Reserve the maximum single-call input/output token envelope before dispatching a provider request. */
  reserveModelCall(input: { reservationId: string; requestHash: string; maxInputTokens: number; maxOutputTokens: number;
    serial?: boolean;
    delegatedLimit?: { reservationPrefix: string; maxCalls: number; maxTokens: number } }): RootModelCallReservation {
    const reservationId = requireId(input.reservationId, 'reservationId');
    const requestHash = requireSha256(input.requestHash, 'requestHash');
    const maxInputTokens = requireInteger(input.maxInputTokens, 'maxInputTokens', 0);
    const maxOutputTokens = requireInteger(input.maxOutputTokens, 'maxOutputTokens', 0);
    const reservation: RootModelCallReservation = { reservationId, requestHash, maxInputTokens, maxOutputTokens, maxTotalTokens: maxInputTokens + maxOutputTokens };
    if (!Number.isSafeInteger(reservation.maxTotalTokens)) throw new ExperimentError('INVALID_INPUT', 'model-call token reservation exceeds the safe integer range');
    const delegated = input.delegatedLimit;
    if (delegated) {
      requireId(delegated.reservationPrefix, 'delegatedLimit.reservationPrefix');
      requireInteger(delegated.maxCalls, 'delegatedLimit.maxCalls', 1);
      requireInteger(delegated.maxTokens, 'delegatedLimit.maxTokens', 1);
      if (!reservationId.startsWith(delegated.reservationPrefix)) throw new ExperimentError('POLICY_DENIED', 'Delegated reservation prefix differs');
    }

    return this.withLock(() => {
      const state = this.readState();
      this.assertSamePlan(state);
      const prior = state.modelReservations[reservationId];
      if (prior) {
        const sameReservation = typedHash('search-model-call-reservation', prior.reservation) === typedHash('search-model-call-reservation', reservation);
        throw new ExperimentError(sameReservation && prior.state === 'reserved' ? 'RECONCILIATION_REQUIRED' : 'IDEMPOTENCY_CONFLICT',
          `model-call reservation ${reservationId} already exists in state ${prior.state}`);
      }
      if (Date.now() >= Date.parse(state.deadlineAt)) throw new ExperimentError('BUDGET_EXHAUSTED', `search root wall deadline ${state.deadlineAt} has passed`);
      const used = this.used(state);
      if (input.serial && (used.reservedModelCalls > 0 || used.unsettled > 0)) throw new ExperimentError('HOST_BUSY', 'Research root already has an active or uncertain serial process/model reservation');
      if (used.modelCalls + 1 > state.limits.maxModelCalls) throw new ExperimentError('BUDGET_EXHAUSTED', 'model-call ceiling would be exceeded');
      if (used.totalTokens + reservation.maxTotalTokens > state.limits.maxTotalTokens) throw new ExperimentError('BUDGET_EXHAUSTED', 'model-call token reservation would exceed the root token ceiling');
      if (delegated) {
        let calls = 0, tokens = 0;
        for (const entry of Object.values(state.modelReservations)) {
          if (!entry.reservation.reservationId.startsWith(delegated.reservationPrefix)) continue;
          calls += entry.state === 'reserved' ? 1 : entry.settlement!.chargedCalls;
          tokens += entry.state === 'reserved' ? entry.reservation.maxTotalTokens : entry.settlement!.chargedTokens;
        }
        if (calls + 1 > delegated.maxCalls || tokens + reservation.maxTotalTokens > delegated.maxTokens) {
          throw new ExperimentError('BUDGET_EXHAUSTED', 'Delegated model allowance would be exceeded');
        }
      }
      if (measureSearchRootBytes(this.directory) + used.diskBytes + ROOT_METADATA_RESERVE_BYTES > state.limits.maxDiskBytes) {
        throw new ExperimentError('BUDGET_EXHAUSTED', 'search-root disk reserve is too small for another model-call journal entry');
      }
      state.modelReservations[reservationId] = { reservation, state: 'reserved', reservedAt: new Date().toISOString() };
      this.appendEvent(state, 'model_call_reserved', reservation);
      return reservation;
    });
  }

  /** Settle from provider usage; unknown usage after dispatch consumes the full reservation. */
  settleModelCall(reservationId: string, settlementInput: RootModelCallSettlement): { chargedCalls: number; chargedTokens: number; usageEstimated: boolean; reservationExceeded: boolean } {
    const id = requireId(reservationId, 'reservationId');
    validateModelCallSettlement(settlementInput);
    return this.withLock(() => {
      const state = this.readState();
      this.assertSamePlan(state);
      const current = state.modelReservations[id];
      if (!current) throw new ExperimentError('NOT_FOUND', `model-call reservation ${id} does not exist`);
      const settlementHash = typedHash('search-model-call-settlement', settlementInput);
      if (current.state === 'settled') {
        if (current.settlement?.settlementHash !== settlementHash) throw new ExperimentError('RECONCILIATION_REQUIRED', `settled model-call reservation ${id} was replayed with different facts`);
        return { chargedCalls: current.settlement.chargedCalls, chargedTokens: current.settlement.chargedTokens, usageEstimated: current.settlement.usageEstimated,
          reservationExceeded: current.settlement.reservationExceeded };
      }
      if (settlementInput.dispatchState === 'not_dispatched' && settlementInput.usage !== null) {
        throw new ExperimentError('RECONCILIATION_REQUIRED', 'a non-dispatched model call cannot carry provider token usage');
      }
      const reservationExceeded = settlementInput.usage !== null &&
        (settlementInput.usage.inputTokens > current.reservation.maxInputTokens || settlementInput.usage.outputTokens > current.reservation.maxOutputTokens);
      const usageEstimated = settlementInput.dispatchState === 'dispatched' && settlementInput.usage === null;
      const chargedCalls = settlementInput.dispatchState === 'dispatched' ? 1 : 0;
      const chargedTokens = settlementInput.dispatchState === 'not_dispatched' ? 0 : usageEstimated
        ? current.reservation.maxTotalTokens
        : settlementInput.usage!.inputTokens + settlementInput.usage!.outputTokens;
      current.state = 'settled';
      current.settlement = { ...structuredClone(settlementInput), chargedCalls, chargedTokens, usageEstimated, reservationExceeded, settlementHash, settledAt: new Date().toISOString() };
      this.appendEvent(state, 'model_call_settled', { reservationId: id, settlement: current.settlement });
      return { chargedCalls, chargedTokens, usageEstimated, reservationExceeded };
    });
  }

  /** Irreversible repair admission; replay is safe only for the exact same evidence. */
  consumeRepair(input: { chargeId: string; evidenceRef: ArtifactRef;
    delegatedLimit?: { chargePrefix: string; maxAttempts: number } }): string {
    const chargeId = requireId(input.chargeId, 'chargeId');
    const evidenceRef = validateRef(input.evidenceRef, 'evidenceRef');
    const delegated = input.delegatedLimit;
    if (delegated) {
      requireId(delegated.chargePrefix, 'chargePrefix');
      requireInteger(delegated.maxAttempts, 'maxAttempts', 0);
      if (!chargeId.startsWith(delegated.chargePrefix)) throw new ExperimentError('POLICY_DENIED', 'Repair charge differs from delegated scope');
    }
    return this.withLock(() => {
      const state = this.readState(); this.assertSamePlan(state);
      const existing = state.repairCharges?.[chargeId];
      if (existing) {
        if (typedHash('repair-charge-evidence-v1', existing.evidenceRef) !== typedHash('repair-charge-evidence-v1', evidenceRef)) {
          throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'Repair charge replay changed evidence');
        }
        return typedHash('repair-charge-receipt-v1', { searchId: state.searchId, planRef: state.planRef, chargeId, evidenceRef });
      }
      if (Date.now() >= Date.parse(state.deadlineAt)) throw new ExperimentError('BUDGET_EXHAUSTED', 'Root repair deadline passed');
      const charges = state.repairCharges ?? {};
      const consumed = state.precharge.repairAttempts + Object.keys(charges).length;
      if (consumed + 1 > state.limits.maxRepairAttempts) throw new ExperimentError('REPAIR_EXHAUSTED', 'Root repair ceiling reached');
      if (delegated && Object.keys(charges).filter((id) => id.startsWith(delegated.chargePrefix)).length + 1 > delegated.maxAttempts) {
        throw new ExperimentError('REPAIR_EXHAUSTED', 'Delegated repair ceiling reached');
      }
      const used = this.used(state);
      if (measureSearchRootBytes(this.directory) + used.diskBytes + ROOT_METADATA_RESERVE_BYTES > state.limits.maxDiskBytes) {
        throw new ExperimentError('BUDGET_EXHAUSTED', 'Root disk allowance is insufficient for repair admission');
      }
      state.repairCharges = { ...charges, [chargeId]: { evidenceRef, chargedAt: new Date().toISOString() } };
      this.appendEvent(state, 'repair_charged', { chargeId, evidenceRef });
      return typedHash('repair-charge-receipt-v1', { searchId: state.searchId, planRef: state.planRef, chargeId, evidenceRef });
    });
  }

  snapshot(): Record<string, unknown> {
    return this.withLock(() => {
      const state = this.readState();
      this.assertSamePlan(state);
      const usage = this.used(state);
      const searchRootBytes = measureSearchRootBytes(this.directory);
      return {
        schemaVersion: state.schemaVersion,
        searchId: state.searchId,
        planRef: state.planRef,
        limits: state.limits,
        startedAt: state.startedAt,
        deadlineAt: state.deadlineAt,
        precharge: state.precharge,
        usage,
        reservations: Object.values(state.reservations),
          modelReservations: Object.values(state.modelReservations),
          repairAttempts: state.precharge.repairAttempts + Object.keys(state.repairCharges ?? {}).length,
          repairCharges: state.repairCharges ?? {},
        searchRootBytes,
        projectedFullDiskBytes: searchRootBytes + usage.diskBytes,
        budgetExceeded: usage.trialCount > state.limits.maxTrials || usage.executionMs > state.limits.maxExecutionSeconds * 1000 ||
          usage.modelCalls > state.limits.maxModelCalls || usage.totalTokens > state.limits.maxTotalTokens || searchRootBytes + usage.diskBytes > state.limits.maxDiskBytes,
        ledgerHash: typedHash('search-root-budget-ledger', state),
        lastEventHash: state.lastEventHash,
      };
    });
  }

  private used(state: LedgerState): { trialCount: number; executionMs: number; diskBytes: number; unsettled: number; modelCalls: number; totalTokens: number; reservedModelCalls: number; reservedTokens: number } {
    const usage = { trialCount: state.precharge.trialCount, executionMs: state.precharge.executionMs, diskBytes: state.precharge.diskBytes, unsettled: 0, modelCalls: state.precharge.modelCalls, totalTokens: state.precharge.totalTokens, reservedModelCalls: 0, reservedTokens: 0 };
    for (const entry of Object.values(state.reservations)) {
      if (entry.state === 'reserved') {
        usage.unsettled += 1;
        usage.trialCount += entry.reservation.plannedTrials;
        usage.executionMs += entry.reservation.maxExecutionMs;
      } else if (entry.settlement) {
        usage.trialCount += entry.settlement.attemptedTrials;
        usage.executionMs += entry.settlement.executionMs;
        usage.diskBytes += entry.settlement.stagedOutputBytes * 2;
      }
    }
    for (const entry of Object.values(state.modelReservations)) {
      if (entry.state === 'reserved') {
        usage.reservedModelCalls += 1;
        usage.reservedTokens += entry.reservation.maxTotalTokens;
      } else if (entry.settlement) {
        usage.modelCalls += entry.settlement.chargedCalls;
        usage.totalTokens += entry.settlement.chargedTokens;
      }
    }
    usage.modelCalls += usage.reservedModelCalls;
    usage.totalTokens += usage.reservedTokens;
    return usage;
  }

  private assertNoUnresolvedReservations(state: LedgerState): void {
    const open = Object.entries(state.reservations).find(([, entry]) => entry.state === 'reserved');
    if (open) {
      throw new ExperimentError('RECONCILIATION_REQUIRED', `root reservation ${open[0]} has no terminal process facts; refusing another leaf`);
    }
  }

  private assertWithinBudget(charge: RootBudgetPrecharge, label: string): void {
    const violations: string[] = [];
    if (charge.trialCount > this.limits.maxTrials) violations.push('maxTrials');
    if (charge.executionMs > this.limits.maxExecutionSeconds * 1000) violations.push('maxExecutionSeconds');
    if (charge.modelCalls > this.limits.maxModelCalls) violations.push('maxModelCalls');
    if (charge.totalTokens > this.limits.maxTotalTokens) violations.push('maxTotalTokens');
    if (charge.repairAttempts > this.limits.maxRepairAttempts) violations.push('maxRepairAttempts');
    if (charge.diskBytes > this.limits.maxDiskBytes) violations.push('maxDiskBytes');
    if (violations.length) throw new ExperimentError('BUDGET_EXHAUSTED', `${label} already exceeds ${violations.join(', ')}`);
  }

  private assertSamePlan(state: LedgerState): void {
    if (state.schemaVersion !== 1 || state.searchId !== this.searchId || state.planRef.id !== this.planRef.id || state.planRef.sha256 !== this.planRef.sha256) {
      throw new ExperimentError('RECONCILIATION_REQUIRED', 'root budget ledger identity differs from the frozen SearchPlan');
    }
    if (typedHash('search-budget-limits', state.limits) !== typedHash('search-budget-limits', this.limits) ||
        typedHash('search-budget-precharge', state.precharge) !== typedHash('search-budget-precharge', this.precharge)) {
      throw new ExperimentError('RECONCILIATION_REQUIRED', 'root budget ledger limits or precharge differ from the frozen SearchPlan');
    }
  }

  private readState(): LedgerState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (error) {
      throw new ExperimentError('RECONCILIATION_REQUIRED', `root budget ledger is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ExperimentError('RECONCILIATION_REQUIRED', 'root budget ledger root is not an object');
    }
    const state = parsed as LedgerState;
    if (!state.modelReservations) state.modelReservations = {};
    if (!state.reservations || typeof state.reservations !== 'object' || Array.isArray(state.reservations)) {
      throw new ExperimentError('RECONCILIATION_REQUIRED', 'root budget ledger reservations are malformed');
    }
    this.verifyEventChain(state);
    return state;
  }

  private appendEvent(state: LedgerState, eventType: string, body: unknown): void {
    const eventState = {
      ...state,
      revision: state.revision + 1,
      lastEventHash: null,
    };
    const core = {
      schemaVersion: 1,
      revision: eventState.revision,
      eventType,
      occurredAt: new Date().toISOString(),
      previousEventHash: state.lastEventHash,
      body,
      stateHash: typedHash('search-root-budget-state-v1', eventState),
    };
    const eventHash = typedHash('search-root-budget-event', core);
    const line = `${JSON.stringify({ ...core, eventHash })}\n`;
    const descriptor = fs.openSync(this.eventsPath, 'a');
    try {
      fs.writeSync(descriptor, line, null, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    state.revision = core.revision;
    state.lastEventHash = eventHash;
    this.writeState(state);
  }

  private verifyEventChain(state: LedgerState): void {
    if (!fs.existsSync(this.eventsPath)) throw new ExperimentError('RECONCILIATION_REQUIRED', 'root budget event log is missing');
    const bytes = fs.readFileSync(this.eventsPath, 'utf8');
    const lines = bytes.split(/\r?\n/).filter((line) => line.length > 0);
    let expectedRevision = 1;
    let previousEventHash: string | null = null;
    let latestStateHash: string | null = null;
    for (const [index, line] of lines.entries()) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch (error) {
        throw new ExperimentError('RECONCILIATION_REQUIRED', `root budget event ${index + 1} is malformed: ${String(error)}`);
      }
      const { eventHash, ...core } = event;
      if (core.schemaVersion !== 1 || core.revision !== expectedRevision || core.previousEventHash !== previousEventHash ||
          typeof eventHash !== 'string' || typedHash('search-root-budget-event', core) !== eventHash) {
        throw new ExperimentError('RECONCILIATION_REQUIRED', `root budget event chain is invalid at revision ${expectedRevision}`);
      }
      if ('stateHash' in core && (typeof core.stateHash !== 'string' || !/^[0-9a-f]{64}$/.test(core.stateHash))) {
        throw new ExperimentError('RECONCILIATION_REQUIRED', `root budget event ${expectedRevision} has an invalid state hash`);
      }
      latestStateHash = typeof core.stateHash === 'string' ? core.stateHash : null;
      previousEventHash = eventHash;
      expectedRevision += 1;
    }
    if (state.revision !== lines.length || state.lastEventHash !== previousEventHash) {
      throw new ExperimentError('RECONCILIATION_REQUIRED', 'root budget snapshot and append-only event log disagree');
    }
    if (latestStateHash) {
      const normalized = { ...state, lastEventHash: null };
      if (typedHash('search-root-budget-state-v1', normalized) !== latestStateHash) {
        throw new ExperimentError('RECONCILIATION_REQUIRED', 'root budget state does not match the latest journaled state hash');
      }
    }
  }

  private writeState(state: LedgerState): void {
    const temporaryPath = `${this.statePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      fs.renameSync(temporaryPath, this.statePath);
    } catch (error) {
      try { fs.rmSync(temporaryPath, { force: true }); } catch { /* preserve the original rename error */ }
      throw new ExperimentError('RECONCILIATION_REQUIRED', `could not atomically update root budget ledger: ${String(error)}`);
    }
  }

  private withLock<T>(work: () => T): T {
    const nonce = crypto.randomUUID();
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(this.lockPath, 'wx');
      fs.writeFileSync(descriptor, JSON.stringify({ nonce, pid: process.pid, acquiredAt: new Date().toISOString() }), 'utf8');
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* preserve acquisition failure */ }
        try { fs.unlinkSync(this.lockPath); } catch { /* retain stale lock for explicit reconciliation */ }
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        let stale = false;
        try { stale = Date.now() - fs.statSync(this.lockPath).mtimeMs > 30_000; } catch { /* missing or unreadable lock requires review below */ }
        throw new ExperimentError(stale ? 'RECONCILIATION_REQUIRED' : 'HOST_BUSY', stale
          ? 'root budget ledger lock is stale; inspect and reconcile it before continuing'
          : 'another writer currently owns the root budget ledger');
      }
      throw error;
    }
    try {
      return work();
    } finally {
      try {
        const lock = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { nonce?: string };
        if (lock.nonce !== nonce) throw new Error('ledger lock owner changed');
        fs.closeSync(descriptor);
        fs.unlinkSync(this.lockPath);
      } catch (error) {
        try { fs.closeSync(descriptor); } catch { /* already closed */ }
        throw new ExperimentError('RECONCILIATION_REQUIRED', `root budget ledger lock could not be safely released: ${String(error)}`);
      }
    }
  }
}

function requireId(value: string, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new ExperimentError('INVALID_INPUT', `${field} must be a stable non-empty identifier`, { fieldPaths: [field] });
  }
  return value;
}

function requireInteger(value: number, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ExperimentError('INVALID_INPUT', `${field} must be an integer >= ${minimum}`, { fieldPaths: [field] });
  }
  return value;
}

function requireSha256(value: string, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ExperimentError('INVALID_INPUT', `${field} must be a lowercase SHA-256`, { fieldPaths: [field] });
  }
  return value;
}

function validateRef(value: ArtifactRef, field: string): ArtifactRef {
  if (!value || typeof value.id !== 'string' || !value.id || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new ExperimentError('INVALID_INPUT', `${field} must carry an id and SHA-256`, { fieldPaths: [field] });
  }
  return { id: value.id, sha256: value.sha256 };
}

function validateBudget(value: RootResearchBudget): RootResearchBudget {
  const fields: Array<keyof Omit<RootResearchBudget, 'allowedDevices'>> = [
    'maxModelCalls', 'maxTotalTokens', 'maxExecutionSeconds', 'maxTrials', 'maxRepairAttempts',
    'perAttemptTimeoutMs', 'wallClockDeadlineMs', 'maxMemoryBytes', 'maxDiskBytes',
  ];
  for (const field of fields) {
    const number = value?.[field];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) {
      throw new ExperimentError('CONFIG_INCOMPLETE', `root budget ${field} must be a finite non-negative number`, { fieldPaths: [`rootBudget.${field}`] });
    }
  }
  if (value.maxTrials <= 0 || value.perAttemptTimeoutMs <= 0 || value.wallClockDeadlineMs <= 0 || value.maxMemoryBytes <= 0 || value.maxDiskBytes <= 0 ||
      !Array.isArray(value.allowedDevices) || value.allowedDevices.length === 0 || value.allowedDevices.some((device) => typeof device !== 'string' || !device)) {
    throw new ExperimentError('CONFIG_INCOMPLETE', 'root budget has an unset required execution or resource ceiling');
  }
  return structuredClone(value);
}

function validatePrecharge(value: RootBudgetPrecharge): RootBudgetPrecharge {
  const fields: Array<keyof Omit<RootBudgetPrecharge, 'evidenceRefs'>> = ['trialCount', 'executionMs', 'modelCalls', 'totalTokens', 'repairAttempts', 'diskBytes'];
  for (const field of fields) requireInteger(value?.[field], `precharge.${field}`, 0);
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0) {
    throw new ExperimentError('CONFIG_INCOMPLETE', 'precharged cost requires source evidence refs', { fieldPaths: ['precharge.evidenceRefs'] });
  }
  return structuredClone({ ...value, evidenceRefs: value.evidenceRefs.map((ref, index) => validateRef(ref, `precharge.evidenceRefs[${index}]`)) });
}

function validateSettlement(value: RootTrialSettlement): void {
  requireInteger(value?.attemptedTrials, 'settlement.attemptedTrials', 0);
  requireInteger(value?.executionMs, 'settlement.executionMs', 0);
  requireInteger(value?.stagedOutputBytes, 'settlement.stagedOutputBytes', 0);
  if (value.executionFactsComplete !== true || !Array.isArray(value.peakWorkingSetBytes) || value.peakWorkingSetBytes.length !== value.attemptedTrials) {
    throw new ExperimentError('RECONCILIATION_REQUIRED', 'root budget settlement needs one complete process fact set per attempted trial');
  }
  value.peakWorkingSetBytes.forEach((bytes, index) => requireInteger(bytes, `settlement.peakWorkingSetBytes[${index}]`, 0));
}

function validateModelCallSettlement(value: RootModelCallSettlement): void {
  if (!value || (value.dispatchState !== 'not_dispatched' && value.dispatchState !== 'dispatched')) {
    throw new ExperimentError('RECONCILIATION_REQUIRED', 'model-call settlement has an invalid dispatch state');
  }
  if (value.usage !== null) {
    requireInteger(value.usage?.inputTokens, 'settlement.usage.inputTokens', 0);
    requireInteger(value.usage?.outputTokens, 'settlement.usage.outputTokens', 0);
  }
}

/** Measure durable file sizes in a search root without following links or Windows junctions. */
export function measureSearchRootBytes(directory: string): number {
  const root = path.resolve(directory);
  if (!fs.existsSync(root)) return 0;
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new ExperimentError('RECONCILIATION_REQUIRED', 'search-root disk scan requires a physical directory root');
  const pending = [root];
  let total = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'budget-ledger.lock' || entry.name === '.writer.lock' || entry.name === '.recovery.lock') continue;
      const fullPath = path.join(current, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new ExperimentError('RECONCILIATION_REQUIRED', `search-root disk scan refuses a symbolic link or junction: ${fullPath}`);
      if (stat.isDirectory()) pending.push(fullPath);
      else if (stat.isFile()) total += stat.size;
      else throw new ExperimentError('RECONCILIATION_REQUIRED', `search-root disk scan found an unsupported filesystem object: ${fullPath}`);
    }
  }
  if (!Number.isSafeInteger(total)) throw new ExperimentError('RECONCILIATION_REQUIRED', 'search-root disk size exceeds the safe integer range');
  return total;
}
