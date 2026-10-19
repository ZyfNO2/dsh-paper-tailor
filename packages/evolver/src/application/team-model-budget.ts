/** Model admission uses the same durable ledger as experimental leaf processes. */
import { ExperimentError } from '../contracts/experiments.ts';
import { researchInteger } from '../contracts/research-command.ts';
import { expAssertId } from '../contracts/experiments.ts';
import { typedHash } from '../domain/research-canonical.ts';
import { RootBudgetLedger, type RootModelCallReservation, type RootModelCallSettlement } from './research-budget.ts';
import { TeamResearchService } from './team-research-service.ts';

export class TeamModelBudget {
  private readonly service: TeamResearchService;
  private readonly ledger: RootBudgetLedger;

  constructor(service: TeamResearchService, ledger: RootBudgetLedger) {
    this.service = service;
    this.ledger = ledger;
  }

  /** The trusted provider boundary must honor the admitted token envelope. */
  async call<T>(caller: unknown, input: {
    callId: string; request: unknown; maxInputTokens: number; maxOutputTokens: number; serial?: boolean;
  }, signal: AbortSignal, dispatch: (reservation: RootModelCallReservation, signal: AbortSignal) => Promise<{
    result: T; usage: RootModelCallSettlement['usage'];
  }>): Promise<T> {
    if (signal.aborted) throw new ExperimentError('POLICY_DENIED', 'Cancelled before model admission');
    const grant = this.service.authorize(caller);
    const callId = expAssertId(input.callId, 'callId');
    const maxInputTokens = researchInteger(input.maxInputTokens, 'maxInputTokens', 0);
    const maxOutputTokens = researchInteger(input.maxOutputTokens, 'maxOutputTokens', 0);
    const tokens = researchInteger(maxInputTokens + maxOutputTokens, 'maxTotalTokens', 1);
    const prefix = `team-model-${grant.grantId}-`;
    const snapshot = this.ledger.snapshot() as {
      modelReservations: Array<{ reservation: RootModelCallReservation; state: string;
        settlement?: { chargedCalls: number; chargedTokens: number } }>;
    };
    let usedCalls = 0, usedTokens = 0;
    for (const entry of snapshot.modelReservations) {
      if (!entry.reservation.reservationId.startsWith(prefix)) continue;
      usedCalls += entry.state === 'reserved' ? 1 : entry.settlement!.chargedCalls;
      usedTokens += entry.state === 'reserved' ? entry.reservation.maxTotalTokens : entry.settlement!.chargedTokens;
    }
    if (usedCalls + 1 > grant.roleConfiguration.limits.maxModelCalls ||
        usedTokens + tokens > grant.roleConfiguration.limits.maxTotalTokens) {
      throw new ExperimentError('BUDGET_EXHAUSTED', 'Delegated role model allowance would be exceeded');
    }
    const reservation = this.ledger.reserveModelCall({
      reservationId: `${prefix}${typedHash('team-model-call-id-v1', callId)}`,
      requestHash: typedHash('team-model-request-v1', { request: input.request, grantId: grant.grantId,
        roleConfigurationRef: grant.roleConfigurationRef, maxInputTokens, maxOutputTokens }),
      maxInputTokens, maxOutputTokens,
      serial: input.serial,
      delegatedLimit: { reservationPrefix: prefix, maxCalls: grant.roleConfiguration.limits.maxModelCalls,
        maxTokens: grant.roleConfiguration.limits.maxTotalTokens },
    });
    let dispatched = false;
    let settled = false;
    try {
      // Source revocation and cancellation may have happened during disk admission.
      this.service.authorize(caller);
      if (signal.aborted) throw new ExperimentError('POLICY_DENIED', 'Cancelled before provider dispatch');
      dispatched = true;
      const response = await dispatch(reservation, signal);
      const facts = this.ledger.settleModelCall(reservation.reservationId, { dispatchState: 'dispatched', usage: response.usage });
      settled = true;
      if (facts.reservationExceeded) throw new ExperimentError('BUDGET_EXHAUSTED', 'Provider exceeded its admitted model token envelope');
      return response.result;
    } catch (error: unknown) {
      if (!settled) {
        try {
          this.ledger.settleModelCall(reservation.reservationId, { dispatchState: dispatched ? 'dispatched' : 'not_dispatched', usage: null });
        } catch (settlementError: unknown) {
          throw new AggregateError([error, settlementError], 'Model call failed and durable cost settlement also failed; reconciliation required');
        }
      }
      throw error;
    }
  }
}
