/**
 * Batch 3: register an external experiment result against the current research.
 *
 * Plan: docs/mvp/MVP-TAKEOVER-BATCH-03-WORKER-PLAN-2026-10-16.md
 *
 * Numbers are checked against the file's table cell or a failure quote before a report is saved.
 * The file's run id may match an existing experiment. Same directory alone stays pending.
 * A model suggestion cannot accept a follow-up. Only a user utterance that states the choice can,
 * and the new node stays not_started.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { BootstrapError } from '../contracts/research-bootstrap.ts';
import { DATA_LIMITS, type RawCell } from '../contracts/general-data.ts';
import { isSafeRelativePath } from '../contracts/research-takeover.ts';
import type { GeneralMetric, GeneralMetricProtocol, GeneralMetricReport } from '../contracts/general-metrics.ts';
import { validateMetricIdentityHistory, validateMetricProtocol, validateMetricReport } from '../contracts/general-metrics.ts';
import { validateExternalResultDecision, validateExternalResultReview, type ExternalResultAction, type ExternalResultReview } from '../contracts/external-result.ts';
import { validateGeneralResearch, type GeneralResearch } from '../contracts/general-research.ts';
import { validateGeneralGraph, validateGeneralNode } from '../contracts/general-workflow.ts';
import { ResearchBootstrapStore, requireResearch, type MutationResult } from './research-bootstrap-store.ts';
import { GeneralDataService } from './general-data-service.ts';
import { GeneralMaterialStore, sha256 } from './general-material-store.ts';
import { generalContextHash } from './general-analysis-service.ts';
import { assertGeneralSourceAccess } from './general-source-access.ts';
import { recordGeneralEdit } from './general-edit-history.ts';

const NATURES = ['simulation', 'user_result'] as const;
type Nature = typeof NATURES[number];
export interface ExternalValueInput { name: string; value: number | null; unit: string; row: number; column: number }
export interface ExternalConditionInput { name: string; value: string | null; unit: string | null }
export interface ExternalResultInput {
  operationId: string;
  baseRevision: number;
  researchId: string;
  relativePath: string;
  nature: Nature;
  label: string;
  externalRunId?: string | null;
  clarification?: string | null;
  values: ExternalValueInput[];
  failureQuote?: string | null;
  conditions: ExternalConditionInput[];
}
export interface ExternalReviewInput {
  operationId: string;
  baseRevision: number;
  researchId: string;
  reportIds: string[];
  judgment: 'support' | 'counter' | 'insufficient' | 'mixed';
  boundary: string;
  support: string;
  counterEvidence: string;
  gaps: string;
  nextActions: ExternalResultAction[];
}
export interface ExternalDecisionInput {
  operationId: string;
  baseRevision: number;
  researchId: string;
  reviewId: string;
  actionIndex: number;
  choice: 'accept' | 'modify' | 'reject' | 'defer';
  utterance: string;
  modifiedTitle?: string | null;
}
/** A user message read by the host from this session. The model cannot mint one. */
export interface TrustedUserMessage { sessionId: string; messageId: string; text: string }

const CHOICE_WORDS: Record<ExternalDecisionInput['choice'], RegExp[]> = {
  accept: [/接受/, /采纳/, /就按这个/, /按这个做/],
  reject: [/拒绝/, /不采纳/, /不要这条/],
  defer: [/暂缓/, /以后再说/, /先放着/],
  modify: [/改成/, /修改为/, /改为/],
};

function childOperation(operationId: string, suffix: string): string {
  const raw = `${operationId}:${suffix}`;
  return raw.length <= 180 ? raw : sha256(raw);
}
function numericToken(cell: RawCell): { token: string; value: number } | null {
  if (typeof cell === 'boolean' || cell === null) return null;
  const token = (typeof cell === 'number' ? String(cell) : cell.trim());
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(token)) return null;
  const value = Number(token);
  return Number.isFinite(value) ? { token, value } : null;
}
function foldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}
function headerMatches(header: string, name: string): boolean {
  const left = foldName(header), right = foldName(name);
  return Boolean(left) && Boolean(right) && (left === right || left.startsWith(right) || right.startsWith(left));
}
function unitInHeader(header: string): string | null {
  const match = header.match(/\(([^)]+)\)|\[([^\]]+)\]/);
  const unit = (match?.[1] ?? match?.[2] ?? '').trim();
  return unit || null;
}
const RATIO_NAMES = new Set(['miou', 'iou', 'dice', 'f1', 'acc', 'accuracy', 'map']);
const STEP_NAMES = new Set(['epoch', 'step', 'iter', 'iteration', 'batch']);
const NEGATED_ACCEPT = /不接受|没有接受|未接受|并未接受|不是接受|不要接受|没有说接受|未说接受/g;
function runIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\brun_id\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._:-]{1,80})/g)].map(match => match[1]))];
}
function conditionKey(report: GeneralMetricReport): string {
  return JSON.stringify([...report.conditions].map(c => [c.name, c.value, c.unit]).sort());
}
function metricName(protocols: GeneralMetricProtocol[], report: GeneralMetricReport, metricId: string): string {
  return protocols.find(p => p.protocolId === report.protocolId && p.version === report.version)?.metrics.find(m => m.metricId === metricId)?.name ?? metricId;
}

export class ExternalResultService {
  readonly store: ResearchBootstrapStore;
  constructor(store: ResearchBootstrapStore) { this.store = store; }

  register(input: ExternalResultInput, trusted: TrustedUserMessage | null = null): MutationResult<Record<string, unknown>> {
    const relativePath = input.relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!isSafeRelativePath(relativePath) || relativePath.split('/').includes('.dsh')) throw new BootstrapError('INVALID_INPUT', '结果文件必须是工作区内的相对路径。');
    if (!NATURES.includes(input.nature)) throw new BootstrapError('INVALID_INPUT', '外部结果只能标为 simulation 或 user_result。');
    const abs = path.resolve(this.store.workspaceRoot, relativePath);
    const root = this.store.workspaceRoot;
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new BootstrapError('POLICY_DENIED', '结果文件越出工作区。');
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new BootstrapError('POLICY_DENIED', '结果文件必须是普通文件。');
    if (fs.realpathSync(abs) !== abs) throw new BootstrapError('POLICY_DENIED', '结果文件不能是符号链接。');
    if (stat.size > DATA_LIMITS.maxFileBytes) throw new BootstrapError('INVALID_INPUT', '结果文件超过 10 MiB。');
    const bytes = fs.readFileSync(abs);
    const text = bytes.toString('utf8');
    const parsed = new GeneralMaterialStore(root).parse(path.posix.basename(relativePath), bytes);
    const asked = input.clarification?.trim() ?? '';
    if (asked) {
      if (!trusted?.text.trim() || trusted.text.trim() !== asked) throw new BootstrapError('POLICY_DENIED', '候选澄清必须是本会话用户原话，不能由模型编写。');
      if (!trusted.sessionId.trim() || !trusted.messageId.trim()) throw new BootstrapError('POLICY_DENIED', '候选澄清缺少可信消息。');
    }
    const values = (input.values ?? []).map(value => ({ ...value, unit: (value.unit as unknown) === 1 ? '1' : value.unit }));
    if (values.some(value => typeof value.unit !== 'string')) throw new BootstrapError('INVALID_INPUT', `指标「${values.find(value => typeof value.unit !== 'string')?.name ?? '?'}」的单位必须是字符串。文件没有声明单位时，mIoU 等比例可用 1，其余写「未知」。`);
    const normalized = { ...input, values, clarification: asked || null };
    const contentHash = sha256(bytes);
    let revision = input.baseRevision;
    const description = `external-path:${relativePath}`.slice(0, 4000);
    const before = this.research(input.researchId);
    const knownNames = new Set(before.metricProtocols.flatMap(protocol => protocol.metrics.map(metric => foldName(metric.name))));
    const checked = this.checkObservations(text, parsed.tables[0] ?? null, normalized, knownNames);
    const same = before.sources.find(s => s.description === description && s.sha256 === contentHash);
    let sourceId = same?.sourceId ?? '';
    if (!same) {
      const previous = [...before.sources].reverse().find(s => s.description === description);
      const imported = new GeneralDataService(this.store).importMaterial({
        operationId: childOperation(input.operationId, `src-${contentHash.slice(0, 12)}`),
        baseRevision: revision,
        researchId: input.researchId,
        filename: path.posix.basename(relativePath).slice(0, 300),
        mediaType: relativePath.endsWith('.json') ? 'application/json' : relativePath.endsWith('.csv') ? 'text/csv' : 'text/plain',
        contentBase64: bytes.toString('base64'),
        nature: input.nature,
        description,
        purpose: `外部结果 ${relativePath}；不是本系统运行，也不授予执行。`,
        previousSourceId: previous?.sourceId ?? null,
      });
      revision = imported.revision;
      sourceId = imported.result.sourceId;
    }
    return this.store.mutate({
      operationId: input.operationId,
      baseRevision: revision,
      researchId: input.researchId,
      kind: 'register_external_result',
      requestPayload: { researchId: input.researchId, relativePath, nature: input.nature, label: input.label, externalRunId: input.externalRunId ?? null, clarification: input.clarification ?? null, values: input.values, failureQuote: input.failureQuote ?? null, conditions: input.conditions, contentHash },
      apply: context => {
        const research = requireResearch(context.state, input.researchId), g = research.general;
        if (!g) throw new BootstrapError('INVALID_INPUT', '需要通用研究。');
        const source = g.sources.find(s => s.sourceId === sourceId);
        if (!source || source.sha256 !== contentHash) throw new BootstrapError('SOURCE_MISSING', '外部结果来源未写入当前研究。');
        assertGeneralSourceAccess(g, source.sourceId);
        const raw = new GeneralMaterialStore(this.store.workspaceRoot).readRaw(source).toString('utf8');
        const again = new GeneralMaterialStore(this.store.workspaceRoot).readParsed(source);
        const pinned = this.checkObservations(raw, again.tables[0] ?? null, normalized, knownNames);
        if (JSON.stringify(pinned) !== JSON.stringify(checked)) throw new BootstrapError('SOURCE_STALE', '结果文件与已保存来源不一致。');
        const key = sha256(JSON.stringify({ contentHash, run: pinned.runId, values: pinned.values, failure: pinned.failureQuote, conditions: pinned.conditions }));
        const existing = g.metricReports.find(r => r.note.startsWith(`result-key:${key}`));
        const linked = this.matchNode(g, context.state.takeovers ?? [], pinned.runId, source.sourceId, trusted?.text ?? '');
        if (existing && existing.match === 'evidenced') {
          return { changed: false, result: { reportId: existing.reportId, sourceId: existing.sourceId, nodeId: existing.nodeId ?? null, match: existing.match, matchReason: existing.matchReason ?? '', candidates: linked.candidates, comparability: existing.comparability ?? 'pending', comparabilityReason: existing.comparabilityReason ?? '', reused: true, protocolId: existing.protocolId, version: existing.version, nature: source.nature, externalRunId: existing.externalRunId ?? null } };
        }
        const protocol = this.ensureProtocol(g, context.now(), pinned.values);
        const locator = pinned.failureQuote && !pinned.values.some(v => v.value !== null)
          ? `quote:${pinned.failureQuote.slice(0, 500)}`
          : pinned.values.map(v => `table-1 r${v.row} c${v.column}=${v.token} (unit: ${v.unit})`).join('; ');
        const note = `result-key:${key}\n性质 ${input.nature}。外部记录，不是本系统已执行，也没有计算产物。${pinned.unitNote}`;
        const draft: GeneralMetricReport = {
          ...(existing ?? {}),
          reportId: existing?.reportId ?? context.mint('metric-report'),
          protocolId: protocol.protocolId,
          version: protocol.version,
          label: input.label.trim(),
          sourceId: source.sourceId,
          locator: locator.slice(0, 4000),
          values: pinned.values.map(v => ({ metricId: protocol.ids.get(v.name + '\0' + v.unit)!, value: v.value, unit: v.unit })),
          conditions: pinned.conditions,
          note: note.slice(0, 4000),
          createdAt: existing?.createdAt ?? context.now(),
          nodeId: linked.nodeId,
          externalRunId: pinned.runId,
          match: linked.match,
          matchReason: linked.reason,
          comparability: 'pending',
          comparabilityReason: '待与其他外部结果核对口径。',
        };
        const report = validateMetricReport(draft);
        if (existing) g.metricReports[g.metricReports.indexOf(existing)] = report; else g.metricReports.push(report);
        this.refreshComparability(g);
        g.revision++;
        research.general = validateGeneralResearch(g);
        research.updatedAt = context.now();
        const saved = g.metricReports.find(r => r.reportId === report.reportId)!;
        return { changed: true, result: { reportId: saved.reportId, sourceId: saved.sourceId, nodeId: saved.nodeId ?? null, match: saved.match, matchReason: saved.matchReason, candidates: linked.candidates, comparability: saved.comparability, comparabilityReason: saved.comparabilityReason, reused: Boolean(existing), protocolId: saved.protocolId, version: saved.version, nature: source.nature, externalRunId: saved.externalRunId ?? null } };
      },
    });
  }

  review(input: ExternalReviewInput, identity: string): MutationResult<Record<string, unknown>> {
    return this.store.mutate({
      operationId: input.operationId, baseRevision: input.baseRevision, researchId: input.researchId, kind: 'review_external_result',
      requestPayload: { researchId: input.researchId, reportIds: input.reportIds, judgment: input.judgment, boundary: input.boundary, support: input.support, counterEvidence: input.counterEvidence, gaps: input.gaps, nextActions: input.nextActions },
      apply: context => {
        const research = requireResearch(context.state, input.researchId), g = research.general;
        if (!g) throw new BootstrapError('INVALID_INPUT', '需要通用研究。');
        const reports = input.reportIds.map(id => g.metricReports.find(r => r.reportId === id));
        if (reports.some(r => !r)) throw new BootstrapError('NOT_FOUND', '审查引用了不属于本研究的结果。');
        for (const report of reports) {
          if (!report) continue;
          assertGeneralSourceAccess(g, report.sourceId);
          new GeneralMaterialStore(this.store.workspaceRoot).readRaw(g.sources.find(s => s.sourceId === report.sourceId)!);
        }
        const failed = reports.some(r => r!.values.every(v => v.value === null));
        const incomparable = reports.some(r => r!.comparability === 'incomparable');
        if ((failed || incomparable) && (input.judgment === 'support' || input.judgment === 'counter')) throw new BootstrapError('POLICY_DENIED', '失败或不可比的外部结果不能写成支持或反对；请标为证据不足，且不要排名。');
        const contextHash = generalContextHash(g);
        const sourcePins = reports.map(report => {
          const source = g.sources.find(item => item.sourceId === report!.sourceId)!;
          const access = [...g.sourceAccess].reverse().find(item => item.sourceId === source.sourceId);
          return { sourceId: source.sourceId, sha256: source.sha256, accessDecisionId: access?.decisionId ?? 'none' };
        });
        const protocolPins = [...new Map(reports.map(report => {
          const protocol = g.metricProtocols.find(item => item.protocolId === report!.protocolId && item.version === report!.version)!;
          return [`${protocol.protocolId}:${protocol.version}`, { protocolId: protocol.protocolId, version: protocol.version, contextHash: protocol.contextHash }] as const;
        })).values()];
        const review = validateExternalResultReview({
          reviewId: context.mint('result-review'), reportIds: input.reportIds, judgment: input.judgment, boundary: input.boundary, support: input.support, counterEvidence: input.counterEvidence, gaps: input.gaps, ranked: false, nextActions: input.nextActions,
          actor: { kind: 'model', identity }, createdAt: context.now(), contextHash, sourcePins, protocolPins,
        });
        g.resultReviews.push(review);
        g.revision++;
        research.general = validateGeneralResearch(g);
        research.updatedAt = context.now();
        return { changed: true, result: { reviewId: review.reviewId, ranked: false, judgment: review.judgment } };
      },
    });
  }

  decide(input: ExternalDecisionInput, relayedBy: string, trusted?: TrustedUserMessage | null): MutationResult<Record<string, unknown>> {
    if (!trusted?.sessionId?.trim() || !trusted.messageId?.trim() || !trusted.text?.trim()) throw new BootstrapError('POLICY_DENIED', '决定必须来自本会话的用户消息。模型提供的原话不能当作授权。');
    if (`agent:${trusted.sessionId}` !== relayedBy) throw new BootstrapError('POLICY_DENIED', '用户消息属于另一个会话，不能在这里采纳。');
    const utterance = trusted.text.trim();
    if ((input.utterance?.trim() ?? '') !== utterance) throw new BootstrapError('POLICY_DENIED', '参数里的原话和本会话用户消息不一致。');
    const choice = choiceOf(utterance);
    if (choice === null || choice !== input.choice) throw new BootstrapError('POLICY_DENIED', '用户原话必须明确且只对应接受、修改、拒绝或暂缓中的一项。否定、旧消息和文件里的“接受”都不能生成采纳。');
    const modifiedTitle = input.modifiedTitle?.trim() || null;
    if (input.choice === 'modify' && (!modifiedTitle || !utterance.includes(modifiedTitle))) throw new BootstrapError('POLICY_DENIED', '修改后的标题必须出现在用户原话里。');
    if (input.choice !== 'modify' && modifiedTitle) throw new BootstrapError('INVALID_INPUT', '只有修改才带替换标题。');
    return this.store.mutate({
      operationId: input.operationId, baseRevision: input.baseRevision, researchId: input.researchId, kind: 'decide_external_result',
      requestPayload: { researchId: input.researchId, reviewId: input.reviewId, actionIndex: input.actionIndex, choice: input.choice, utterance, modifiedTitle, messageId: trusted.messageId, sessionId: trusted.sessionId },
      apply: context => {
        const research = requireResearch(context.state, input.researchId), g = research.general;
        if (!g) throw new BootstrapError('INVALID_INPUT', '需要通用研究。');
        const review = g.resultReviews.find(r => r.reviewId === input.reviewId);
        if (!review || input.actionIndex >= review.nextActions.length) throw new BootstrapError('NOT_FOUND', '没有这条建议。');
        const action = review.nextActions[input.actionIndex];
        if (!utterance.includes(action.title) && !(modifiedTitle && utterance.includes(modifiedTitle))) throw new BootstrapError('POLICY_DENIED', '用户原话必须点名这条建议，不能把另一句接受套到当前建议上。');
        for (const other of context.state.researches) {
          for (const decision of other.general?.resultDecisions ?? []) {
            if (decision.messageId !== trusted.messageId) continue;
            if (other.researchId !== input.researchId || decision.reviewId !== review.reviewId || decision.actionIndex !== input.actionIndex) throw new BootstrapError('POLICY_DENIED', '这条用户消息已经用于别的研究或别的建议，不能复用。');
          }
        }
        const previous = g.resultDecisions.find(d => d.reviewId === input.reviewId && d.actionIndex === input.actionIndex && d.choice === input.choice && d.modifiedTitle === modifiedTitle);
        const reused = (decision: { decisionId: string; nodeId: string | null; choice: ExternalDecisionInput['choice']; provenance?: 'trusted' | 'unverified' }) => ({ changed: false as const, result: { decisionId: decision.decisionId, nodeId: decision.nodeId, choice: decision.choice, reused: true, provenance: decision.provenance ?? 'unverified' as const, supersedes: null as string | null } });
        if (previous && previous.messageId === trusted.messageId) return reused(previous);
        if (input.choice === 'accept' || input.choice === 'modify') this.assertReviewCurrent(g, review);
        if (previous && (input.choice === 'accept' || input.choice === 'modify')) return reused(previous);
        const reports = review.reportIds.map(id => g.metricReports.find(r => r.reportId === id)!);
        const prior = [...g.resultDecisions].reverse().find(d => d.reviewId === review.reviewId && d.actionIndex === input.actionIndex);
        let nodeId: string | null = null;
        if (input.choice === 'accept' || input.choice === 'modify') {
          const parents = [...new Set(reports.map(r => r.nodeId).filter((id): id is string => Boolean(id)))];
          if (!parents.length) throw new BootstrapError('POLICY_DENIED', '结果还没对应到实验，不能把建议写进研究图。');
          const title = input.choice === 'modify' ? modifiedTitle! : action.title;
          const existing = prior?.nodeId ? g.graph.nodes.find(node => node.nodeId === prior.nodeId) : undefined;
          const beforeGraph = structuredClone(g.graph), beforeLayout = structuredClone(g.layout);
          g.graphHistory.push(structuredClone(g.graph));
          if (existing) {
            existing.title = title;
            existing.goal = action.reason;
            existing.method = `外部结果建议 ${review.reviewId} 第 ${input.actionIndex + 1} 条。后续决定替代了先前计划。不是已执行任务。`;
            existing.output = '未执行。';
            existing.execution = 'not_started';
            nodeId = existing.nodeId;
          } else {
            const node = validateGeneralNode({ nodeId: context.mint('node'), title, kind: 'analysis', goal: action.reason, inputs: [], method: `外部结果建议 ${review.reviewId} 第 ${input.actionIndex + 1} 条。用户${input.choice === 'modify' ? '修改后采纳' : '采纳'}。不是已执行任务。`, output: '未执行。', completionCriterion: action.verification, join: 'all', execution: 'not_started' });
            g.graph.nodes.push(node);
            for (const parent of parents) g.graph.edges.push({ edgeId: context.mint('edge'), from: node.nodeId, to: parent, kind: 'derived_from', condition: null });
            g.layout[node.nodeId] = { x: 50 + (g.graph.nodes.length - 1) * 270, y: 520 };
            nodeId = node.nodeId;
          }
          g.graph.revision++;
          g.graph = validateGeneralGraph(g.graph);
          recordGeneralEdit(g, beforeGraph, beforeLayout, input.operationId, context.now());
        } else if (prior?.nodeId) {
          const existing = g.graph.nodes.find(node => node.nodeId === prior.nodeId);
          if (existing) {
            const beforeGraph = structuredClone(g.graph), beforeLayout = structuredClone(g.layout);
            g.graphHistory.push(structuredClone(g.graph));
            existing.output = '未执行。后续决定已替代这条计划。';
            existing.execution = 'not_started';
            g.graph.revision++;
            g.graph = validateGeneralGraph(g.graph);
            recordGeneralEdit(g, beforeGraph, beforeLayout, input.operationId, context.now());
          }
        }
        const decision = validateExternalResultDecision({
          decisionId: context.mint('result-decision'), reviewId: review.reviewId, actionIndex: input.actionIndex, choice: input.choice, reason: utterance, utterance, modifiedTitle, nodeId,
          actor: { kind: 'user', identity: 'host-message', relayedBy }, createdAt: context.now(),
          messageId: trusted.messageId, sessionId: trusted.sessionId, provenance: 'trusted', supersedes: prior?.decisionId ?? null,
        });
        g.resultDecisions.push(decision);
        g.revision++;
        research.general = validateGeneralResearch(g);
        research.updatedAt = context.now();
        return { changed: true, result: { decisionId: decision.decisionId, nodeId, choice: decision.choice, reused: false, provenance: 'trusted' as const, supersedes: prior?.decisionId ?? null } };
      },
    });
  }

  private research(researchId: string): GeneralResearch {
    const general = requireResearch(this.store.readStateOrEmpty(), researchId).general;
    if (!general) throw new BootstrapError('INVALID_INPUT', '需要通用研究。');
    return general;
  }

  private checkObservations(text: string, table: { headers?: string[]; rows: RawCell[][] } | null, input: ExternalResultInput, knownNames: Set<string>): { runId: string | null; values: Array<ExternalValueInput & { token: string }>; failureQuote: string | null; conditions: ExternalConditionInput[]; unitNote: string } {
    const declared = input.externalRunId?.trim() || null;
    const found = runIdsIn(text);
    if (declared && !text.includes(declared)) throw new BootstrapError('INVALID_INPUT', '给出的 run id 不在结果文件里。');
    if (declared && found.length && !found.includes(declared)) throw new BootstrapError('INVALID_INPUT', '给出的 run id 不是文件里的 run_id。');
    const runId = declared ?? (found.length === 1 ? found[0] : null);
    if (!declared && found.length > 1) throw new BootstrapError('INVALID_INPUT', '文件里有多个 run id，需要指明其中一个。');
    const failureQuote = input.failureQuote?.trim() || null;
    if (failureQuote && !text.includes(failureQuote)) throw new BootstrapError('INVALID_INPUT', '失败摘录不在结果文件里。');
    if (!input.values.length && !failureQuote) throw new BootstrapError('INVALID_INPUT', '没有数值时必须给出文件中的失败摘录，不能记成 0。');
    const headers = table?.headers ?? [];
    const runColumn = headers.findIndex(header => foldName(header) === 'runid' || foldName(header) === 'run');
    let unitNote = '';
    const values = input.values.map(value => {
      if (!value.name.trim() || !Number.isSafeInteger(value.row) || !Number.isSafeInteger(value.column) || value.row < 0 || value.column < 0) throw new BootstrapError('INVALID_INPUT', '指标定位不合法。');
      const name = value.name.trim();
      if (STEP_NAMES.has(foldName(name)) && !knownNames.has(foldName(name))) throw new BootstrapError('INVALID_INPUT', `「${name}」是步次或上下文，不是评价指标。研究没有把它选进指标协议时不要登记。`);
      if (value.value !== null && !Number.isFinite(value.value)) throw new BootstrapError('INVALID_INPUT', `指标「${name}」的值必须是有限数值或空。`);
      if (value.value === null) {
        if (!failureQuote) throw new BootstrapError('INVALID_INPUT', '空数值必须伴随文件中的失败摘录，不能记成 0。');
        return { ...value, name, unit: value.unit.trim(), token: '空' };
      }
      if (!table) throw new BootstrapError('INVALID_INPUT', `指标「${name}」没有可核对的表格。缺失不能记成 0。`);
      const header = headers[value.column];
      if (!header || !headerMatches(header, name)) throw new BootstrapError('INVALID_INPUT', `指标「${name}」与第 ${value.column} 列表头「${header ?? '无'}」对不上。不能把另一列的数字挂过来。`);
      const declaredUnit = unitInHeader(header);
      const unit = value.unit.trim();
      if (declaredUnit) {
        if (foldName(declaredUnit) !== foldName(unit)) throw new BootstrapError('INVALID_INPUT', `单位「${unit}」不是表头「${header}」声明的单位。其他列里的单位不能挪用。`);
      } else if (RATIO_NAMES.has(foldName(name)) && unit === '1') {
        unitNote = ' 比例类指标按无量纲 1 登记；表头没有单位，这是推断，不能换算。';
      } else if (unit === '未知') {
        unitNote = ' 表头没有单位，记为未知，不能换算，也不能当成无量纲。';
      } else throw new BootstrapError('INVALID_INPUT', `指标「${name}」的表头没有单位「${unit}」。不确定时写「未知」，不要用其他列的单位。`);
      const cell = table.rows[value.row]?.[value.column];
      const parsed = cell === undefined ? null : numericToken(cell);
      if (!parsed || parsed.value !== value.value) throw new BootstrapError('INVALID_INPUT', `指标「${name}」与表格第 ${value.row} 行第 ${value.column} 列不一致。`);
      if (runColumn >= 0) {
        const rowRun = String(table.rows[value.row]?.[runColumn] ?? '').trim();
        if (!runId || rowRun !== runId) throw new BootstrapError('INVALID_INPUT', `run id 必须是「${name}」所在行的 run_id。文件其他位置出现的运行号不能挂到这一行。`);
      }
      return { ...value, name, unit, token: parsed.token };
    });
    const rows = new Set(values.filter(value => value.value !== null).map(value => value.row));
    for (const condition of input.conditions) {
      if (!condition.name.trim()) throw new BootstrapError('INVALID_INPUT', '条件名不能为空。');
      if (condition.value === null) continue;
      if (!table || !rows.size) throw new BootstrapError('INVALID_INPUT', `条件「${condition.name}」需要和数值落在同一张表里。`);
      const column = headers.findIndex(header => headerMatches(header, condition.name));
      if (column < 0) throw new BootstrapError('INVALID_INPUT', `条件「${condition.name}」没有对应列。全文里出现该词不能代替这一行。`);
      for (const row of rows) {
        const cell = String(table.rows[row]?.[column] ?? '').trim();
        if (cell !== condition.value) throw new BootstrapError('INVALID_INPUT', `条件「${condition.name}」必须等于第 ${row} 行该列的值。其他行或其他列的值不能挪用。`);
      }
    }
    return { runId, values, failureQuote, conditions: input.conditions.map(c => ({ name: c.name.trim(), value: c.value, unit: c.unit })), unitNote };
  }

  private matchNode(g: GeneralResearch, takeovers: { scans: { entries: { readStatus: string; relativePath: string }[] }[] }[], runId: string | null, sourceId: string, clarification: string): { nodeId: string | null; match: 'evidenced' | 'pending' | 'unmatched'; reason: string; candidates: { nodeId: string; title: string }[] } {
    if (!runId) return { nodeId: null, match: 'unmatched', reason: '文件没有单一 run id，不能凭同目录绑定。', candidates: [] };
    const hits: string[] = [];
    const materials = new GeneralMaterialStore(this.store.workspaceRoot);
    for (const source of g.sources) {
      if (source.sourceId === sourceId) continue;
      let body = '';
      try { body = materials.readRaw(source).toString('utf8'); } catch { continue; }
      if (!body.includes(runId)) continue;
      const hinted = source.description.startsWith('external-path:') ? source.description.slice('external-path:'.length) : source.description.startsWith('takeover-path:') ? source.description.slice('takeover-path:'.length) : source.filename;
      hits.push(hinted.replace(/\\/g, '/'));
    }
    for (const record of takeovers) {
      const scan = record.scans[record.scans.length - 1];
      if (!scan) continue;
      for (const entry of scan.entries) {
        if (entry.readStatus !== 'read' || !isSafeRelativePath(entry.relativePath)) continue;
        const file = path.resolve(this.store.workspaceRoot, entry.relativePath);
        if (!file.startsWith(this.store.workspaceRoot + path.sep)) continue;
        let body = '';
        try { if (fs.lstatSync(file).isSymbolicLink()) continue; body = fs.readFileSync(file, 'utf8'); } catch { continue; }
        if (body.includes(runId)) hits.push(entry.relativePath.replace(/\\/g, '/'));
      }
    }
    const candidates: { nodeId: string; title: string }[] = [];
    for (const node of g.graph.nodes) {
      const method = node.method.replace(/\\/g, '/');
      if (hits.some(hit => method.includes(hit) || sharesDirectory(method, hit))) candidates.push({ nodeId: node.nodeId, title: node.title });
    }
    const unique = [...new Map(candidates.map(c => [c.nodeId, c])).values()];
    if (unique.length === 1) return { nodeId: unique[0].nodeId, match: 'evidenced', reason: `run id ${runId} 出现在已有资料中，且只对应「${unique[0].title}」。`, candidates: unique };
    if (unique.length > 1) {
      const named = clarification.trim() ? unique.filter(c => clarification.includes(c.title)) : [];
      if (named.length === 1) return { nodeId: named[0].nodeId, match: 'evidenced', reason: `用户澄清对应「${named[0].title}」。`, candidates: unique };
      return { nodeId: null, match: 'pending', reason: `run id ${runId} 对应多个实验：${unique.map(c => c.title).join('、')}。需要用户指明一个标题。`, candidates: unique };
    }
    return { nodeId: null, match: 'pending', reason: `run id ${runId} 未在已有配置、日志或研究节点中找到唯一对应。同目录本身不算对应。`, candidates: [] };
  }

  private ensureProtocol(g: GeneralResearch, now: string, values: ExternalValueInput[]): { protocolId: string; version: number; ids: Map<string, string> } {
    const latest = [...g.metricProtocols].sort((a, b) => a.version - b.version).at(-1);
    if (!latest) throw new BootstrapError('INVALID_INPUT', '研究还没有指标协议。');
    const ids = new Map<string, string>();
    const metrics = latest.metrics.map(m => structuredClone(m));
    for (const value of values) {
      const key = value.name + '\0' + value.unit;
      const found = metrics.find(m => m.name === value.name && m.unit === value.unit);
      if (found) { ids.set(key, found.metricId); continue; }
      const metricId = 'ext-' + sha256(key).slice(0, 16);
      const metric: GeneralMetric = { metricId, name: value.name, definition: `外部结果中的「${value.name}」，单位 ${value.unit}。观察记录，不是本地计算。`, role: 'auxiliary', priority: Math.min(100, metrics.length + 1), direction: 'observe', unit: value.unit, required: false, target: { min: null, max: null }, rationale: '由外部结果文件登记，未设定优劣方向或目标值。', binding: null };
      metrics.push(metric);
      ids.set(key, metricId);
    }
    const sameShape = metrics.length === latest.metrics.length && latest.status === 'frozen' && latest.contextHash === generalContextHash(g);
    if (sameShape) return { protocolId: latest.protocolId, version: latest.version, ids };
    const protocol = validateMetricProtocol({ ...latest, version: latest.version + 1, status: 'frozen', metrics, contextHash: generalContextHash(g), reason: '登记外部结果的观察指标。未设定目标，不代表假设成立，也不启动实验。', createdAt: now });
    validateMetricIdentityHistory([...g.metricProtocols, protocol]);
    g.metricProtocols.push(protocol);
    return { protocolId: protocol.protocolId, version: protocol.version, ids };
  }

  private refreshComparability(g: GeneralResearch): void {
    const named = (report: GeneralMetricReport, metricId: string) => metricName(g.metricProtocols, report, metricId);
    const external = g.metricReports.filter(report => report.note.startsWith('result-key:'));
    for (const report of external) {
      const numeric = report.values.filter(v => v.value !== null);
      if (!numeric.length) {
        report.comparability = 'incomparable';
        report.comparabilityReason = '无数值或失败记录，不记为 0，不参与排名。';
        continue;
      }
      if (!report.conditions.length || report.conditions.some(c => !c.value?.trim())) {
        report.comparability = 'pending';
        report.comparabilityReason = '比较条件缺失或未知，待核实。这不表示口径已经通过。';
        continue;
      }
      const peers = external.filter(other => other.reportId !== report.reportId && other.values.some(v => v.value !== null) && other.conditions.length > 0 && other.conditions.every(c => Boolean(c.value?.trim())));
      const sharesMetric = (other: GeneralMetricReport) => numeric.some(value => other.values.some(peer => peer.value !== null && named(other, peer.metricId) === named(report, value.metricId)));
      const aligned = peers.filter(other => sharesMetric(other) && conditionKey(other) === conditionKey(report) && numeric.every(value => other.values.some(peer => peer.value !== null && named(other, peer.metricId) === named(report, value.metricId) && peer.unit === value.unit)));
      const conflicts = peers.filter(other => sharesMetric(other) && !aligned.includes(other));
      if (aligned.length) {
        report.comparability = 'comparable';
        report.comparabilityReason = conflicts.length
          ? '同口径组可并列。另有不同条件组，不跨组比较，不生成差值。导入顺序不影响该判断。'
          : '同口径组可并列。不生成差值，不代表假设成立。';
        continue;
      }
      if (conflicts.length) {
        report.comparability = 'incomparable';
        report.comparabilityReason = '与另一条件组或单位不同，不可直接比较，不排名，不生成差值。导入顺序不影响该判断。';
        continue;
      }
      report.comparability = 'pending';
      report.comparabilityReason = '条件已登记，还没有同口径对照，不能视为比较通过。不生成差值。';
    }
  }

  private assertReviewCurrent(g: GeneralResearch, review: ExternalResultReview): void {
    if (!review.contextHash || !review.sourcePins || !review.protocolPins) throw new BootstrapError('POLICY_DENIED', '这条审查没有记下协议和来源版本，需要重新审查后才能采纳。');
    if (review.contextHash !== generalContextHash(g)) throw new BootstrapError('SOURCE_STALE', '研究条件已变化，旧建议不能直接采纳。');
    for (const pin of review.protocolPins) {
      const protocol = g.metricProtocols.find(item => item.protocolId === pin.protocolId && item.version === pin.version);
      if (!protocol || protocol.contextHash !== pin.contextHash) throw new BootstrapError('SOURCE_STALE', '指标协议已变化，旧建议需要重新审查。');
    }
    const materials = new GeneralMaterialStore(this.store.workspaceRoot);
    for (const pin of review.sourcePins) {
      const source = g.sources.find(item => item.sourceId === pin.sourceId);
      const access = [...g.sourceAccess].reverse().find(item => item.sourceId === pin.sourceId);
      if (!source || source.sha256 !== pin.sha256 || (access?.decisionId ?? 'none') !== pin.accessDecisionId) throw new BootstrapError('SOURCE_STALE', '原材料或来源授权已变化，旧建议需要重新审查。');
      assertGeneralSourceAccess(g, pin.sourceId);
      materials.readRaw(source);
    }
  }
}

function choiceOf(text: string): ExternalDecisionInput['choice'] | null {
  const stripped = text.replace(NEGATED_ACCEPT, ' ');
  const hits = (Object.keys(CHOICE_WORDS) as ExternalDecisionInput['choice'][]).filter(choice => CHOICE_WORDS[choice].some(pattern => pattern.test(stripped)));
  return hits.length === 1 ? hits[0] : null;
}

function sharesDirectory(method: string, hitPath: string): boolean {
  const slash = hitPath.lastIndexOf('/');
  if (slash < 1) return false;
  return method.includes(hitPath.slice(0, slash + 1));
}

