/** Model suggestions and user choices for external experiment results. A suggestion is not a human review and is not execution authority. */
import { hash, list, num, object, one, str } from './general-data.ts';

export interface ExternalResultAction {
  title: string;
  reason: string;
  prerequisite: string;
  condition: string;
  verification: string;
  resource: string;
}
export interface ExternalResultReview {
  reviewId: string;
  reportIds: string[];
  judgment: 'support' | 'counter' | 'insufficient' | 'mixed';
  boundary: string;
  support: string;
  counterEvidence: string;
  gaps: string;
  ranked: false;
  nextActions: ExternalResultAction[];
  actor: { kind: 'model'; identity: string };
  createdAt: string;
  /** Present only when the review pinned its dependencies. Older reviews omit it. */
  contextHash?: string;
  sourcePins?: { sourceId: string; sha256: string; accessDecisionId: string }[];
  protocolPins?: { protocolId: string; version: number; contextHash: string }[];
}
export interface ExternalResultDecision {
  decisionId: string;
  reviewId: string;
  actionIndex: number;
  choice: 'accept' | 'modify' | 'reject' | 'defer';
  reason: string;
  utterance: string;
  modifiedTitle: string | null;
  nodeId: string | null;
  actor: { kind: 'user'; identity: string; relayedBy: string };
  createdAt: string;
  /** Host message that carried the choice. Absent on decisions saved before that check. */
  messageId?: string;
  sessionId?: string;
  provenance?: 'trusted' | 'unverified' | 'user_action';
  actionId?: string;
  actionSource?: 'http' | 'cli';
  supersedes?: string | null;
}

function date(v: unknown, label: string): string {
  const s = str(v, label, 100, true);
  if (!Number.isFinite(Date.parse(s))) throw new Error('Invalid ' + label);
  return s;
}
function action(v: unknown): ExternalResultAction {
  const a = object(v, ['title', 'reason', 'prerequisite', 'condition', 'verification', 'resource'], 'external result action');
  return {
    title: str(a.title, 'action title', 300, true),
    reason: str(a.reason, 'action reason', 4000, true),
    prerequisite: str(a.prerequisite, 'action prerequisite', 4000, true),
    condition: str(a.condition, 'action condition', 4000, true),
    verification: str(a.verification, 'action verification', 4000, true),
    resource: str(a.resource, 'action resource', 4000, true),
  };
}
function sourcePin(v: unknown): { sourceId: string; sha256: string; accessDecisionId: string } {
  const p = object(v, ['sourceId', 'sha256', 'accessDecisionId'], 'review source pin');
  return { sourceId: str(p.sourceId, 'sourceId', 200, true), sha256: hash(p.sha256), accessDecisionId: str(p.accessDecisionId, 'accessDecisionId', 200, true) };
}
function protocolPin(v: unknown): { protocolId: string; version: number; contextHash: string } {
  const p = object(v, ['protocolId', 'version', 'contextHash'], 'review protocol pin');
  return { protocolId: str(p.protocolId, 'protocolId', 200, true), version: num(p.version, 'protocol version', 1, 10000), contextHash: hash(p.contextHash) };
}
export function validateExternalResultReview(v: unknown): ExternalResultReview {
  const r = object(v, ['reviewId', 'reportIds', 'judgment', 'boundary', 'support', 'counterEvidence', 'gaps', 'ranked', 'nextActions', 'actor', 'createdAt', 'contextHash', 'sourcePins', 'protocolPins'], 'external result review', ['contextHash', 'sourcePins', 'protocolPins']);
  const reportIds = list(r.reportIds, 'review reports', 50).map(id => str(id, 'reportId', 200, true));
  if (!reportIds.length || new Set(reportIds).size !== reportIds.length) throw new Error('External result review needs distinct reports');
  if (r.ranked !== false) throw new Error('External result review cannot rank source reports');
  const actor = object(r.actor, ['kind', 'identity'], 'review actor');
  if (actor.kind !== 'model') throw new Error('External result review actor must be the model');
  const nextActions = list(r.nextActions, 'next actions', 8).map(action);
  if (!nextActions.length) throw new Error('External result review needs a next action');
  return {
    reviewId: str(r.reviewId, 'reviewId', 200, true),
    reportIds,
    judgment: one(r.judgment, ['support', 'counter', 'insufficient', 'mixed'] as const, 'judgment'),
    boundary: str(r.boundary, 'boundary', 4000, true),
    support: str(r.support, 'support', 4000),
    counterEvidence: str(r.counterEvidence, 'counterEvidence', 4000),
    gaps: str(r.gaps, 'gaps', 4000, true),
    ranked: false,
    nextActions,
    actor: { kind: 'model', identity: str(actor.identity, 'actor identity', 200, true) },
    createdAt: date(r.createdAt, 'review createdAt'),
    ...(r.contextHash === undefined ? {} : {
      contextHash: hash(r.contextHash),
      sourcePins: list(r.sourcePins, 'review source pins', 50).map(sourcePin),
      protocolPins: list(r.protocolPins, 'review protocol pins', 20).map(protocolPin),
    }),
  };
}
export function validateExternalResultDecision(v: unknown): ExternalResultDecision {
  const d = object(v, ['decisionId', 'reviewId', 'actionIndex', 'choice', 'reason', 'utterance', 'modifiedTitle', 'nodeId', 'actor', 'createdAt', 'messageId', 'sessionId', 'provenance', 'supersedes', 'actionId', 'actionSource'], 'external result decision', ['messageId', 'sessionId', 'provenance', 'supersedes', 'actionId', 'actionSource']);
  const actor = object(d.actor, ['kind', 'identity', 'relayedBy'], 'decision actor');
  if (actor.kind !== 'user') throw new Error('External result decision actor must be the user');
  const choice = one(d.choice, ['accept', 'modify', 'reject', 'defer'] as const, 'decision choice');
  const modifiedTitle = d.modifiedTitle === null ? null : str(d.modifiedTitle, 'modified title', 300, true);
  if ((choice === 'modify') !== (modifiedTitle !== null)) throw new Error('Only a modified decision carries a replacement title');
  if (d.provenance === 'user_action' && (d.messageId !== undefined || d.sessionId !== undefined)) throw new Error('A standalone user action cannot impersonate a host message');
  if (d.provenance !== 'user_action' && (d.actionId !== undefined || d.actionSource !== undefined)) throw new Error('Standalone decision provenance must be explicit');
  return {
    decisionId: str(d.decisionId, 'decisionId', 200, true),
    reviewId: str(d.reviewId, 'reviewId', 200, true),
    actionIndex: num(d.actionIndex, 'actionIndex', 0, 7),
    choice,
    reason: str(d.reason, 'decision reason', 4000, true),
    utterance: str(d.utterance, 'user utterance', 4000, true),
    modifiedTitle,
    nodeId: d.nodeId === null ? null : str(d.nodeId, 'decision node', 200, true),
    actor: { kind: 'user', identity: str(actor.identity, 'decision identity', 200, true), relayedBy: str(actor.relayedBy, 'relayedBy', 200, true) },
    createdAt: date(d.createdAt, 'decision createdAt'),
    ...(d.provenance === 'user_action' ? { provenance: 'user_action' as const, actionId: str(d.actionId, 'actionId', 200, true), actionSource: one(d.actionSource, ['http', 'cli'] as const, 'actionSource'), supersedes: d.supersedes === null ? null : str(d.supersedes, 'supersedes', 200, true) } : {}),
    ...(d.messageId === undefined ? {} : {
      messageId: str(d.messageId, 'messageId', 200, true),
      sessionId: str(d.sessionId, 'sessionId', 200, true),
      provenance: one(d.provenance, ['trusted', 'unverified'] as const, 'decision provenance'),
      supersedes: d.supersedes === null ? null : str(d.supersedes, 'supersedes', 200, true),
    }),
  };
}
