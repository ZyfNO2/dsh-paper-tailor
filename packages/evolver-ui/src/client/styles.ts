/* 工作台样式：插件自注入（无构建期 CSS 管道），类名以 evw- 前缀避免冲突。
   仅使用 DSH 语义 token，缺省回退到继承色。

   Layout note (SPEC 8.1 / plan §6.2): the graph area scrolls horizontally and
   the drawer collapses below the main column under ~1024px, so node names,
   status and results stay readable at the host's narrow widths instead of
   being truncated. Every state that carries meaning also carries a WORD, never
   colour alone. */
const CSS = `
.evw-page{display:flex;flex-direction:column;gap:10px;height:100%;overflow-y:auto;padding:12px 16px;color:var(--dsw-alias-text-primary,inherit);font-size:13px}
.evw-topRow{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.evw-select{background:var(--dsw-alias-bg-input,transparent);color:inherit;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));border-radius:6px;padding:4px 8px;font-size:13px;max-width:420px}
.evw-input{background:var(--dsw-alias-bg-input,transparent);color:inherit;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));border-radius:6px;padding:5px 8px;font-size:13px;min-width:220px}
.evw-meta{color:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9));font-size:12px}
.evw-issues{border:1px solid var(--dsw-alias-border-warning,rgba(214,158,46,.5));background:var(--dsw-alias-bg-warning-subtle,rgba(214,158,46,.08));border-radius:8px;padding:8px 10px;font-size:12px;display:flex;flex-direction:column;gap:4px}
.evw-issues>summary{cursor:pointer}
.evw-navRow{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.25))}
.evw-navTab{appearance:none;background:transparent;border:none;border-bottom:2px solid transparent;color:var(--dsw-alias-text-secondary,inherit);padding:6px 10px;font-size:13px;cursor:pointer}
.evw-navTabActive{color:var(--dsw-alias-text-primary,inherit);border-bottom-color:var(--dsw-alias-border-active,currentColor);font-weight:600}
.evw-section{display:flex;flex-direction:column;gap:8px}
.evw-body{display:flex;gap:12px;align-items:flex-start}
.evw-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:8px}
.evw-drawer{flex:0 0 340px;max-width:340px;position:sticky;top:0;max-height:calc(100vh - 160px);overflow-y:auto;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.25));border-radius:8px;padding:10px 12px}
@media (max-width:1100px){.evw-body{flex-direction:column}.evw-drawer{flex:1 1 auto;max-width:none;width:100%;position:static;max-height:none}}

/* --- result summary --- */
.evw-summaryBox{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.25));border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-surface-secondary,transparent)}
.evw-summaryHead{font-weight:600;font-size:12px;color:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9))}

/* --- graph canvas --- */
.evw-canvasScroll{overflow-x:auto;overflow-y:hidden;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.2));border-radius:8px;padding:4px}
.evw-canvas{display:block;color:var(--dsw-alias-text-secondary,inherit)}
.evw-node{cursor:pointer}
.evw-node:focus{outline:2px solid var(--dsw-alias-border-active,currentColor)}
.evw-nodeBox{fill:var(--dsw-alias-bg-surface-primary,transparent);stroke:var(--dsw-alias-border-secondary,rgba(128,128,128,.35));stroke-width:1}
.evw-nodeSelected .evw-nodeBox{stroke:var(--dsw-alias-border-active,currentColor);stroke-width:2.5}
.evw-nodeBaseline .evw-nodeBox{stroke-dasharray:none}
.evw-nodeFlow .evw-nodeBox{opacity:.92}
.evw-nodeName{fill:var(--dsw-alias-text-primary,inherit);font-size:12px;font-weight:600}
.evw-nodeKind{fill:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9));font-size:10px}
.evw-nodeMetric{fill:var(--dsw-alias-text-primary,inherit);font-size:11px}
.evw-nodeUnit{fill:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9));font-size:10px}
.evw-nodeDelta{font-size:11px;font-weight:600}
.evw-nodeCoverage{fill:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9));font-size:10px}
.evw-edge{color:var(--dsw-alias-border-secondary,rgba(128,128,128,.5))}
.evw-edgeActive{color:var(--dsw-alias-border-active,currentColor)}
.evw-edgeLabel{fill:var(--dsw-alias-text-tertiary,rgba(128,128,128,.95));font-size:9px}
.evw-legend{display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:11px;color:var(--dsw-alias-text-secondary,inherit)}
.evw-legendItem{display:inline-flex;gap:4px;align-items:center}
.evw-legendSvg{display:inline-block}

/* --- status tones: colour is paired with a word in the node body --- */
.evw-toneGood{stroke:var(--dsw-alias-border-success,rgba(76,175,80,.85));fill:var(--dsw-alias-text-success,rgba(76,175,80,.95))}
.evw-toneWarn{stroke:var(--dsw-alias-border-warning,rgba(214,158,46,.85));fill:var(--dsw-alias-text-warning,rgba(214,158,46,.95))}
.evw-toneBad{stroke:var(--dsw-alias-border-danger,rgba(229,57,53,.85));fill:var(--dsw-alias-text-danger,rgba(229,57,53,.95))}
.evw-toneFlat{stroke:var(--dsw-alias-border-secondary,rgba(128,128,128,.6));fill:var(--dsw-alias-text-secondary,inherit)}
.evw-toneNone{stroke:var(--dsw-alias-border-secondary,rgba(128,128,128,.3));fill:var(--dsw-alias-text-tertiary,rgba(128,128,128,.7))}

/* --- lists (裁缝铺 / 论文管理) --- */
.evw-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.evw-chipRow{display:flex;gap:4px;flex-wrap:wrap}
.evw-chipList{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:4px}
.evw-chip{appearance:none;background:transparent;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));border-radius:999px;padding:2px 10px;font-size:11px;cursor:pointer;color:inherit}
.evw-chipActive{border-color:var(--dsw-alias-border-active,currentColor);font-weight:600}
.evw-list{display:flex;flex-direction:column;gap:6px}
.evw-row{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.22));border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:3px;cursor:pointer}
.evw-row:focus{outline:2px solid var(--dsw-alias-border-active,currentColor)}
.evw-rowSelected{border-color:var(--dsw-alias-border-active,currentColor)}
.evw-rowHead{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.evw-rowLine{font-size:12px;color:var(--dsw-alias-text-secondary,inherit)}
.evw-rowActions{display:flex;gap:10px;margin-top:2px}
.evw-linkBtn{appearance:none;background:none;border:none;color:var(--dsw-alias-text-accent,#4a9eff);cursor:pointer;padding:0;font-size:12px;text-decoration:underline}
.evw-badge{font-size:11px;border-radius:999px;padding:1px 8px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));color:var(--dsw-alias-text-secondary,inherit)}
.evw-badgeManual{border-color:var(--dsw-alias-border-warning,rgba(214,158,46,.6))}
.evw-badgeReady{border-color:var(--dsw-alias-border-success,rgba(76,175,80,.6))}

/* --- drawer --- */
.evw-drawerHead{display:flex;flex-direction:column;gap:6px}
.evw-drawerBody{display:flex;flex-direction:column;gap:10px}
.evw-drawerTitle{margin:0;font-size:14px}
.evw-drawerSection{display:flex;flex-direction:column;gap:4px}
.evw-drawerHeading{margin:0;font-size:12px;color:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9))}
.evw-closeBtn{appearance:none;background:none;border:none;color:inherit;font-size:16px;cursor:pointer;align-self:flex-end;line-height:1}
.evw-table{border-collapse:collapse;font-size:11px;width:100%}
.evw-table th,.evw-table td{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.25));padding:2px 6px;text-align:left}
.evw-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;font-size:11px;margin:0}
.evw-kv dt{color:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9))}
.evw-kv dd{margin:0;word-break:break-all}

/* --- misc --- */
.evw-opRow{display:flex;gap:8px;align-items:baseline;font-size:12px;flex-wrap:wrap}
.evw-opStatus{min-width:72px}
.evw-opError{color:var(--dsw-alias-text-danger,rgba(229,57,53,.9))}
.evw-dim{color:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9));font-size:11px}
.evw-errorBox{border:1px solid var(--dsw-alias-border-danger,rgba(229,57,53,.5));background:var(--dsw-alias-bg-danger-subtle,rgba(229,57,53,.08));border-radius:8px;padding:8px 10px;font-size:12px;display:flex;flex-direction:column;gap:4px}
.evw-empty{color:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9));font-size:12px;padding:12px 0}

/* --- v3: composition rationale + model data flow --- */
.evw-rationale{display:flex;flex-direction:column;gap:10px;font-size:12px;min-width:0}
.evw-rationaleTitle{margin:0;font-size:14px}
.evw-rationaleMeta{margin:0;color:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9));font-size:11px;word-break:break-all}
.evw-rationaleSection{display:flex;flex-direction:column;gap:4px;min-width:0}
.evw-rationaleHeading{margin:0;font-size:12px;color:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9))}
/* An empty state must read as "there is nothing recorded", not as a bug. */
.evw-rationaleEmpty{margin:0;color:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9));font-size:11px}
.evw-rationaleUnknown{margin:0;color:var(--dsw-alias-text-danger,rgba(229,57,53,.9));font-size:12px}
.evw-rationaleUnresolvedList{margin:0;padding-left:16px;font-size:11px;color:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9))}
/* Long extracted names must wrap rather than overflow their column. */
.evw-claim,.evw-claimUnknown{margin:0;line-height:1.5;overflow-wrap:anywhere}
.evw-claimStatus{
  display:inline-block;margin-right:6px;padding:0 5px;border-radius:4px;font-size:10px;
  border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));
  color:var(--dsw-alias-text-secondary,rgba(200,200,200,.95));white-space:nowrap;vertical-align:1px;
}
/* Each status also differs in border weight so the distinction survives a
   monochrome theme and does not rest on hue alone. */
.evw-claimStatus[data-status="source_reported"]{border-width:2px}
.evw-claimStatus[data-status="inferred"]{border-style:dashed}
.evw-claimStatus[data-status="hypothesis"]{border-style:dotted}
.evw-claimStatus[data-status="unknown"]{opacity:.75;font-style:italic}
.evw-tagList{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.evw-tagRow{margin:0}
.evw-tagButton{
  display:inline-flex;align-items:baseline;gap:5px;font-size:11px;padding:2px 7px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));
  background:none;color:inherit;cursor:pointer;max-width:100%;
}
.evw-tagButton:disabled{cursor:default;opacity:.85}
.evw-tagRelation{font-size:10px;color:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9))}
.evw-tagName{overflow-wrap:anywhere;text-align:left}
.evw-flow{display:flex;flex-direction:column;gap:8px;font-size:12px;min-width:0}
.evw-flowTitle{margin:0;font-size:14px}
.evw-flowEmpty{margin:0;color:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9));font-size:12px}
/* The conceptual-level caveat is a WARNING, not a caption: it must be the first
   thing read, because everything below it is unverified. */
.evw-flowConceptual{
  margin:0;padding:5px 8px;border-radius:6px;font-size:11px;
  border:1px solid var(--dsw-alias-border-warning,rgba(184,134,11,.5));
  background:var(--dsw-alias-bg-warning-subtle,rgba(184,134,11,.1));
}
.evw-flowScroll{overflow:auto;max-width:100%}
.evw-flowSvg{max-width:100%;height:auto}
.evw-flowNodeBox{fill:none;stroke:currentColor;stroke-width:1.2;opacity:.85}
.evw-flowNodeBox[data-kind="module"]{stroke-width:2}
.evw-flowNodeBox[data-kind="loss"],.evw-flowNodeBox[data-kind="training_control"],.evw-flowNodeBox[data-kind="label"]{stroke-dasharray:4 3}
.evw-flowNodeBox[data-selected="true"]{stroke-width:2.6;opacity:1}
.evw-flowNodeLabel{font-size:11px;fill:currentColor}
.evw-flowNodeKind{font-size:9px;fill:currentColor;opacity:.7}
.evw-flowNodeSlot{font-size:8px;fill:currentColor;opacity:.55}
.evw-flowEdgeLabel{font-size:9px;fill:currentColor;opacity:.75}
.evw-flowLegend{list-style:none;margin:0;padding:0;display:flex;gap:12px;flex-wrap:wrap;font-size:10px;color:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9))}
.evw-flowLegendItem{display:inline-flex;align-items:center;gap:4px}
.evw-flowUnresolved{margin:0;padding-left:16px;font-size:11px;color:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9))}

/* The v3 panel sits ABOVE the three workspaces when the task is a product task.
   On a narrow viewport it stacks: the rationale and the graph are read
   top-to-bottom rather than squeezed side by side. */
.evw-researchPanel{display:flex;flex-direction:column;gap:10px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.2));min-width:0}
.evw-researchHead{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.evw-researchTitle{margin:0;font-size:13px}
.evw-researchPicker{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-text-tertiary,rgba(128,128,128,.9))}
.evw-researchBanner{
  margin:0;padding:5px 8px;border-radius:6px;font-size:11px;
  border:1px solid var(--dsw-alias-border-warning,rgba(184,134,11,.5));
  background:var(--dsw-alias-bg-warning-subtle,rgba(184,134,11,.1));
}
.evw-researchColumns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:16px;align-items:start}
@media (max-width:1100px){.evw-researchColumns{grid-template-columns:minmax(0,1fr)}}
`;

let injected = false;

/** Idempotently inject the stylesheet; safe to call on every factory run (HMR re-registers). */
export function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return;
  if (document.querySelector('style[data-plugin-css="dsh-evolver-ui"]') !== null) {
    injected = true;
    return;
  }
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-evolver-ui';
  tag.dataset.pluginCss = 'dsh-evolver-ui';
  tag.textContent = CSS;
  document.head.appendChild(tag);
  injected = true;
}

/** Class-name map (static, prefixed). */
export const s = {
  page: 'evw-page',
  topRow: 'evw-topRow',
  select: 'evw-select',
  input: 'evw-input',
  meta: 'evw-meta',
  issues: 'evw-issues',
  navRow: 'evw-navRow',
  navTab: 'evw-navTab',
  navTabActive: 'evw-navTabActive',
  section: 'evw-section',
  body: 'evw-body',
  main: 'evw-main',
  drawer: 'evw-drawer',
  drawerHead: 'evw-drawerHead',
  drawerBody: 'evw-drawerBody',
  drawerTitle: 'evw-drawerTitle',
  drawerSection: 'evw-drawerSection',
  drawerHeading: 'evw-drawerHeading',
  closeBtn: 'evw-closeBtn',
  summaryBox: 'evw-summaryBox',
  summaryHead: 'evw-summaryHead',
  canvasScroll: 'evw-canvasScroll',
  canvas: 'evw-canvas',
  node: 'evw-node',
  nodeBox: 'evw-nodeBox',
  nodeName: 'evw-nodeName',
  nodeKind: 'evw-nodeKind',
  nodeMetric: 'evw-nodeMetric',
  nodeUnit: 'evw-nodeUnit',
  nodeDelta: 'evw-nodeDelta',
  nodeCoverage: 'evw-nodeCoverage',
  nodeSelected: 'evw-nodeSelected',
  nodeBaseline: 'evw-nodeBaseline',
  nodeFlow: 'evw-nodeFlow',
  edge: 'evw-edge',
  edgeActive: 'evw-edgeActive',
  edgeLabel: 'evw-edgeLabel',
  legend: 'evw-legend',
  legendItem: 'evw-legendItem',
  legendSvg: 'evw-legendSvg',
  toneGood: 'evw-toneGood',
  toneWarn: 'evw-toneWarn',
  toneBad: 'evw-toneBad',
  toneFlat: 'evw-toneFlat',
  toneNone: 'evw-toneNone',
  toolbar: 'evw-toolbar',
  chipRow: 'evw-chipRow',
  chipList: 'evw-chipList',
  chip: 'evw-chip',
  chipActive: 'evw-chipActive',
  list: 'evw-list',
  row: 'evw-row',
  rowSelected: 'evw-rowSelected',
  rowHead: 'evw-rowHead',
  rowLine: 'evw-rowLine',
  rowActions: 'evw-rowActions',
  linkBtn: 'evw-linkBtn',
  table: 'evw-table',
  kv: 'evw-kv',
  badge: 'evw-badge',
  badgeManual: 'evw-badgeManual',
  badgeReady: 'evw-badgeReady',
  opRow: 'evw-opRow',
  opStatus: 'evw-opStatus',
  opError: 'evw-opError',
  dim: 'evw-dim',
  errorBox: 'evw-errorBox',
  empty: 'evw-empty',
  // v3: the composition rationale panel and the model data flow.
  rationale: 'evw-rationale',
  rationaleTitle: 'evw-rationaleTitle',
  rationaleMeta: 'evw-rationaleMeta',
  rationaleSection: 'evw-rationaleSection',
  rationaleHeading: 'evw-rationaleHeading',
  rationaleEmpty: 'evw-rationaleEmpty',
  rationaleUnknown: 'evw-rationaleUnknown',
  rationaleUnresolvedList: 'evw-rationaleUnresolvedList',
  claim: 'evw-claim',
  claimUnknown: 'evw-claimUnknown',
  claimStatus: 'evw-claimStatus',
  tagList: 'evw-tagList',
  tagRow: 'evw-tagRow',
  tagButton: 'evw-tagButton',
  tagRelation: 'evw-tagRelation',
  tagName: 'evw-tagName',
  flow: 'evw-flow',
  flowTitle: 'evw-flowTitle',
  flowEmpty: 'evw-flowEmpty',
  flowConceptual: 'evw-flowConceptual',
  flowScroll: 'evw-flowScroll',
  flowSvg: 'evw-flowSvg',
  flowEdges: 'evw-flowEdges',
  flowNodes: 'evw-flowNodes',
  flowNode: 'evw-flowNode',
  flowNodeBox: 'evw-flowNodeBox',
  flowNodeLabel: 'evw-flowNodeLabel',
  flowNodeKind: 'evw-flowNodeKind',
  flowNodeSlot: 'evw-flowNodeSlot',
  flowEdgeLabel: 'evw-flowEdgeLabel',
  flowLegend: 'evw-flowLegend',
  flowLegendItem: 'evw-flowLegendItem',
  flowUnresolved: 'evw-flowUnresolved',
  // The v3 adapter panel that combines the rationale and the data flow.
  researchPanel: 'evw-researchPanel',
  researchHead: 'evw-researchHead',
  researchTitle: 'evw-researchTitle',
  researchPicker: 'evw-researchPicker',
  researchBanner: 'evw-researchBanner',
  researchColumns: 'evw-researchColumns',
};