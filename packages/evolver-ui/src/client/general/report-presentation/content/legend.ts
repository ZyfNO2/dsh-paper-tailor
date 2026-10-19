/**
 * W1 报告展示层 · 图例条目（状态符号 + 文字说明）。
 *
 * 硬性约定：每个图例条目同时有符号（symbol）、标签（label）与文字说明（summary/details），
 * 颜色只是辅助；id 与 styles/status.ts 的 RP_STATUS_CLASS_NAMES 对应。
 * 只解释概念，不写科研结论。
 */
import {
  RP_FAILED_BLOCKED_NOTE,
  RP_FROZEN_NOTE,
  RP_INCOMPARABLE_NOTE,
  RP_NEEDS_REVIEW_NOTE,
  RP_REVOKED_NOTE,
  RP_UNIT_MISMATCH_NOTE,
  RP_UNKNOWN_NOTE,
} from './banner.ts';

export interface RpLegendEntry {
  readonly id: string;
  /** 与状态 chip ::before 相同的符号，保证图例与正文一致。 */
  readonly symbol: string;
  readonly label: string;
  readonly summary: string;
  readonly details: string;
}

export const RP_LEGEND_ENTRIES: readonly RpLegendEntry[] = [
  {
    id: 'origin-source',
    symbol: '◆',
    label: '来源报告',
    summary: '数值由外部材料/文献报告提供，未经本系统重新计算。',
    details:
      '来源报告（source_reported）：数值按来源材料的原始口径记录，标注出处与定位信息。它可能是论文、表格或人工记录；显示时不与实际计算结果合并成一个分数。',
  },
  {
    id: 'origin-calc',
    symbol: '●',
    label: '实际计算',
    summary: '数值由本系统按冻结协议对数据集执行计算得到。',
    details:
      '实际计算（system_calculation）：记录了计算标识、输入数据与执行状态。计算完成不等于假设成立，结论仍由审查判断决定。',
  },
  {
    id: 'origin-sim',
    symbol: '▨',
    label: '模拟',
    summary: '数值来自明确标记的模拟/演示数据，斜纹是它的视觉标识。',
    details:
      '模拟（simulation）：输入数据的性质是模拟（虚构或演示用途），不是真实观测。模拟行不与真实行建立比较，也不进入研究结论；本页所有示例本身就是模拟数据。',
  },
  {
    id: 'unknown',
    symbol: '○',
    label: '未知（无值）',
    summary: '输入没有提供该数值。',
    details: RP_UNKNOWN_NOTE,
  },
  {
    id: 'needs-review',
    symbol: '⏳',
    label: '待重审',
    summary: '依赖的输入已更新或过期，需重新审核。',
    details: RP_NEEDS_REVIEW_NOTE,
  },
  {
    id: 'failed',
    symbol: '✕',
    label: '失败',
    summary: '执行过但未成功，保留首次错误。',
    details: RP_FAILED_BLOCKED_NOTE,
  },
  {
    id: 'blocked',
    symbol: '⏸',
    label: '阻塞',
    summary: '未执行，前置条件未满足。',
    details: RP_FAILED_BLOCKED_NOTE,
  },
  {
    id: 'unit-mismatch',
    symbol: '⇹',
    label: '单位不一致',
    summary: '记录单位与协议定义的单位不同，不做自动换算。',
    details: RP_UNIT_MISMATCH_NOTE,
  },
  {
    id: 'incomparable',
    symbol: '⚖',
    label: '不可比较',
    summary: '系统未建立比较，保持不可比较。',
    details: RP_INCOMPARABLE_NOTE,
  },
  {
    id: 'revoked',
    symbol: '⛔',
    label: '已撤销',
    summary: '访问权限已收回，来源当前不可访问。',
    details: RP_REVOKED_NOTE,
  },
  {
    id: 'frozen',
    symbol: '❄',
    label: '冻结协议',
    summary: '指标口径已固定，跨版本不可直接比较。',
    details: RP_FROZEN_NOTE,
  },
  {
    id: 'target-met',
    symbol: '▲',
    label: '目标达成',
    summary: '数值落在协议定义的目标区间内。',
    details: '目标达成/未达成由输入提供的目标区间（最小值/最大值）判断；没有配置目标时显示"目标未知"，而不是默认达成。',
  },
  {
    id: 'target-not-met',
    symbol: '▽',
    label: '目标未达成',
    summary: '数值未落在协议定义的目标区间内。',
    details: '目标达成/未达成由输入提供的目标区间（最小值/最大值）判断；没有配置目标时显示"目标未知"，而不是默认达成。',
  },
  {
    id: 'target-unknown',
    symbol: '○',
    label: '目标未知',
    summary: '该指标未配置目标区间。',
    details: '目标达成/未达成由输入提供的目标区间（最小值/最大值）判断；没有配置目标时显示"目标未知"，而不是默认达成。',
  },
] as const;

/** 按 id 查图例（W2 渲染 chip 时使用；缺省返回 null，由调用方显示未知占位）。 */
export function rpLegendById(id: string): RpLegendEntry | null {
  return RP_LEGEND_ENTRIES.find((entry) => entry.id === id) ?? null;
}
