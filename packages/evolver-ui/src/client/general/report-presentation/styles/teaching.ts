/**
 * W1 报告展示层 · 教学与演示版式样式（作用域 `.rp`）。
 *
 * 硬性约定：
 * - 预测→揭晓用原生 details/summary，键盘可达，揭晓前后内容都是静态文案；
 * - 练习选项是只读展示（生产交互由 W3 组件实现），答对不等于科研验证，配文字提醒；
 * - 演示模式的自动播放控件必须显示「暂停」语义；本静态版式只提供可见控件样式与说明，
 *   实际自动播放由 W3 组件实现且必须可暂停；
 * - 步骤导航锚点支持 :focus-visible 与键盘序号，不用鼠标悬停承载信息。
 */

export const RP_TEACHING_CSS = `
.rp .rp-steps{display:grid;gap:0;min-width:0;counter-reset:rp-step}
.rp .rp-step{display:grid;grid-template-columns:34px minmax(0,1fr);gap:12px;padding:12px 4px;border-bottom:1px solid var(--rp-line)}
.rp .rp-step:last-child{border-bottom:0}
.rp .rp-step-num{counter-increment:rp-step;width:30px;height:30px;border:1px solid var(--rp-line);border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:650;background:var(--rp-surface)}
.rp .rp-step-num::before{content:counter(rp-step)}
.rp .rp-step-body{min-width:0;display:grid;gap:6px}
.rp .rp-step-body p{font-size:12px}
.rp details.rp-reveal{border:1px solid var(--rp-line);border-radius:10px;background:var(--rp-surface);min-width:0}
.rp details.rp-reveal>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:10px;padding:12px 14px;font-weight:600;font-size:13px}
.rp details.rp-reveal>summary::-webkit-details-marker{display:none}
.rp details.rp-reveal>summary::before{content:"▶";font-size:11px;flex-shrink:0;transition:transform .15s ease}
.rp details.rp-reveal[open]>summary::before{transform:rotate(90deg)}
.rp details.rp-reveal .rp-reveal-body{padding:0 14px 14px;font-size:12px;display:grid;gap:8px;min-width:0}
.rp .rp-reveal-tag{font-size:10px;letter-spacing:1px;color:var(--rp-muted);font-weight:650}
.rp .rp-quiz{display:grid;gap:8px;min-width:0}
.rp .rp-quiz-option{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--rp-line);border-radius:8px;padding:10px 12px;font-size:12px;background:var(--rp-surface)}
.rp .rp-quiz-option .rp-quiz-key{width:22px;height:22px;flex-shrink:0;border:1px solid var(--rp-line);border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:650}
.rp .rp-quiz-answer{border:1px solid #b9dcc9;background:var(--rp-green-soft);border-radius:8px;padding:10px 12px;font-size:12px}
.rp .rp-quiz-caveat{font-size:11px;color:var(--rp-muted);overflow-wrap:anywhere}
.rp .rp-demo-nav{display:flex;gap:8px;flex-wrap:wrap;min-width:0}
.rp .rp-demo-nav a{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:7px 12px;border:1px solid var(--rp-line);border-radius:8px;background:var(--rp-surface);color:var(--rp-ink);text-decoration:none}
.rp .rp-demo-nav a::before{content:attr(data-step) " ";font-weight:650;color:var(--rp-muted)}
.rp .rp-demo-nav a[aria-current="step"]{border-color:var(--rp-blue);background:var(--rp-blue-soft);color:var(--rp-blue)}
.rp .rp-demo-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border:1px dashed var(--rp-line);border-radius:8px;background:#fbfcfe;font-size:12px}
.rp .rp-demo-controls .rp-demo-state{display:inline-flex;align-items:center;gap:6px;font-weight:650}
.rp .rp-demo-controls .rp-demo-state::before{content:"⏸";font-size:12px}
.rp .rp-demo-controls .rp-demo-state[data-state="paused"]::before{content:"Ⅱ"}
.rp .rp-demo-controls .rp-demo-state[data-state="playing"]::before{content:"▶"}
.rp .rp-demo-progress{display:flex;gap:4px;flex-wrap:wrap}
.rp .rp-demo-progress span{width:22px;height:6px;border-radius:3px;background:#e2e7ee}
.rp .rp-demo-progress span[data-done="true"]{background:var(--rp-blue)}
.rp .rp-demo-progress span[data-done="true"]::after{content:"";margin:0}
.rp .rp-demo-hint{font-size:11px;color:var(--rp-muted)}
@media (max-width:650px){.rp .rp-step{grid-template-columns:28px minmax(0,1fr);gap:8px}.rp .rp-demo-nav a{flex:1 1 auto;justify-content:center}}
`;

/** 教学/演示 class 名注册表。 */
export const RP_TEACHING_CLASS_NAMES = Object.freeze({
  steps: 'rp-steps',
  step: 'rp-step',
  stepNum: 'rp-step-num',
  stepBody: 'rp-step-body',
  reveal: 'rp-reveal',
  revealBody: 'rp-reveal-body',
  revealTag: 'rp-reveal-tag',
  quiz: 'rp-quiz',
  quizOption: 'rp-quiz-option',
  quizKey: 'rp-quiz-key',
  quizAnswer: 'rp-quiz-answer',
  quizCaveat: 'rp-quiz-caveat',
  demoNav: 'rp-demo-nav',
  demoControls: 'rp-demo-controls',
  demoState: 'rp-demo-state',
  demoProgress: 'rp-demo-progress',
  demoHint: 'rp-demo-hint',
});
