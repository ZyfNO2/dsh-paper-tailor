/**
 * 论文管理：已导入论文的真实题目、版本、资料范围与关联证据。
 *
 * Redesign plan §3.4 / R08. v1 titled every paper row with
 * `card.name.value` — which is the METHOD name — so the page showed
 * "attention gate" and "U-Net" as paper titles. Here the title is the
 * PaperInput title; when it cannot be resolved the row says so explicitly and
 * NEVER substitutes a method name.
 *
 * Also: a module count is a summary, not the content. The drawer carries the
 * linked modules, the candidate binding and the evidence scope.
 */

import type { PaperCard } from '../wire.ts';
import { s } from './styles.ts';

export interface PaperLibraryProps {
  region: { data: PaperCard[] | null; loading: boolean; error: string | null; scopeKey: string | null };
  query: string;
  onQuery: (value: string) => void;
  selection: string | null;
  onSelect: (paperId: string) => void;
  onOpenModule: (moduleId: string) => void;
  onOpenNode: (nodeId: string) => void;
}

export function PaperLibrary(props: PaperLibraryProps): JSX.Element {
  const { region } = props;
  if (region.loading) return <div className={s.empty}>正在读取论文列表…</div>;
  if (region.error !== null) {
    return (
      <div className={s.errorBox} role="alert">
        论文列表读取失败：{region.error}
        <div className={s.dim}>这是该区域自身的错误；不代表没有论文，也不代表读取成功。</div>
      </div>
    );
  }
  const list = region.data;
  if (list === null) {
    return (
      <div className={s.empty}>
        论文列表按需读取。
        <button type="button" className={s.linkBtn} onClick={() => props.onQuery(props.query)}>读取</button>
      </div>
    );
  }
  if (list.length === 0) return <div className={s.empty}>当前授权范围内没有已导入论文。</div>;

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <input
          className={s.input}
          type="search"
          placeholder="搜索论文题目 / 标识 / 来源"
          aria-label="搜索论文"
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
        />
        <span className={s.dim}>{list.length} 篇</span>
      </div>

      <div className={s.list}>
        {list.map((p) => (
          <PaperRow
            key={p.paperId}
            paper={p}
            selected={props.selection === p.paperId}
            onSelect={() => props.onSelect(p.paperId)}
          />
        ))}
      </div>
    </div>
  );
}

function PaperRow(props: { paper: PaperCard; selected: boolean; onSelect: () => void }): JSX.Element {
  const p = props.paper;
  return (
    <div
      className={`${s.row} ${props.selected ? s.rowSelected : ''}`}
      tabIndex={0}
      role="button"
      onClick={props.onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelect(); } }}
    >
      <div className={s.rowHead}>
        {/* A real title, or an explicit unknown — never a method name. */}
        <strong>{p.title ?? `题目未知（${p.titleUnknownReason ?? '来源未提供'}）`}</strong>
        {p.referencedByCurrentCandidate && <span className={`${s.badge} ${s.badgeReady}`}>当前候选引用</span>}
      </div>
      <div className={s.rowLine}>
        {p.paperId}
        {p.version === null ? '' : ` · 版本 ${p.version}`}
        {p.sourceGroup === null ? '' : ` · 来源 ${p.sourceGroup}`}
      </div>
      <div className={s.rowLine}>
        资料范围：{p.materialScope ?? '未知'}
        {p.availableSections.length > 0 ? `（${p.availableSections.join('、')}）` : ''}
      </div>
      <div className={s.rowLine}>
        抽取：模块 {p.moduleCardCount} · 基线 {p.baselineCardCount}
        {p.documentHash === null ? '' : ` · documentHash ${p.documentHash.slice(0, 12)}`}
      </div>
      {p.sourceUri !== null && (
        <div className={s.rowLine}>
          <span className={s.dim}>{p.sourceUri}</span>
        </div>
      )}
    </div>
  );
}