/**
 * W1 报告展示层 · 状态样式（作用域 `.rp`）。
 *
 * 硬性约定：每个状态都由「符号 + 文字 + 形态」共同表达，绝不只靠颜色——
 * - 来源性质：◆ 来源报告（实线蓝框）、● 实际计算（实线绿框）、▨ 模拟（斜纹填充 + 虚线琥珀框）；
 * - 数据状态：○ 未知/缺失（虚线）、⏳ 待重审（虚线）、✕ 失败（左侧粗线）、⏸ 阻塞（双线）、
 *   ⇹ 单位不一致（波浪下划线）、⚖ 不可比较（删除线样式边框）、⛔ 已撤销（删除线文字）；
 * - 冻结协议用 ❄ + 文字；目标达成 ▲ / 未达成 ▽。
 * 文字标签永远显示（.rp-chip 内文本由组件渲染），符号由 ::before 输出。
 */

export const RP_STATUS_CSS = `
.rp .rp-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;font-size:11px;font-weight:600;line-height:1.5;padding:2px 8px;border-radius:5px;border:1px solid var(--rp-line);background:#edf0f4;color:#566576;white-space:normal;overflow-wrap:anywhere}
.rp .rp-chip::before{font-size:12px;line-height:1;flex-shrink:0;font-style:normal}
.rp .rp-chip-origin-source{background:var(--rp-blue-soft);border:1px solid #b7c9ee;color:var(--rp-blue)}
.rp .rp-chip-origin-source::before{content:"◆"}
.rp .rp-chip-origin-calc{background:var(--rp-green-soft);border:1px solid #b9dcc9;color:var(--rp-green)}
.rp .rp-chip-origin-calc::before{content:"●"}
.rp .rp-chip-origin-sim{background:repeating-linear-gradient(45deg,#fff7e6 0 6px,#ffedb8 6px 12px);border:1px dashed var(--rp-amber);color:#7a520b}
.rp .rp-chip-origin-sim::before{content:"▨"}
.rp .rp-chip-unknown{background:#f2f4f7;border:1px dashed #9aa7b6;color:var(--rp-muted)}
.rp .rp-chip-unknown::before{content:"○"}
.rp .rp-chip-review{background:var(--rp-amber-soft);border:1px dashed var(--rp-amber);color:#7a520b}
.rp .rp-chip-review::before{content:"⏳"}
.rp .rp-chip-failed{background:var(--rp-red-soft);border:1px solid #efd4d4;border-left:4px solid var(--rp-red);color:var(--rp-red)}
.rp .rp-chip-failed::before{content:"✕";font-weight:700}
.rp .rp-chip-blocked{background:var(--rp-red-soft);border:4px double var(--rp-red);color:var(--rp-red)}
.rp .rp-chip-blocked::before{content:"⏸"}
.rp .rp-chip-unit{background:var(--rp-amber-soft);border:1px solid var(--rp-amber);color:#7a520b}
.rp .rp-chip-unit::before{content:"⇹"}
.rp .rp-chip-unit .rp-chip-text{text-decoration:underline wavy var(--rp-amber) 1px;text-underline-offset:3px}
.rp .rp-chip-incomparable{background:#f2f4f7;border:1px solid #9aa7b6;color:var(--rp-muted)}
.rp .rp-chip-incomparable::before{content:"⚖"}
.rp .rp-chip-revoked{background:#f2f4f7;border:1px solid #9aa7b6;color:var(--rp-muted)}
.rp .rp-chip-revoked::before{content:"⛔"}
.rp .rp-chip-revoked .rp-chip-text{text-decoration:line-through}
.rp .rp-chip-frozen{background:var(--rp-blue-soft);border:1px solid #b7c9ee;color:var(--rp-blue)}
.rp .rp-chip-frozen::before{content:"❄"}
.rp .rp-chip-target-met{background:var(--rp-green-soft);border:1px solid #b9dcc9;color:var(--rp-green)}
.rp .rp-chip-target-met::before{content:"▲"}
.rp .rp-chip-target-not-met{background:var(--rp-red-soft);border:1px solid #efd4d4;color:var(--rp-red)}
.rp .rp-chip-target-not-met::before{content:"▽"}
.rp .rp-chip-target-unknown{background:#f2f4f7;border:1px dashed #9aa7b6;color:var(--rp-muted)}
.rp .rp-chip-target-unknown::before{content:"○"}
.rp .rp-chip-judgment-supported{background:var(--rp-green-soft);border:1px solid #b9dcc9;color:var(--rp-green)}
.rp .rp-chip-judgment-supported::before{content:"✔"}
.rp .rp-chip-judgment-partial{background:var(--rp-amber-soft);border:1px dashed var(--rp-amber);color:#7a520b}
.rp .rp-chip-judgment-partial::before{content:"◐"}
.rp .rp-chip-judgment-insufficient{background:#f2f4f7;border:1px dashed #9aa7b6;color:var(--rp-muted)}
.rp .rp-chip-judgment-insufficient::before{content:"○"}
.rp .rp-chip-judgment-paused{background:var(--rp-amber-soft);border:1px dashed var(--rp-amber);color:#7a520b}
.rp .rp-chip-judgment-paused::before{content:"⏸"}
.rp .rp-status-reason{font-size:11px;color:var(--rp-muted);overflow-wrap:anywhere}
`;

/** 状态 class 名注册表（与 content/legend.ts 的 legendId 一一对应）。 */
export const RP_STATUS_CLASS_NAMES = Object.freeze({
  base: 'rp-chip',
  originSource: 'rp-chip-origin-source',
  originCalc: 'rp-chip-origin-calc',
  originSim: 'rp-chip-origin-sim',
  unknown: 'rp-chip-unknown',
  review: 'rp-chip-review',
  failed: 'rp-chip-failed',
  blocked: 'rp-chip-blocked',
  unitMismatch: 'rp-chip-unit',
  incomparable: 'rp-chip-incomparable',
  revoked: 'rp-chip-revoked',
  frozen: 'rp-chip-frozen',
  targetMet: 'rp-chip-target-met',
  targetNotMet: 'rp-chip-target-not-met',
  targetUnknown: 'rp-chip-target-unknown',
  judgmentSupported: 'rp-chip-judgment-supported',
  judgmentPartial: 'rp-chip-judgment-partial',
  judgmentInsufficient: 'rp-chip-judgment-insufficient',
  judgmentPaused: 'rp-chip-judgment-paused',
  statusReason: 'rp-status-reason',
});
