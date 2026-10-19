/**
 * W1 报告展示层 · 核心局部样式（作用域前缀 `.rp-`，根作用域类 `.rp`）。
 *
 * 设计约定：
 * - 复用工作台 `.gw` 设计变量（--ink/--muted/--line/--blue/--green/--amber/--red 等），
 *   并在变量后写回退值，保证独立静态示例脱离 `.gw` 也能正常渲染。
 * - 只输出局部作用域 CSS 字符串常量，由 W2 组件 / 旗舰注入，不修改全局样式。
 * - 可访问性硬性要求：键盘焦点可见（:focus-visible）、prefers-reduced-motion、
 *   状态不能只靠颜色（结合符号/文字/边框形态）、长术语与长表可换行与滚动。
 */

/** 根作用域、设计令牌回退、基础排版、跳转链接、屏幕阅读器辅助、焦点与减少动画。 */
/* 横幅文案常量 RP_BANNER_* 归 content/banner.ts（文案层），此处只负责横幅样式。 */
export const RP_BASE_CSS = `
.rp{--rp-bg:var(--bg,#f5f7fa);--rp-surface:var(--surface,#fff);--rp-ink:var(--ink,#182435);--rp-muted:var(--muted,#5f6e80);--rp-line:var(--line,#e2e7ee);--rp-blue:var(--blue,#275bd8);--rp-blue-soft:var(--blue-soft,#edf3ff);--rp-green:var(--green,#167456);--rp-amber:var(--amber,#94620d);--rp-red:var(--red,#b43e40);--rp-amber-soft:var(--rp-amber-soft,#fff4db);--rp-red-soft:var(--rp-red-soft,#fff1f1);--rp-green-soft:var(--rp-green-soft,#e9f5f0);color:var(--rp-ink);background:var(--rp-bg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.rp *{box-sizing:border-box}
.rp button,.rp input,.rp select,.rp textarea{font:inherit}
.rp h1,.rp h2,.rp h3,.rp h4,.rp p,.rp figure,.rp ul,.rp ol,.rp dl{margin:0}
.rp h1{font-size:24px;letter-spacing:-.5px;line-height:1.3}
.rp h2{font-size:17px;line-height:1.35}
.rp h3{font-size:14px}
.rp ul,.rp ol{padding-left:22px}
.rp a{color:var(--rp-blue)}
.rp .rp-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.rp .rp-sr:focus{position:static;width:auto;height:auto;margin:0;overflow:visible;clip:auto;white-space:normal}
.rp .rp-skip{position:absolute;left:-9999px;top:0;z-index:60;background:var(--rp-surface);color:var(--rp-ink);padding:10px 16px;border:2px solid var(--rp-blue);border-radius:8px}
.rp .rp-skip:focus{left:12px;top:12px}
.rp :is(a,button,summary,[tabindex],input,select):focus-visible{outline:3px solid #426cdf;outline-offset:3px;border-radius:4px}
.rp :is(a,button,summary,[tabindex],input,select):focus:not(:focus-visible){outline:none}
.rp .rp-banner{position:sticky;top:0;z-index:40;display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;padding:8px 14px;background:var(--rp-amber-soft);border-bottom:2px solid var(--rp-amber);color:#7a520b;font-weight:700;text-align:center}
.rp .rp-banner::before{content:"⚠";font-size:15px;line-height:1;flex-shrink:0}
.rp .rp-banner .rp-banner-main{font-size:13px;letter-spacing:.4px}
.rp .rp-banner .rp-banner-note{font-size:11px;font-weight:500;color:#8a6a2c;overflow-wrap:anywhere}
.rp .rp-banner a,.rp .rp-banner button{color:#7a520b;border-color:#c9a95f;text-decoration:underline}
.rp .rp-note{display:flex;gap:10px;align-items:flex-start;background:var(--rp-blue-soft);border:1px solid #d7e3ff;border-radius:10px;padding:12px 16px;font-size:12px;color:#274b8f;overflow-wrap:anywhere}
.rp .rp-note::before{content:"ℹ";flex-shrink:0;font-size:14px;line-height:1.5}
.rp .rp-warn{background:var(--rp-amber-soft);border:1px dashed var(--rp-amber);border-radius:10px;padding:12px 16px;font-size:12px;color:#7a520b;overflow-wrap:anywhere}
.rp .rp-error-box{display:flex;gap:10px;background:var(--rp-red-soft);border:1px solid #efd4d4;border-left:4px solid var(--rp-red);border-radius:8px;padding:12px 16px;font-size:12px;color:var(--rp-red);overflow-wrap:anywhere}
.rp .rp-error-box::before{content:"✕";font-weight:700;flex-shrink:0}
.rp .rp-muted{color:var(--rp-muted)}
.rp .rp-small{font-size:12px}
.rp .rp-mono{font-variant-numeric:tabular-nums;font-family:ui-monospace,Consolas,"Courier New",monospace}
@media (prefers-reduced-motion:reduce){.rp *,.rp *::before,.rp *::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
`;

/** 版面：报告卡片、分区标题、网格、窄屏折叠、长内容换行与滚动容器。 */
export const RP_LAYOUT_CSS = `
.rp .rp-page{display:grid;gap:18px;padding:18px 20px 26px;min-width:0}
.rp .rp-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.rp .rp-page-head .rp-eyebrow{font-size:11px;letter-spacing:1.3px;color:var(--rp-muted);font-weight:600}
.rp .rp-page-head p{margin-top:6px;font-size:12px;color:var(--rp-muted)}
.rp .rp-card{background:var(--rp-surface);border:1px solid var(--rp-line);border-radius:12px;box-shadow:0 5px 18px #1c36500a;min-width:0}
.rp .rp-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:14px 18px;border-bottom:1px solid var(--rp-line)}
.rp .rp-card-head h2,.rp .rp-card-head h3{font-size:15px}
.rp .rp-card-body{padding:16px 18px;display:grid;gap:12px;min-width:0}
.rp .rp-card-body p{overflow-wrap:anywhere}
.rp .rp-grid{display:grid;gap:14px;min-width:0}
.rp .rp-grid-2{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.rp .rp-grid-4{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.rp .rp-stack{display:grid;gap:10px;min-width:0}
.rp .rp-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:12px;min-width:0}
.rp .rp-kv dt{color:var(--rp-muted);white-space:nowrap}
.rp .rp-kv dd{margin:0;overflow-wrap:anywhere}
.rp .rp-term,.rp .rp-card-body strong,.rp .rp-table th{overflow-wrap:anywhere}
.rp .rp-scroll-x{overflow:auto;max-width:100%;min-width:0}
.rp .rp-scroll-x:focus-visible{outline:3px solid #426cdf;outline-offset:2px}
.rp .rp-big-number{font-size:26px;font-weight:650;font-variant-numeric:tabular-nums}
.rp .rp-footnote{font-size:11px;color:var(--rp-muted);overflow-wrap:anywhere}
@media (max-width:960px){.rp .rp-page{padding:16px 14px 22px}.rp .rp-grid-4{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}}
@media (max-width:650px){.rp h1{font-size:20px}.rp .rp-page-head{flex-direction:column}.rp .rp-banner .rp-banner-note{display:none}.rp .rp-banner .rp-banner-toggle-note{display:inline}}
`;

/** 关键 class 名注册表：W2 组件与测试引用，避免字符串散落。 */
export const RP_CLASS_NAMES = Object.freeze({
  scope: 'rp',
  banner: 'rp-banner',
  bannerMain: 'rp-banner-main',
  bannerNote: 'rp-banner-note',
  skip: 'rp-skip',
  screenReader: 'rp-sr',
  note: 'rp-note',
  warn: 'rp-warn',
  errorBox: 'rp-error-box',
  page: 'rp-page',
  card: 'rp-card',
  cardHead: 'rp-card-head',
  cardBody: 'rp-card-body',
  grid: 'rp-grid',
  grid2: 'rp-grid-2',
  grid4: 'rp-grid-4',
  stack: 'rp-stack',
  keyValues: 'rp-kv',
  scrollX: 'rp-scroll-x',
  bigNumber: 'rp-big-number',
  footnote: 'rp-footnote',
});
