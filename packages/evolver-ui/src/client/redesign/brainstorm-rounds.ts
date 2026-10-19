/**
 * BR-FE2 — round-scoped presentation logic for the brainstorm view (Plan §5).
 *
 * The rendered defects this fixes:
 * - the cards came from `selectedRun` while the status chip, model, counts and itemErrors
 *   still read `latest`, so viewing an older round showed the newest failure pasted on top;
 * - history listed raw runIds (long UUIDs) with no status/count;
 * - failed rounds crowded the main surface instead of a collapsed section.
 *
 * Every function here is pure and Node-testable; the .tsx consumes the results. Run `runs`
 * arrays are newest-first (the backend returns them that way); the round number counts from
 * the OLDEST (第 1 轮 … 第 N 轮) so labels stay stable as new runs arrive.
 */
import type { BrainstormRunView } from './view-model.ts';

/** One history entry: compact, human-readable, no raw UUID in the label. */
export interface RoundOption {
  runId: string;
  /** 第 N 轮 — stable as new runs arrive. */
  roundNo: number;
  /** 第 3 轮 · 已生成 6 条 · 14:02 — never a bare UUID. */
  label: string;
  status: BrainstormRunView['status'];
  candidateCount: number;
  /** Zero-candidate failed/interrupted runs belong in the collapsed section. */
  collapsible: boolean;
  startedAt: string | null;
}

export type ViewedRoundKind = 'selected' | 'fallback' | 'none';

export interface ViewedRound {
  kind: ViewedRoundKind;
  /** The run every status element must read — chip, model, counts, itemErrors. */
  run: BrainstormRunView | null;
  /** 第 N 轮 label, or null when nothing is viewable. */
  label: string | null;
  /** Shown only when kind === 'fallback'. */
  notice: string | null;
}

/**
 * Short, actionable failure text for one run — code once, no repeated prefixes.
 * Full detail (paths, runId/operationId, raw text) stays in the expandable section.
 */
export function shortFailureText(run: BrainstormRunView): string | null {
  if (run.status !== 'failed' && run.status !== 'cancelled' && run.status !== 'interrupted') return null;
  if (run.itemErrors.length === 0) {
    return run.status === 'failed' ? '本轮生成失败，可展开查看原因后重试。'
      : run.status === 'cancelled' ? '本轮已取消。' : '本轮被中断，可重新生成。';
  }
  const first = run.itemErrors[0];
  // Strip a repeated CODE: prefix the backend may already include in the message.
  const message = first.message.replace(new RegExp(`^${first.code}[:：]\\s*`), '');
  const rest = run.itemErrors.length > 1 ? `（等 ${run.itemErrors.length} 项）` : '';
  return `${message}${rest}`;
}

function roundLabel(roundNo: number, total: number, run: BrainstormRunView): string {
  const statusText: Record<BrainstormRunView['status'], string> = {
    pending: '进行中', running: '进行中', completed: run.ideaIds.length === 0 ? '无候选' : `已生成 ${run.ideaIds.length} 条`,
    partial: `部分成功 ${run.ideaIds.length} 条`, failed: '失败', cancelled: '已取消', interrupted: '已中断',
  };
  // Date without year when it is this year; fall back to the round number alone.
  let when = `第 ${roundNo} 轮`;
  if (run.startedAt) {
    const date = new Date(run.startedAt);
    if (!Number.isNaN(date.getTime())) {
      const now = new Date();
      const sameYear = date.getFullYear() === now.getFullYear();
      const month = date.getMonth() + 1, day = date.getDate();
      const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      when += sameYear ? ` · ${month}/${day} ${time}` : ` · ${date.getFullYear()}/${month}/${day}`;
    }
  }
  void total;
  return `${when} · ${statusText[run.status]}`;
}

export function roundOptions(runs: BrainstormRunView[]): RoundOption[] {
  const total = runs.length;
  return runs.map((run, newestFirst) => {
    const roundNo = total - newestFirst;
    return {
      runId: run.runId, roundNo, label: roundLabel(roundNo, total, run), status: run.status,
      candidateCount: run.ideaIds.length,
      collapsible: run.ideaIds.length === 0 && (run.status === 'failed' || run.status === 'interrupted' || run.status === 'cancelled'),
      startedAt: run.startedAt,
    };
  });
}

export function failedRoundOptions(runs: BrainstormRunView[]): RoundOption[] {
  return roundOptions(runs).filter((option) => option.collapsible);
}

export function visibleRoundOptions(runs: BrainstormRunView[]): RoundOption[] {
  return roundOptions(runs).filter((option) => !option.collapsible);
}

/**
 * Resolve which run the WHOLE card section reads — status, model, counts, itemErrors
 * and the candidate list all come from this ONE run, never mixed.
 */
export function viewedRound(runs: BrainstormRunView[], selectedRunId: string | null): ViewedRound {
  if (runs.length === 0) return { kind: 'none', run: null, label: null, notice: null };
  const total = runs.length;
  const labelOf = (run: BrainstormRunView) => {
    const roundNo = total - runs.indexOf(run);
    return `第 ${roundNo} 轮`;
  };
  if (selectedRunId === null || selectedRunId === 'latest') {
    const latest = runs[0];
    // A failed/empty latest must not paste its status onto older candidates: if it has no
    // candidates and an older round does, show the newest round WITH candidates and say so.
    if (latest.ideaIds.length === 0 && (latest.status === 'failed' || latest.status === 'interrupted' || latest.status === 'cancelled' || latest.emptyResultReason !== null)) {
      const fallback = runs.find((run) => run.ideaIds.length > 0);
      if (fallback !== undefined) {
        return { kind: 'fallback', run: fallback, label: labelOf(fallback),
          notice: `显示${labelOf(fallback)}；最近一轮${latest.status === 'completed' ? '无候选' : '生成失败'}。` };
      }
    }
    return { kind: 'selected', run: latest, label: labelOf(latest), notice: null };
  }
  const selected = runs.find((run) => run.runId === selectedRunId);
  if (selected === undefined) return { kind: 'none', run: null, label: null, notice: '所选轮次已不存在，请重新选择。' };
  return { kind: 'selected', run: selected, label: labelOf(selected), notice: null };
}

/**
 * Plain-language explanation of one idea (Plan §8): what problem, why this change might
 * help, what changes relative to the baseline, and how to tell whether it worked.
 *
 * Built ONLY from the idea's own fields. Anything unknown is said plainly — the model
 * must never invent effect numbers or source facts to fill the shape. Returns 3–5 short
 * paragraphs; an empty idea still yields honest "还不清楚" lines, never silence.
 */
export function explainIdea(idea: {
  title: string; hypothesis: string | null; rationale: string | null;
  atomicChange: string | null; validationPlan: string | null;
  basis: 'grounded' | 'exploratory'; evidenceRefs: unknown[];
}): string[] {
  const out: string[] = [];
  if (idea.hypothesis) out.push(`这个方向想验证：${idea.hypothesis}`);
  if (idea.rationale) out.push(`理由是${idea.rationale}`);
  else out.push('理由还不清楚——保存时没有给出依据，需要再补充。');
  if (idea.atomicChange) out.push(`具体改动：${idea.atomicChange}`);
  else out.push('具体改哪里还没有写清楚。');
  if (idea.validationPlan) out.push(`验证方法：${idea.validationPlan}`);
  else out.push('怎么验证还没有确定。');
  if (idea.basis === 'exploratory' || idea.evidenceRefs.length === 0) {
    out.push('目前还没有可核对的论文证据，属于待验证假设，不是已证实的结论。');
  }
  return out.slice(0, 5);
}

/**
 * Plain-language line for a run's result: what was saved, what failed, what to do next.
 * Only after a real re-read may the page say 已保存 — this text never claims it.
 */
export function explainRunResult(run: BrainstormRunView): string {
  const saved = run.ideaIds.length;
  if (run.status === 'completed' && saved === 0) {
    return run.emptyResultReason ?? '本轮读完后认为没有可行的候选方向。';
  }
  if (run.status === 'completed') return `本轮保存了 ${saved} 条候选，可继续勾选或生成下一轮。`;
  if (run.status === 'partial') {
    return `本轮保存了 ${saved} 条候选，另有 ${run.itemErrors.length} 项因格式或引用问题没能保存，可展开查看后修正。`;
  }
  if (run.status === 'failed') return '本轮没有保存任何候选，可展开查看失败原因后重试或换个方向。';
  if (run.status === 'cancelled') return '本轮已取消，已保存的内容不受影响。';
  if (run.status === 'interrupted') return '本轮被中断，已保存的内容保留，可重新生成继续。';
  return '本轮还在进行中，结果以完成后重新读取到的数据为准。';
}

/**
 * Deduplicate visible messages by action + error identity: the same code on the same item
 * appears once; different items or different actions are never merged away.
 */
export function dedupeErrors(errors: Array<{ ideaId: string | null; code: string; message: string }>): Array<{ ideaId: string | null; code: string; message: string }> {
  const seen = new Set<string>();
  const out: Array<{ ideaId: string | null; code: string; message: string }> = [];
  for (const error of errors) {
    const key = `${error.ideaId ?? ''}|${error.code}|${error.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(error);
  }
  return out;
}

/**
 * Pick the receipt to show: the newest by actual time and identity, never by a fixed
 * action-type priority. A stale save conflict must not outrank a fresh generation failure.
 */
export interface ReceiptEntry { key: string; text: string; at: number | null }
export function newestReceipt(entries: ReceiptEntry[]): string | null {
  const timed = entries.filter((entry) => entry.text !== null && entry.text !== '');
  if (timed.length === 0) return null;
  // Entries without a timestamp sort last — an undated old message never wins.
  const ranked = [...timed].sort((a, b) => (b.at ?? Number.NEGATIVE_INFINITY) - (a.at ?? Number.NEGATIVE_INFINITY));
  return ranked[0].text;
}
