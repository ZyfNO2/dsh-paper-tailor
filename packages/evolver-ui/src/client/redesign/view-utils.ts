/**
 * Presentation helpers shared by the three pages: fixed Chinese labels and
 * tone mappings for kinds/statuses. Meaning always carries a WORD + icon,
 * never color alone (SPEC §2/FE-A09).
 */
import type {
  BaselineView,
  BrainstormRunStatus,
  BrainstormRunView,
  CandidateAssessment,
  ComponentKind,
  ComponentView,
  EnvironmentProbeStatus,
  EnvironmentObservationView,
  EvidenceState,
  ExperimentStatus,
  IdeaBasis,
  IdeaStatus,
  NodeKind,
  NodeStatus,
  PaperFlag,
  PaperView,
  PlanningStatus,
  ResearchContractView,
  ResearchIdeaView,
  SlotCandidateView,
  SlotScope,
  SlotStatus,
  SlotView,
  VerificationStatus,
} from './view-model.ts';

import type { IconName } from './icons.tsx';

export const NODE_META: Record<NodeKind, { label: string; color: string; icon: IconName }> = {
  baseline: { label: '基线', color: '#9aa3b2', icon: 'layers' },
  question: { label: '问题', color: '#9aa3b2', icon: 'help' },
  hypothesis: { label: '假设', color: '#b48cff', icon: 'bulb' },
  scheme: { label: '方案', color: '#5b93ff', icon: 'doc' },
  experiment: { label: '实验', color: '#43d39a', icon: 'flask' },
  result: { label: '结果', color: '#f0b94e', icon: 'chart' },
  conclusion: { label: '结论', color: '#f473a2', icon: 'flag' },
  // Planning-only kinds (research-bootstrap round, shared spec §5).
  goal: { label: '研究目标', color: '#f473a2', icon: 'target' },
  protocol: { label: '研究协议', color: '#5b93ff', icon: 'branch' },
};

export const NODE_STATUS_META: Record<NodeStatus, { label: string; tone: string }> = {
  cancelled: { label: '已取消', tone: '#9aa3b2' },
  done: { label: '已完成', tone: '#43d39a' },
  in_progress: { label: '进行中', tone: '#5b93ff' },
  planned: { label: '待进行', tone: '#9aa1ab' },
  failed: { label: '失败', tone: '#f06c6c' },
  pruned: { label: '已剪枝', tone: '#f06c6c' },
  retained: { label: '已保留', tone: '#43d39a' },
  expanded: { label: '已扩展', tone: '#5b93ff' },
  blocked: { label: '阻塞', tone: '#f0b94e' },
  unknown: { label: '未知', tone: '#6f7681' },
};

/**
 * Planning status of a node, kept visually and semantically DISTINCT from the
 * run status above.
 *
 * `confirmed` here means "the user confirmed this PLAN" — it is never rendered
 * as 已完成 / done, and it never overrides `NODE_STATUS_META`: a confirmed plan
 * that has not run is a real, common state (shared spec §8, FE-R05).
 */
export const PLANNING_STATUS_META: Record<PlanningStatus, { label: string; cls: string }> = {
  draft: { label: '规划草稿', cls: 'rd-chip-gray' },
  needs_confirmation: { label: '待确认', cls: 'rd-chip-yellow' },
  confirmed: { label: '规划已确认', cls: 'rd-chip-blue' },
  needs_validation: { label: '待验证', cls: 'rd-chip-purple' },
  not_planned: { label: '未规划', cls: 'rd-chip-gray' },
};

/** Roles a plan node can play in the small bootstrap DAG. */
export const SLOT_STATUS_META: Record<SlotStatus, { label: string; cls: string }> = {
  draft: { label: '草稿插槽', cls: 'rd-chip-gray' },
  needs_confirmation: { label: '插槽待确认', cls: 'rd-chip-yellow' },
  confirmed: { label: '插槽已确认', cls: 'rd-chip-blue' },
};

export const SLOT_SCOPE_LABEL: Record<SlotScope, string> = {
  universal: '通用位置',
  domain: '领域位置',
};

export const CANDIDATE_ASSESSMENT_META: Record<CandidateAssessment, { label: string; cls: string }> = {
  proposed: { label: '建议候选', cls: 'rd-chip-green' },
  needs_review: { label: '待评估', cls: 'rd-chip-yellow' },
  incompatible: { label: '不兼容', cls: 'rd-chip-red' },
};

export const IDEA_STATUS_META: Record<IdeaStatus, { label: string; cls: string }> = {
  candidate: { label: '候选', cls: 'rd-chip-gray' },
  selected: { label: '已选择', cls: 'rd-chip-blue' },
  rejected: { label: '已排除', cls: 'rd-chip-red' },
  archived: { label: '已归档', cls: 'rd-chip-gray' },
};

export const ENVIRONMENT_STATUS_META: Record<EnvironmentProbeStatus, { label: string; cls: string }> = {
  observed: { label: '已探测', cls: 'rd-chip-green' },
  unavailable: { label: '不可用', cls: 'rd-chip-yellow' },
  failed: { label: '探测失败', cls: 'rd-chip-red' },
  not_run: { label: '未探测', cls: 'rd-chip-gray' },
};

/** grounded means the source is checkable — NOT that the hypothesis is proven. */
export const IDEA_BASIS_META: Record<IdeaBasis, { label: string; cls: string; note: string }> = {
  grounded: { label: '有据', cls: 'rd-chip-green', note: '来源可核对；不代表假设已验证。' },
  exploratory: { label: '探索性', cls: 'rd-chip-yellow', note: '探索性候选，待补依据；不代表已验证。' },
};

export const EVIDENCE_STATE_META: Record<EvidenceState, { label: string; cls: string }> = {
  current: { label: '来源有效', cls: 'rd-chip-green' },
  stale: { label: '来源已过期', cls: 'rd-chip-yellow' },
  missing: { label: '来源缺失', cls: 'rd-chip-red' },
};

export const BRAINSTORM_RUN_META: Record<BrainstormRunStatus, { label: string; cls: string }> = {
  pending: { label: '已排队', cls: 'rd-chip-gray' },
  running: { label: '生成中', cls: 'rd-chip-blue' },
  completed: { label: '已生成', cls: 'rd-chip-green' },
  partial: { label: '部分完成', cls: 'rd-chip-yellow' },
  failed: { label: '生成失败', cls: 'rd-chip-red' },
  cancelled: { label: '已取消', cls: 'rd-chip-gray' },
  interrupted: { label: '已中断', cls: 'rd-chip-gray' },
};

export const COMPONENT_KIND_LABEL: Record<ComponentKind, string> = {
  Baseline: '基线',
  Method: '方法',
  Module: '模块',
  Experiment: '实验工具',
};

export const COMPONENT_KIND_ICON: Record<ComponentKind, IconName> = {
  Baseline: 'layers',
  Method: 'branch',
  Module: 'cube',
  Experiment: 'gear',
};

export const PAPER_FLAG_META: Record<PaperFlag, { label: string; cls: string }> = {
  highly_relevant: { label: '高相关', cls: 'rd-chip-blue' },
  relevant: { label: '相关', cls: 'rd-chip-gray' },
  extracted: { label: '已抽取', cls: 'rd-chip-green' },
  cited: { label: '已引用', cls: 'rd-chip-purple' },
  missing_evidence: { label: '缺证据', cls: 'rd-chip-yellow' },
};

export const EXPERIMENT_STATUS_META: Record<ExperimentStatus, { label: string; cls: string }> = {
  cancelled: { label: '已取消', cls: 'rd-chip-gray' },
  planned: { label: '计划中', cls: 'rd-chip-gray' },
  running: { label: '运行中', cls: 'rd-chip-blue' },
  completed: { label: '已完成', cls: 'rd-chip-green' },
  failed: { label: '失败', cls: 'rd-chip-red' },
  blocked: { label: '阻塞', cls: 'rd-chip-yellow' },
  unknown: { label: '未知', cls: 'rd-chip-gray' },
};

export const VERIFICATION_META: Record<VerificationStatus, { label: string; cls: string }> = {
  verified: { label: '已核验', cls: 'rd-chip-green' },
  unverified: { label: '未核验', cls: 'rd-chip-gray' },
  inconclusive: { label: '结论不定', cls: 'rd-chip-yellow' },
  unknown: { label: '未知', cls: 'rd-chip-gray' },
};

export const CONTRIBUTION_META: Record<
  string,
  { label: string; color: string; icon: IconName }
> = {
  mechanism: { label: '机制 / 观点', color: '#b48cff', icon: 'mechanism' },
  evidence: { label: '实验结果 / 证据', color: '#43d39a', icon: 'flask' },
  method: { label: '方法 / 方案', color: '#f0b94e', icon: 'target' },
  data: { label: '数据 / 资源', color: '#5b93ff', icon: 'database' },
  slot_mapping: { label: '实体 / slot 映射', color: '#9aa3b2', icon: 'link' },
};

// ---------------------------------------------------------------------------
// Wiki / component asset facts
// (COMMAND-REPAIR-SPEC-2026-10-09 §4, COMMAND-REPAIR-PLAN §R3)
// ---------------------------------------------------------------------------

/**
 * The two independent fields one paper's own JSON carries: `sections` (the
 * saved Wiki) and `components` (the extracted research components). They share
 * ONE revision hash, so a non-null revision says nothing about which of the two
 * exists — that is exactly the inference that made a Wiki-only paper show
 * "已抽取".
 *
 * `PaperView` mirrors the fields 1:1 (`wikiLinks[i]` comes from `sections[i]`,
 * `contributions[i]` from `components[i]`), so the page derives its status from
 * the data it was handed instead of guessing from a revision.
 *
 * The wording lives in this plain module — not inside the .tsx components — so
 * the paper page and the tailor shop share ONE sentence per state, and the
 * exact strings are assertable in Node without a DOM.
 */
export interface PaperAssetFacts {
  /** Saved Wiki sections (paper JSON `sections.length`). */
  sectionCount: number;
  /** Extracted research components (paper JSON `components.length`). */
  componentCount: number;
}

export function paperAssetFacts(paper: Pick<PaperView, 'wikiLinks' | 'contributions'>): PaperAssetFacts {
  return { sectionCount: paper.wikiLinks.length, componentCount: paper.contributions.length };
}

/**
 * The paper page's status line, matching the WIKI-EXTRACT-FUNCTION-SPEC §7 table
 * exactly. The `sections === 0 && components > 0` row is the components-only
 * state that this round legalised: a paper can hold components while it has no
 * Wiki at all, and it must still render normally.
 *
 * | sections | components | rendered |
 * | --- | --- | --- |
 * | 0 | 0 | 尚无 Wiki · 组件 0 项；可直接 /extract，也可先 /wiki 阅读知识 |
 * | >0 | 0 | Wiki 已保存（N 节）· 组件 0 项 |
 * | 0 | >0 | 尚无 Wiki；可独立 /wiki · 组件已抽取（M 项） |
 * | >0 | >0 | Wiki 已保存（N 节）· 组件已抽取（M 项） |
 *
 * Only real data is claimed: "Wiki 已保存" needs at least one section, and
 * "组件已抽取" needs at least one component. Nothing here states whether
 * `/extract` was ever run — 0 components is also the honest outcome of a run
 * that found nothing extractable, and with no execution record the two cannot
 * be told apart, so neither is displayed.
 */
export function paperAssetStatusText(facts: PaperAssetFacts): string {
  const components = facts.componentCount > 0 ? `组件已抽取（${facts.componentCount} 项）` : '组件 0 项';
  if (facts.sectionCount > 0) return `Wiki 已保存（${facts.sectionCount} 节）· ${components}`;
  return facts.componentCount > 0 ? `尚无 Wiki；可独立 /wiki · ${components}` : `尚无 Wiki · ${components}`;
}

/**
 * The contribution column when no component is stored.
 *
 * `/extract` no longer needs a Wiki (WIKI-EXTRACT-FUNCTION-SPEC §2/§4), so the
 * hint offers it directly for every paper that has none, including a paper with
 * no Wiki — telling the reader to run `/wiki` first would now be wrong advice.
 * It never implies the reader skipped a step, and it never claims a run
 * happened or did not happen: with no execution record, "组件 0 项" is equally
 * consistent with "never run" and "run and found nothing".
 */
export function paperComponentEmptyHint(facts: PaperAssetFacts): string {
  const status = paperAssetStatusText(facts);
  return `${status}。可直接运行 /extract 抽取研究组件${facts.sectionCount > 0 ? '' : '，也可先运行 /wiki 阅读论文知识'}。`;
}

/** Library-wide asset totals, aggregated from the real paper rows. */
export interface LibraryAssetFacts {
  paperCount: number;
  /** Papers that have a saved Wiki (at least one section). */
  wikiPaperCount: number;
  componentCount: number;
}

/**
 * The tailor shop's empty message. Three genuinely different situations must
 * NOT collapse into one sentence.
 *
 * Since /extract no longer requires a Wiki, "papers exist but none has a Wiki"
 * is no longer a dead end that must be fixed first: components can be extracted
 * directly, and reading the Wiki is only an optional convenience. So only the
 * no-paper case asks the reader to add a paper; the others offer /extract.
 */
export function tailorEmptyReason(facts: LibraryAssetFacts): string {
  if (facts.paperCount === 0) {
    return '暂无组件。工作区知识库还没有论文：先在“对话”中上传 PDF / TXT / Markdown 并运行 /wiki 保存 Wiki。';
  }
  if (facts.wikiPaperCount === 0) {
    return '暂无组件。已有论文但还没有保存的 Wiki：可在对话直接运行 /extract 抽取研究组件，也可先运行 /wiki 阅读论文知识。';
  }
  return 'Wiki 已保存；暂无研究组件。可在对话运行 /extract。';
}

/**
 * The latest command run's result, shown next to — but never merged with — the
 * asset availability above. A failed run does not erase stored assets, and a
 * stored asset does not make a failed run a success, so the two are separate
 * sentences (WIKI-EXTRACT-FUNCTION-SPEC §7).
 *
 * `runs` comes from the read-only library route (`schemaVersion: 2`), i.e. the
 * workspace's durable sidecar records, not from React state — so a refresh still
 * shows the same result.
 */
export interface LibraryRunSummary {
  /** Latest run per command, newest first within each. */
  latest: Array<{ command: 'wiki' | 'extract'; status: string; startedAt: string; finishedAt: string | null;
    succeeded: number; failed: number; partial: number; noFindings: number;
    errors: Array<{ code: string; message: string }>; noFindingsReasons: string[] }>;
}

/** One durable command-run record as the read-only route returns it (schemaVersion 2). */
export interface PaperRunRow {
  runId: string; command: 'wiki' | 'extract'; agentSessionId: string;
  status: string; startedAt: string; finishedAt: string | null;
  targets: Array<{ targetId: string; paperId: string | null; outcome: string; scope: string;
    readPages?: number[]; requestedPages?: number[]; noFindingsReason?: string;
    error?: { code: string; message: string } }>;
}

/**
 * Summarise the workspace's run records into per-command counts.
 *
 * Counts are derived from the durable sidecar records the route returns, never
 * from React state, so the same result is visible after a refresh. They are
 * reported separately from asset availability: a failure never erases stored
 * assets, and stored assets never make a failed run a success.
 */
export function summariseRuns(runs: PaperRunRow[]): LibraryRunSummary {
  const byCommand = new Map<'wiki' | 'extract', PaperRunRow>();
  for (const run of runs) if (!byCommand.has(run.command)) byCommand.set(run.command, run);
  const latest = [...byCommand.values()].map((run) => ({
    command: run.command, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
    succeeded: run.targets.filter((t) => t.outcome === 'saved' || t.outcome === 'reused').length,
    failed: run.targets.filter((t) => t.outcome === 'failed').length,
    partial: run.targets.filter((t) => t.outcome === 'partial').length,
    noFindings: run.targets.filter((t) => t.outcome === 'no_findings').length,
    errors: run.targets.filter((t) => t.error).map((t) => t.error as { code: string; message: string }),
    noFindingsReasons: run.targets.filter((t) => t.noFindingsReason).map((t) => t.noFindingsReason as string),
  }));
  return { latest };
}

/** The `no_findings` reason recorded for one paper, if any. */
export function noFindingsFor(runs: PaperRunRow[], paperId: string): string | undefined {
  for (const run of runs) for (const t of run.targets) {
    if (t.paperId === paperId && t.outcome === 'no_findings' && t.noFindingsReason) return t.noFindingsReason;
  }
  return undefined;
}

const RUN_STATUS_TEXT: Record<string, string> = {
  completed: '最近运行已完成', partial: '最近运行部分完成', failed: '最近运行失败',
  cancelled: '最近运行已取消', interrupted: '最近运行被中断',
  running: '最近运行进行中', pending: '最近运行待开始',
};

export function libraryRunStatusText(summary: LibraryRunSummary): string | null {
  const done = summary.latest.filter((r) => r.status !== 'running' && r.status !== 'pending');
  if (done.length === 0) return null;
  return done.map((r) => {
    const label = RUN_STATUS_TEXT[r.status] ?? `最近运行 ${r.status}`;
    const counts = `成功 ${r.succeeded} · 部分 ${r.partial} · 失败 ${r.failed}`;
    const failed = r.failed > 0 && r.errors.length > 0 ? `；失败原因：${r.errors.slice(0, 3).map((e) => e.code).join('、')}` : '';
    return `/${r.command}：${label}（${counts}${failed}）`;
  }).join('；');
}

/**
 * What to say when a paper has no components.
 *
 * With a reliable `no_findings` record the honest statement is that a run
 * completed and found nothing; with no record at all, the page must NOT invent a
 * run — it says only that nothing is stored yet.
 */
export function noFindingsText(hasRecord: boolean, reason?: string): string {
  if (!hasRecord) return '暂无组件';
  return reason ? `本范围抽取完成，无可抽取项：${reason}` : '本范围抽取完成，无可抽取项';
}

// ---------------------------------------------------------------------------
// Tailor shop provenance: aggregate by PAPER, never by origin string
// (FE-01 §3, RESEARCH-BOOTSTRAP-FE-01-LAYOUT-SPEC-2026-10-10)
//
// `source.origin` concatenates the title AND the page, so every page of one
// paper used to become its own "source": with 10 papers cited across many pages
// the summary line grew into a wall of text that pushed the component list off
// screen. The fix is at the DATA level, not a CSS line-clamp — the counts are
// aggregated over the stable `paperLink` key and the full provenance stays
// reachable in a collapsible panel.
// ---------------------------------------------------------------------------

/** One paper's own contribution to the component list. */
export interface ProvenanceGroup {
  /** Stable paper key from `paperLinks`; null only for the unknown bucket. */
  paperKey: string | null;
  label: string;
  /** Pages cited for this paper, ascending, deduplicated. */
  pages: number[];
  componentCount: number;
}

export interface TailorProvenance {
  componentCount: number;
  /** Distinct papers. `null` = 未知: at least one component carries no paper key. */
  paperCount: number | null;
  /** Components whose paper identity is missing — why paperCount can be null. */
  unknownPaperComponents: number;
  groups: ProvenanceGroup[];
}

const PAGE_TAG = /^第\s*(\d+)\s*页$/;
const PAGE_IN_TEXT = /第\s*(\d+)\s*页/;

/**
 * The page a component was extracted from, or null when the data does not say.
 * Nothing is inferred: with no page tag and no page in `source.origin` the
 * answer is unknown, and the panel prints 未知 instead of a guessed 1.
 */
export function componentPage(c: ComponentView): number | null {
  for (const tag of c.tags) {
    const m = PAGE_TAG.exec(tag);
    if (m !== null) return Number(m[1]);
  }
  const m = PAGE_IN_TEXT.exec(c.source.origin);
  return m === null ? null : Number(m[1]);
}

/**
 * The stable paper identity of a component. Display names are never identity
 * (view-model identity rule), so two papers sharing one title never merge and
 * one paper is never split by page.
 */
export function componentPaperKey(c: ComponentView): string | null {
  const link = c.paperLinks.find((l) => l.kind === 'paper' && l.key !== '');
  return link === undefined ? null : link.key;
}

/**
 * Group the component list by paper.
 *
 * Papers are counted by `paperLink` key, so the count does not grow with the
 * number of cited pages and does not merge two different papers that happen to
 * carry the same title (FE-L02). A component with no paper key lands in the
 * unknown bucket, which makes `paperCount` null — the page then says 未知
 * rather than printing a number that silently drops components.
 */
export function tailorProvenance(components: ComponentView[]): TailorProvenance {
  const byKey = new Map<string, ProvenanceGroup>();
  let unknownPaperComponents = 0;
  for (const c of components) {
    const key = componentPaperKey(c);
    if (key === null) { unknownPaperComponents += 1; continue; }
    let group = byKey.get(key);
    if (group === undefined) {
      group = {
        paperKey: key,
        label: c.paperLinks.find((l) => l.kind === 'paper' && l.key === key)?.label ?? key,
        pages: [],
        componentCount: 0,
      };
      byKey.set(key, group);
    }
    group.componentCount += 1;
    const page = componentPage(c);
    if (page !== null && !group.pages.includes(page)) group.pages.push(page);
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.pages.sort((a, b) => a - b);
  return {
    componentCount: components.length,
    paperCount: unknownPaperComponents > 0 ? null : groups.length,
    unknownPaperComponents,
    groups,
  };
}

/** "第 1、3、5 页" — compact page set for one paper; null when no page is known. */
export function pagesText(pages: number[]): string | null {
  if (pages.length === 0) return null;
  const shown = pages.slice(0, 12).join('、');
  const more = pages.length > 12 ? ` 等 ${pages.length} 页` : '';
  return `第 ${shown} 页${more}`;
}

/**
 * The tailor shop's summary line for the non-empty case: the REAL component
 * count plus the REAL (deduplicated) paper count.
 *
 * The wording is driven by the data, not by the page: components the workspace
 * library produced carry the '论文抽取草稿' tag, and only for those is
 * "已抽取" and the boundary sentence accurate — a paper-extracted component is
 * not wired into this task, not validated here, and has no trial, because the
 * paper's own Experiment components are the AUTHORS' experiments, not local
 * runs (SPEC §4, ST-02). Demo/registry components get the plain count instead of
 * a claim that does not describe them.
 *
 * `localDraftCount` covers session-only demo drafts, excluded from the count
 * because they are not stored assets.
 */
export function tailorExtractedSummary(components: ComponentView[], localDraftCount = 0): string {
  const provenance = tailorProvenance(components);
  return tailorSummaryText(provenance, {
    paperDraft: components.some((c) => c.tags.includes('论文抽取草稿')),
    localDraftCount,
  });
}

/** The summary sentence for already-computed provenance (assertable in Node). */
export function tailorSummaryText(
  provenance: TailorProvenance,
  opts: { paperDraft: boolean; localDraftCount?: number },
): string {
  const count = `${opts.paperDraft ? '已抽取 ' : ''}${provenance.componentCount} 个研究组件`;
  const drafts = (opts.localDraftCount ?? 0) > 0 ? `（另有 ${opts.localDraftCount} 个会话内演示草稿）` : '';
  // A missing paper identity makes the paper count incomplete, not zero: the
  // honest string is 未知 (FE-01 §3), never a number that drops components.
  const papers = provenance.paperCount === null ? '论文数未知' : `来自 ${provenance.paperCount} 篇论文`;
  const boundary = opts.paperDraft ? ' · 论文抽取不等于已接入或已验证。' : '';
  return `${count}${drafts} · ${papers}${boundary}`;
}

/**
 * Short display of a long identity value (revision / hash).
 *
 * The full value stays available for copy — `truncated` tells the caller to
 * render a copy affordance. The real identity is never edited, only clipped for
 * the first screen (FE-01 §4).
 */
export function shortRevision(revision: string, keep = 12): { text: string; truncated: boolean } {
  if (revision.length <= keep) return { text: revision, truncated: false };
  return { text: `${revision.slice(0, keep)}…`, truncated: true };
}

// ---------------------------------------------------------------------------
// Research bootstrap display wording (FE-02)
//
// These sentences live in this plain module — not inside the .tsx pages — for
// the same reason as the paper wording above: one sentence per state, shared by
// every surface, and assertable in Node without a DOM. None of them infers a
// fact the data does not carry.
// ---------------------------------------------------------------------------

/** The baseline line for the start panel — three genuinely different states. */
export function baselineStatusText(baseline: BaselineView): string {
  if (baseline.status === 'confirmed') {
    return `Baseline 已确认：${baseline.name ?? '（未提供名称）'}`;
  }
  if (baseline.status === 'proposed') {
    return `Baseline 候选：${baseline.name ?? '（未提供名称）'}（尚未确认）`;
  }
  return `Baseline 未确定${baseline.reason === null ? '' : `：${baseline.reason}`}`;
}

/**
 * The Contract status line.
 *
 * `confirmed` is only claimed when a REAL confirmation source is recorded — a
 * status field alone is not enough, because the model submitting
 * `confirmed: true` is not a user confirmation (shared spec §3, FE-R02).
 */
export function contractStatusText(contract: ResearchContractView): string {
  const revision = `第 ${contract.revision} 版`;
  if (contract.status === 'confirmed') {
    const by = contract.confirmation?.confirmedBy ?? null;
    if (by === null) return `标记为已确认，但没有记录真实确认来源（不视为用户确认） · ${revision}`;
    return `已由 ${by} 确认 · ${revision}`;
  }
  const pending = contract.pendingQuestions.length > 0 ? ` · 待确认项 ${contract.pendingQuestions.length} 项` : '';
  return `草稿（可保存，未确认）${pending} · ${revision}`;
}

/**
 * Whether the Contract can be saved right now.
 *
 * One natural-language sentence about the research question is the ONLY hard
 * requirement — filling in a baseline, dataset or budget is never a gate
 * (FE-02 §3, FE-R02).
 */
export function canSaveContract(draft: { question: string | null }): { ok: boolean; reason: string | null } {
  const question = draft.question?.trim() ?? '';
  if (question.length === 0) {
    return { ok: false, reason: '至少用一句话说明研究问题或方向；其他未知项可保持未确定。' };
  }
  return { ok: true, reason: null };
}

/** Ideas are keyed by stable id — a list index is not an identity across updates. */
export function ideaKey(idea: ResearchIdeaView): string {
  return `${idea.ideaId}@${idea.revision}`;
}

/**
 * The count line for a brainstorm run's result.
 *
 * "0 条" is reported as a real outcome with its reason, never padded to a
 * fixed number of cards and never shown as success (FE-02 §4, FE-R03).
 */
export function brainstormResultText(run: BrainstormRunView, ideas: ResearchIdeaView[]): string {
  const produced = run.ideaIds.length === 0 ? ideas.length : run.ideaIds.length;
  const errors = run.itemErrors.length > 0 ? ` · 逐项失败 ${run.itemErrors.length} 项` : '';
  if (run.status === 'completed' && produced === 0) {
    return run.emptyResultReason === null
      ? '本轮没有产生候选。'
      : `本轮没有产生候选：${run.emptyResultReason}`;
  }
  return `${BRAINSTORM_RUN_META[run.status].label} · 候选 ${produced} 条${errors}`;
}

/** The exploratory notice: no references is allowed, but it must be stated. */
export function ideaBasisNote(idea: ResearchIdeaView): string | null {
  if (idea.basis === 'exploratory') {
    return idea.evidenceRefs.length === 0
      ? '探索性候选，暂无论文依据；待补依据。'
      : '探索性候选，依据待人工核对。';
  }
  // grounded only means the sources are checkable.
  const stale = idea.evidenceRefs.filter((e) => e.state !== 'current').length;
  return stale > 0 ? `有 ${stale} 条依据已过期或缺失，需重新核对。` : null;
}

/**
 * Whether a candidate can be loaded into a node's plan snapshot.
 *
 * `incompatible` never loads; `needs_review` loads only as 待验证 (never as
 * integration success); a locked slot is never replaced here — the caller shows
 * the lock reason (shared spec §5, FE-R06).
 */
export function candidateLoadability(
  candidate: SlotCandidateView,
  slot: SlotView,
): { loadable: boolean; label: string; reason: string | null } {
  if (slot.locked) {
    return {
      loadable: false,
      label: '已锁定',
      reason: slot.lockedBy === null ? '该插槽已被锁定，不能替换。' : `该插槽由 ${slot.lockedBy} 锁定，不能替换。`,
    };
  }
  if (candidate.assessment === 'incompatible') {
    return {
      loadable: false,
      label: '不可装入',
      reason: candidate.incompatibleReason ?? '兼容性评估为不兼容，不能装入方案。',
    };
  }
  if (candidate.assessment === 'needs_review') {
    return { loadable: true, label: '装入为待验证方案', reason: '兼容性未知，装入后标记为待验证，不表示已集成成功。' };
  }
  return { loadable: true, label: '装入方案', reason: null };
}

/**
 * The slot card caption. The candidate COUNT is stated beside the slot status,
 * so a slot with three candidates never reads as three slots and never as
 * "已装入" (FE-02 §5).
 */
export function slotCaption(slot: SlotView): string {
  const scope = SLOT_SCOPE_LABEL[slot.scope];
  const bound = slot.boundRef === null ? '未装入' : `已装入 ${slot.boundRef.label}`;
  const count = `候选 ${slot.candidates.length} 项`;
  const locked = slot.locked ? ' · 已锁定' : '';
  return `${scope} · ${SLOT_STATUS_META[slot.status].label} · ${bound} · ${count}${locked}`;
}

/**
 * The environment line. Probe results are observations about this host, never
 * the user's compute budget and never an authorisation to run anything
 * (shared spec §3, FE-02 §3).
 */
export function environmentSummaryText(observations: EnvironmentObservationView[]): string {
  if (observations.length === 0) return '尚未探测环境。';
  const observed = observations.filter((o) => o.status === 'observed').length;
  const notRun = observations.filter((o) => o.status === 'not_run').length;
  const failed = observations.filter((o) => o.status === 'failed' || o.status === 'unavailable').length;
  // The host identity comes from the observations themselves, so the sentence
  // never prints a UI-side device name as if it were a probe result.
  const host = observations.find((o) => o.hostIdentity !== null)?.hostIdentity ?? '当前宿主';
  const at = observations.find((o) => o.observedAt !== null)?.observedAt ?? null;
  const when = at === null ? '' : ` · ${at}`;
  return `${host}${when}：已探测 ${observed} 项 · 不可用/失败 ${failed} 项 · 未探测 ${notRun} 项（只读探测，不代表预算或运行授权）`;
}
