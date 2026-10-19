/**
 * W1 报告展示层 · 四种展示模式的说明文案。
 *
 * 硬性约定：同一份报告、同一组事实、一个入口；模式只改变布局、解释层次与展开状态，
 * 不改变数值、版本、来源性质、判断与不确定性。
 */

export type RpModeId = 'academic' | 'plain' | 'teaching' | 'demo';

export interface RpModeCopy {
  readonly id: RpModeId;
  readonly label: string;
  readonly tagline: string;
  readonly focus: string;
  readonly neverChanges: string;
}

export const RP_MODE_COPIES: readonly RpModeCopy[] = [
  {
    id: 'academic',
    label: '学术',
    tagline: '方法、口径、证据与限制',
    focus: '完整展示冻结协议口径、指标矩阵与差值、计算摘要、来源性质、审查判断、未知项与边界。',
    neverChanges: '数值、版本、来源性质、判断与不确定性在任何模式下都相同。',
  },
  {
    id: 'plain',
    label: '通俗',
    tagline: '同一结果，说得让人听懂',
    focus: '用短句与术语解释理解同一份事实；每个术语首次出现都配解释；不省略失败与未知。',
    neverChanges: '不会把"可能/未知"说成肯定，也不会把相关说成因果。',
  },
  {
    id: 'teaching',
    label: '教学',
    tagline: '先预测，再揭晓，配小练习',
    focus: '分步讲解报告结构；先预测后揭晓；用选择题与自我解释巩固概念理解。',
    neverChanges: '练习答对不等于科研验证；答案只来自本页明确材料与规则。',
  },
  {
    id: 'demo',
    label: '演示',
    tagline: '按节奏讲重点，保留全部限制',
    focus: '按步骤导航讲解重点结论与过程；为汇报设计节奏；自动播放必须可暂停。',
    neverChanges: '不隐藏失败、未知或限制，也不另生成一套实验结果。',
  },
] as const;

/** 按模式 id 取说明。 */
export function rpModeCopy(id: RpModeId): RpModeCopy {
  const found = RP_MODE_COPIES.find((mode) => mode.id === id);
  if (!found) throw new Error('Unknown report presentation mode: ' + id);
  return found;
}
