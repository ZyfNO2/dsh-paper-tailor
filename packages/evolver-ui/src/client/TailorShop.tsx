/**
 * 裁缝铺：模块目录，回答“能用什么、接哪个 slot、当前能否接入、缺什么”。
 *
 * Redesign plan §3.3. v1 rendered a card grid that said “实测：见工作树逐 seed
 * 指标” for every pinned module and “实测：未测” for every P5 card — i.e. it
 * inferred measurement status from the module's ORIGIN. Here:
 *
 *  - “能否接入 / 缺什么” comes from the host's `missing[]`, `slotId` and
 *    `implementationReadiness`, not from a label on the origin;
 *  - an AB arm's effect is attached to the COMBINATION, never to a single
 *    module: `conditionalResultRefs` names the node and variant the effect was
 *    measured under, and a module with no own trial says so;
 *  - “在对话中组合” is NOT rendered. The host composer interface is not wired
 *    to this plugin, so the button would be a lie (plan §3.3).
 */

import { useMemo, useState } from 'react';
import type { ModuleCard } from '../wire.ts';
import { s } from './styles.ts';

export interface TailorShopProps {
  region: { data: ModuleCard[] | null; loading: boolean; error: string | null; scopeKey: string | null };
  query: string;
  onQuery: (value: string) => void;
  selection: string | null;
  onSelect: (id: string) => void;
  onOpenNode: (nodeId: string) => void;
  onOpenPaper: (paperId: string) => void;
}

type Filter = 'all' | 'usable' | 'blocked' | 'measured';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'usable', label: '可接入' },
  { id: 'blocked', label: '缺项' },
  { id: 'measured', label: '本任务有 trial' },
];

export function TailorShop(props: TailorShopProps): JSX.Element {
  const { region } = props;
  const [filter, setFilter] = useState<Filter>('all');

  const filtered = useMemo(() => {
    const list = region.data ?? [];
    return list.filter((m) => {
      if (filter === 'usable') return m.missing.length === 0;
      if (filter === 'blocked') return m.missing.length > 0;
      if (filter === 'measured') return m.conditionalResultRefs.length > 0;
      return true;
    });
  }, [region.data, filter]);

  if (region.loading) return <div className={s.empty}>正在读取模块目录…</div>;
  if (region.error !== null) {
    return (
      <div className={s.errorBox} role="alert">
        模块目录读取失败：{region.error}
        <div className={s.dim}>工作树不受影响：两个区域各自独立加载、独立报错。</div>
      </div>
    );
  }
  if (region.data === null) return <div className={s.empty}>等待模块目录…</div>;
  if (region.data.length === 0) {
    return <div className={s.empty}>本任务没有已导入的模块记录。</div>;
  }

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <input
          className={s.input}
          type="search"
          placeholder="搜索模块名 / 机制"
          aria-label="搜索模块"
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
        />
        <div className={s.chipRow} role="group" aria-label="模块筛选">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={filter === f.id ? `${s.chip} ${s.chipActive}` : s.chip}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className={s.list}>
        {filtered.length === 0 && <div className={s.empty}>该筛选下没有模块。</div>}
        {filtered.map((m) => (
          <ModuleRow
            key={`${m.origin}-${m.id}`}
            module={m}
            selected={props.selection === m.id}
            onSelect={() => props.onSelect(m.id)}
            onOpenNode={props.onOpenNode}
            onOpenPaper={props.onOpenPaper}
          />
        ))}
      </div>

      <div className={s.dim}>
        组合视图在“工作树”：每个组合节点显示 Baseline + 模块名、主指标与相对差值。
      </div>
    </div>
  );
}

function ModuleRow(props: {
  module: ModuleCard;
  selected: boolean;
  onSelect: () => void;
  onOpenNode: (nodeId: string) => void;
  onOpenPaper: (paperId: string) => void;
}): JSX.Element {
  const m = props.module;
  const usable = m.missing.length === 0;
  const hasOwnTrial = m.conditionalResultRefs.length > 0;

  return (
    <div
      className={`${s.row} ${props.selected ? s.rowSelected : ''}`}
      tabIndex={0}
      role="button"
      onClick={props.onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelect(); } }}
    >
      <div className={s.rowHead}>
        <strong>{m.displayName}</strong>
        <span className={`${s.badge} ${usable ? s.badgeReady : s.badgeManual}`}>
          {usable ? '可接入' : '缺项'}
        </span>
        <span className={s.badge}>{ORIGIN_LABEL[m.origin]}</span>
        <span className={s.badge}>{m.status ?? '状态未知'}</span>
      </div>

      <div className={s.rowLine}>
        解决问题：{m.mechanism ?? '来源未描述'}
      </div>
      {m.interventionAxis !== null && (
        <div className={s.rowLine}>干预位置：{m.interventionAxis}{m.modifies === null ? '' : `（${m.modifies}）`}</div>
      )}
      {m.expectedOutput !== null && <div className={s.rowLine}>期望输出：{m.expectedOutput}</div>}

      <div className={s.rowLine}>
        slot：{m.slotId ?? '未声明'}
        {m.implementationReadiness === null ? '' : ` · 实现 readiness：${m.implementationReadiness}`}
      </div>

      {/* Measurement is an ASSOCIATION, not an origin label: this module has a
          trial under a named node, or it does not. */}
      <div className={s.rowLine}>
        本任务 trial：
        {hasOwnTrial
          ? m.conditionalResultRefs.map((r) => `变体 ${r.variantId}（${r.taskId}）`).join('、')
          : '无'}
        {hasOwnTrial ? '' : '（组合效果不计入单模块）'}
      </div>

      {m.missing.length > 0 && (
        <div className={s.opError}>缺：{m.missing.join('；')}</div>
      )}

      <div className={s.rowActions}>
        {m.paperId !== null && (
          <button
            type="button"
            className={s.linkBtn}
            onClick={(e) => { e.stopPropagation(); props.onOpenPaper(m.paperId as string); }}
          >
            看来源论文{m.paperTitle === null ? `（${m.paperId}）` : ''}
          </button>
        )}
        {m.conditionalResultRefs.slice(0, 1).map((r) => (
          <button
            key={r.nodeId}
            type="button"
            className={s.linkBtn}
            onClick={(e) => { e.stopPropagation(); props.onOpenNode(r.nodeId); }}
          >
            看实验
          </button>
        ))}
      </div>
    </div>
  );
}

const ORIGIN_LABEL: Record<string, string> = {
  p5_card: 'P5 卡片',
  phase2_pinned: '已固定实现',
  phase3_protocol: '本任务协议',
};