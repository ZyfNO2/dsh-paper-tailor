import { WIKI_WORKSPACE_CSS } from './wiki-styles.ts';
/**
 * DSH Research Studio UI 重构（2026-10-15 批次 U1 外壳层）。
 *
 * 样式基准：work/ui-reference-20261015/source/DSH_Research_Studio_Integrated/
 * 的 index.html（外壳与概览）与 modules/*.html（组件语言）。逐条对照源码还原；
 * 宿主适配（媒体查询→容器查询、100dvh→100%、fixed 抽屉→absolute）逐项记录在
 * docs/mvp/UI-REFACTOR-U0-BASELINE-2026-10-15.md §5。
 *
 * 分层：
 *  - GENERAL_SHELL_CSS   新外壳 + 概览 + 共享组件语言（U1 起生效）
 *  - GENERAL_LEGACY_CSS  旧面板样式（资料/指标/报告/推断/流程画布等过渡期保持可用；
 *                        对应批次重建后移除）
 * 旧 CSS 中的侧栏/品牌/页头规则已被外壳层替换，不再保留。
 */

export const GENERAL_SHELL_CSS = `
.gw{--bg:#f5f7f5;--paper:#fff;--ink:#172522;--sub:#657570;--line:#dfe6e1;--deep:#123e40;--green:#176169;--mint:#e5f1ed;--nav:#eef3f0;--blue:#275bd8;--blue-soft:#edf3ff;--amber:#94620d;--red:#b43e40;color:var(--ink);background:var(--bg);font-family:Inter,"Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-size:14px;line-height:1.6;display:grid;grid-template-columns:250px minmax(0,1fr);height:100%;min-height:0;overflow:hidden;position:relative}
.gw *,.gw *::before,.gw *::after{box-sizing:border-box}
.gw button,.gw a{font:inherit}
.gw button{cursor:pointer;color:inherit;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:34px;padding:0 14px;border:1px solid #C3CCC9;border-radius:9px;background:#fff;font-weight:600;font-size:13px;line-height:1.4}
.gw button:disabled{opacity:.45;cursor:not-allowed}
.gw button:hover:not(:disabled){background:#E9EDEB}
.gw a{color:inherit;text-decoration:none}
.gw button:focus-visible,.gw a:focus-visible{outline:2px solid #27767c;outline-offset:3px}
.gw h1,.gw h2,.gw h3,.gw p{margin:0}
.gw input,.gw select,.gw textarea{font:inherit;color:var(--ink)}
.gw .mono{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace}
.gw .tinyprint{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.03em}
.gw .hint{font-size:11px;letter-spacing:.09em;color:#70827b;text-transform:uppercase}
.gw .small{font-size:12px}.gw .muted{color:var(--sub)}
.gw .flex{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.gw .between{justify-content:space-between}
.gw .stack{display:grid;gap:16px;min-width:0}.gw .stack>*{min-width:0}
/* ===== 侧栏（参考 index.html .sidebar/.brand/.project/.menus/.sbfoot） ===== */
.gw .sidebar{background:#eef2ef;border-right:1px solid #d8e1dc;display:flex;flex-direction:column;min-height:0}
.gw .brand{padding:25px 24px 24px;display:flex;align-items:center;gap:11px}
.gw .brandmark{display:grid;place-items:center;width:35px;height:35px;border-radius:10px;color:#fff;background:#144f54;font:700 15px Georgia,serif}
.gw .brand b{font:700 17px Georgia,"Noto Serif SC",serif;display:block;letter-spacing:-.4px}
.gw .brand>div>span{display:block;font:500 10px ui-monospace,monospace;letter-spacing:1.1px;color:#667873;margin-top:3px}
.gw .project{margin:0 14px 17px;padding:15px 14px;background:#fff;border:1px solid #d9e3dd;border-radius:12px}
.gw .project-title{display:flex;align-items:center;justify-content:space-between;gap:9px;margin:7px 0 4px;font-weight:650;font-size:13px}
.gw .project-title select{appearance:none;-webkit-appearance:none;border:0;background:none;padding:0;font:inherit;font-weight:650;font-size:13px;color:var(--ink);max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.gw .dot{display:inline-block;height:7px;width:7px;border-radius:50%;background:#469f77;flex-shrink:0}
.gw .dot.dim{background:#b3c2bb}
.gw .project-sub{font-size:11px;color:#738079}
.gw .project .textbtn{display:inline-block;margin-top:8px;border:0;background:none;color:var(--green);font-weight:600;font-size:12px;padding:0}
.gw .menus{flex:1;overflow:auto;padding:0 12px 16px}
.gw .group-title{padding:15px 13px 9px;color:#829089;font-weight:650;letter-spacing:.12em;font-size:10px}
.gw .nav{width:100%;display:flex;align-items:center;gap:12px;text-align:left;padding:11px 13px;border:1px solid transparent;border-radius:10px;background:none;color:#556761;min-height:44px;font-weight:550;font-size:13px}
.gw .nav:hover{background:#e3ebe6;color:var(--ink)}
.gw .nav.active{background:#fff;border-color:#d6e2db;color:#104e52;box-shadow:0 2px 10px #203d2a0a;font-weight:700}
.gw .ico{width:18px;height:18px;display:grid;place-items:center;font:600 16px system-ui;color:#7d8e88;flex-shrink:0}
.gw .nav.active .ico{color:var(--green)}
.gw .nav .micro{margin-left:auto;color:#8ca19a;font-size:10px}
.gw .sbfoot{padding:16px 20px;border-top:1px solid #d8e1dc;font-size:11px;color:#74847d}
.gw .sbfoot strong{display:block;margin-bottom:5px;color:#586e65;font-size:12px}
.gw .sbfoot .sync{display:flex;align-items:center;gap:7px;margin-top:8px}
.gw .sbfoot .sync button{border:0;background:none;color:var(--green);font-weight:600;font-size:11px;padding:0;text-decoration:underline;text-underline-offset:2px}
/* ===== 主区与页头（参考 .workspace/.topbar/.crumbs/.top-actions） ===== */
.gw .workspace{min-width:0;display:flex;flex-direction:column;height:100%;background:var(--bg)}
.gw .topbar{height:68px;flex:0 0 68px;display:flex;align-items:center;justify-content:space-between;gap:14px;background:#fff;border-bottom:1px solid var(--line);padding:0 30px}
.gw .crumbs{display:flex;align-items:center;gap:10px;min-width:0;color:#7c8a84;font-size:12px}
.gw .crumbs strong{font-size:13px;color:#253a34;font-weight:650;white-space:nowrap}
.gw .top-actions{display:flex;align-items:center;gap:14px}
.gw .demo{border:1px solid #dce6e0;border-radius:20px;padding:5px 11px;background:#f8faf9;color:#61746d;font-size:11px;white-space:nowrap}
.gw .demo.warn{border-color:#e7d2ae;background:#fcf6eb;color:#8f652b}
.gw .outline{border:1px solid #cedbd5;background:#fff;color:#33524a;border-radius:9px;min-height:34px;padding:0 12px;font-weight:650;font-size:12px}
.gw .outline:hover{background:#f3f7f5}
.gw .view{position:relative;flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column}
.gw .statusline{flex:0 0 auto;padding:10px 30px 0}
.gw .statusline .error{margin-top:8px}
.gw .viewbody{flex:1;min-height:0;position:relative}
/* ===== 概览（参考 .home/.hero/.tiles/.tile/.bottom-note） ===== */
.gw .home{display:none;overflow-y:auto;height:100%;padding:38px max(36px,calc((100% - 1140px)/2))}
.gw .home.active{display:block}
.gw .home h1{font:700 clamp(29px,3vw,39px) Georgia,"Noto Serif SC",serif;letter-spacing:-.7px;margin:12px 0}
.gw .home>p{color:#62736d;line-height:1.7;max-width:680px}
.gw .hero{display:flex;justify-content:space-between;gap:20px;padding:28px 32px 30px;color:#eef5f2;background:#123d40;border-radius:18px;margin-bottom:24px}
.gw .hero h2{font:700 25px Georgia,"Noto Serif SC",serif;line-height:1.45;margin:6px 0 10px}
.gw .hero p{color:#c5d9d2;line-height:1.7;max-width:640px;margin:0}
.gw .hero .primary{flex-shrink:0;align-self:flex-end;background:#fff;color:#16474a;border:0;border-radius:9px;padding:12px 16px;font-weight:700}
.gw .tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:20px}
.gw .tile{display:block;text-align:left;background:#fff;border:1px solid #dae4de;border-radius:15px;padding:22px 24px;min-height:166px;transition:border-color .2s,transform .2s;font-size:14px;color:var(--ink)}
.gw .tile:hover{border-color:#6b9a8a;transform:translateY(-2px)}
.gw .tile-icon{width:34px;height:34px;display:grid;place-items:center;background:#e6f1ed;border-radius:9px;font-size:18px;color:#22646b}
.gw .tile strong{display:block;font-size:17px;margin:14px 0 5px}
.gw .tile p{font-size:12px;margin:0}
.gw .tile small{display:block;margin-top:14px;color:var(--green);font-weight:700}
.gw .bottom-note{margin-top:20px;padding:18px 20px;border:1px solid #dee7e1;border-radius:12px;color:#60736b;background:#fff;font-size:12px;line-height:1.8}
/* 概览的真实数据区沿用参考卡片语言 */
.gw .home .card{background:#fff;border:1px solid #dae4de;border-radius:15px}
.gw .home .card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 22px;border-bottom:1px solid #e4ece7;flex-wrap:wrap}
.gw .home .card-head h2{font:700 17px Georgia,"Noto Serif SC",serif}
.gw .home .card-body{padding:18px 22px}
.gw .home-grid{display:grid;grid-template-columns:1.4fr 1fr;gap:16px;margin-top:20px}
.gw .home-grid .home-grid,.gw .home .tiles+.home-grid{margin-top:20px}
/* ===== 模块页容器（过渡期 + 各模块通用；模块底色按原稿） ===== */
.gw .page{position:absolute;inset:0;overflow-y:auto;background:#F2F4F3;color:#14211F;font-size:15px;line-height:1.6;padding:34px max(32px,calc((100% - 1160px)/2)) 56px}
.gw .page[hidden]{display:none;pointer-events:none}
.gw .page.shell-toned{background:var(--bg)}
.gw [data-legacy-research] .rc-head{flex-wrap:wrap}
.gw [data-legacy-research] .rc-title{flex:1 1 260px;min-width:220px}
.gw [data-legacy-research] .rc-head select{width:auto;max-width:100%;flex:0 1 300px}
.gw [data-legacy-research] .rc-btn{flex-shrink:0}
.gw [data-legacy-research] .rc-primary{background:var(--rd-blue);color:var(--rd-onAccent)}
.gw .page h1{font:700 30px/1.25 "Noto Serif SC","Songti SC",serif;letter-spacing:-.3px}
.gw .page .page-sub{color:#2E3B38}
.gw .page .page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:26px;flex-wrap:wrap}
.gw .page .page-head p{margin-top:8px;font-size:12px;color:var(--sub)}
/* ===== 共享组件语言（参考 modules/start.html 等，U2–U4 复用） ===== */
.gw .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 20px;border-radius:10px;border:1px solid transparent;font-weight:600;font-size:15px;line-height:1.2;text-decoration:none;cursor:pointer;transition:background .15s,border-color .15s}
.gw .btn-primary{background:#14575C;color:#fff}
.gw .btn-primary:hover{background:#0E4246}
.gw .btn-light{background:#F2F4F3;color:#10393C}
.gw .btn-light:hover{background:#fff}
.gw .btn-ghost{background:#fff;border-color:#C3CCC9;color:#14211F}
.gw .btn-ghost:hover{background:#E9EDEB}
.gw .btn-ghost[aria-pressed="true"]{background:#14575C;border-color:#14575C;color:#fff}
.gw .btn[disabled]{opacity:.45;cursor:not-allowed}
.gw .btn-text{display:inline-flex;align-items:center;min-height:44px;padding:0 6px;background:none;border:0;color:#14575C;font-weight:600;text-decoration:underline;text-underline-offset:3px}
.gw .chip{display:inline-flex;align-items:center;gap:6px;min-height:24px;padding:0 10px;border-radius:999px;font-size:12.5px;font-weight:500;border:1px solid;white-space:nowrap}
.gw .chip-done{background:#E1EFEE;color:#0F4A4F;border-color:#B7D7D5}
.gw .chip-ink{background:#14211F;color:#fff;border-color:#14211F}
.gw .chip-ready{background:#fff;color:#14575C;border-color:#14575C}
.gw .chip-block{background:#E9ECEB;color:#4A5753;border-color:#D3DAD7}
.gw .chip-warn{background:#FBEFD9;color:#7A4100;border-color:#EBCB97}
.gw .chip-danger{background:#FBE7E3;color:#8E2A1E;border-color:#EFB9B1}
.gw .card{background:#fff;border:1px solid #DDE3E0;border-radius:16px}
.gw .field{width:100%;border:1px solid #AAB6B2;border-radius:12px;background:#fff;padding:12px 14px;line-height:1.6;font-size:16px}
.gw .chk{display:flex;align-items:flex-start;gap:12px;min-height:44px;padding:12px 14px;border:1px solid #C3CCC9;border-radius:12px;background:#fff;cursor:pointer;text-align:left;font-size:inherit}
.gw .chk input{width:20px;height:20px;margin:2px 0 0;accent-color:#14575C;flex:0 0 20px}
.gw .chk input:disabled{cursor:not-allowed}
.gw .seg{min-width:44px;min-height:40px;padding:0 14px;border:0;border-radius:9px;background:transparent;color:#46534F;font-weight:500;font-size:inherit}
.gw .seg:hover{background:#E9EDEB}
.gw .seg[aria-pressed="true"]{background:#14211F;color:#fff}
.gw .tab{min-height:44px;padding:0 4px;margin-right:18px;border:0;border-bottom:3px solid transparent;background:none;color:#566460;font-weight:500;font-size:inherit}
.gw .tab[aria-selected="true"]{color:#14211F;border-bottom-color:#14575C;font-weight:600}
.gw .vs{position:relative;display:flex;align-items:flex-start;gap:14px;padding-bottom:22px}
.gw .vs:not(:last-child)::after{content:"";position:absolute;left:15px;top:34px;bottom:2px;width:2px;background:#C9D2CF}
.gw .vs[data-s="done"]:not(:last-child)::after{background:#14575C}
.gw .vs .dot{position:relative;z-index:1;flex:0 0 32px;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-weight:600;font-size:14px;border:2px solid #AAB6B2;color:#46534F;background:#fff}
.gw .vs[data-s="done"] .dot{background:#14575C;border-color:#14575C;color:#fff}
.gw .vs[data-s="current"] .dot{border-color:#14575C;color:#14575C;box-shadow:0 0 0 5px #D2E6E4}
.gw .vs b{display:block;font-weight:600;padding-top:3px}
.gw .vs[data-s="current"] b{color:#14575C}
.gw .vs[data-s="todo"] b{color:#566460;font-weight:500}
.gw .vs small{display:block;font-size:12.5px;line-height:1.4;color:#566460}
.gw dd[data-dim="true"]{color:#566460}
.gw .fade{animation:gwfade .18s ease-out}
@keyframes gwfade{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
/* ===== 实验树节点卡（参考 modules/tree.html；位置来自真实布局） ===== */
.gw .tnode{position:absolute;width:216px;min-height:104px;display:flex;flex-direction:column;justify-content:space-between;gap:2px;padding:9px 11px;border-radius:12px;border:1.5px solid #AAB6B2;background:#fff;text-align:left;line-height:1.3;overflow:hidden;font-size:14px;color:#14211F}
.gw .tnode:hover{box-shadow:0 6px 16px #14211f29}
.gw .tnode .tp{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11.5px;color:#566460;font-weight:500}
.gw .tnode b{font-size:13px;font-weight:600}
.gw .tnode .m{display:flex;align-items:baseline;gap:8px;font-size:12.5px;min-height:18px}
.gw .tnode .m2{font-size:12px;color:#566460;text-align:left}
.gw .tnode .dl{font-weight:600}
.gw .tnode .dl[data-d="pos"]{color:#0F4A4F}
.gw .tnode .dl[data-d="neg"]{color:#8E2A1E}
.gw .tnode .dl[data-d="zero"]{color:#46534F}
.gw .tk{font-size:11px;font-weight:600;padding:0 6px;border-radius:99px;background:#14575C;color:#fff;line-height:18px}
.gw .tnode[data-st="base"]{border-color:#14211F;border-width:2px}
.gw .tnode[data-st="below"]{border-color:#9FB4AF}
.gw .tnode[data-st="worse"]{background:#FBE7E3;border-color:#E3A9A1}
.gw .tnode[data-st="repro"]{background:#FBEFD9;border-color:#C98A2B}
.gw .tnode[data-st="running"]{border-color:#14575C;background:#fff}
.gw .tnode[data-st="pending"]{border-style:dashed;background:#F8F9F8;border-color:#8FA29D}
.gw .tnode[data-st="queued"]{border-style:dashed;background:#FBEFD9;border-color:#C98A2B}
.gw .tnode[data-best="true"]{box-shadow:0 0 0 4px #D2E6E4}
.gw .tnode[data-sel="true"]{outline:2.5px solid #14211F;outline-offset:3px}
.gw .ck{flex:0 0 22px;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;border:2px solid #AAB6B2;color:#fff;font-size:12px;font-weight:700}
.gw .ck[data-k="ok"]{background:#14575C;border-color:#14575C}
.gw .ck[data-k="no"]{background:#8E2A1E;border-color:#8E2A1E}
.gw .ck[data-k="na"]{color:#566460}
.gw .stat{display:flex;flex-direction:column;gap:2px;padding:12px 14px;background:#F2F4F3;border-radius:12px}
.gw .stat small{font-size:12.5px;color:#566460}
.gw .stat strong{font-family:"Noto Serif SC","Songti SC",serif;font-size:24px;line-height:1.25;font-weight:700}
.gw .diffrow{display:flex;gap:10px;padding:8px 0;border-top:1px solid #E4E9E7;font-size:14px}
.gw .diffrow .sg{flex:0 0 14px;font-family:"IBM Plex Mono",monospace;font-weight:500}
/* ===== 页内二级导航（配套入口；样式取参考 left-tabs 语言） ===== */
.gw .subnav{display:flex;align-items:center;gap:20px;padding:0 2px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.gw .subnav button{border:0;border-bottom:2px solid transparent;background:none;height:40px;color:#7a8881;font-weight:600;font-size:12px;padding:0 2px}
.gw .subnav button.active{color:#174c4e;border-bottom-color:#1d676a}
.gw .subnav button:hover{color:#174c4e}
/* ===== 抽屉与遮罩（参考 .shade/.menu-open；宿主内用 absolute） ===== */
.gw .shade{display:none}
.gw .mobile-trigger{display:none;border:0;background:none;font-size:19px;cursor:pointer;color:#264a42}
@container dsh-workbench (max-width:900px){
  .gw{grid-template-columns:210px minmax(0,1fr)}
  .gw .brand{padding-left:16px}
  .gw .project{margin:0 9px 10px}
  .gw .topbar{padding:0 18px}
  .gw .home{padding:24px}
  .gw .hero{flex-direction:column}
  .gw .hero .primary{align-self:flex-start}
  .gw .tiles{grid-template-columns:1fr 1fr}
  .gw .page{padding:26px 22px 46px}
  .gw .home-grid{grid-template-columns:1fr}
}
@container dsh-workbench (max-width:680px){
  .gw{grid-template-columns:minmax(0,1fr)}
  .gw .sidebar{position:absolute;z-index:20;inset:0 auto 0 0;width:270px;transform:translateX(-100%);transition:transform .22s;box-shadow:6px 0 24px #10281c16}
  .gw.menu-open .sidebar{transform:none}
  .gw.menu-open .shade{display:block;position:absolute;inset:0;z-index:19;background:#10231b66}
  .gw .mobile-trigger{display:block}
  .gw .topbar{height:60px;flex-basis:60px;padding:0 14px}
  .gw .crumbs{gap:6px}
  .gw .top-actions{gap:8px}
  .gw .top-actions .outline{display:none}
  .gw .home{padding:18px 14px}
  .gw .tiles{grid-template-columns:1fr}
  .gw .hero{padding:22px}
  .gw .hero h2{font-size:22px}
  .gw .demo{font-size:10px}
  .gw .page{padding:20px 14px 40px}
}
@media (prefers-reduced-motion:reduce){
  .gw .tile,.gw .sidebar{transition:none}
  .gw .fade{animation:none}
  .gw .btn{transition:none}
}
`;

/** 旧面板样式：配套页（资料/指标/报告/推断/流程画布/弹窗）在各自批次重建前保持可用。 */
export const GENERAL_LEGACY_CSS = `
.gw .panel{background:#fff;border:1px solid #dfe6e1;border-radius:12px;box-shadow:0 5px 18px #203d2a0a;min-width:0}
.gw .panel-head{padding:18px 20px;border-bottom:1px solid #dfe6e1;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.gw .panel-body{padding:20px}
.gw .panel-body p{overflow-wrap:anywhere}
.gw .notice{display:flex;gap:12px;padding:16px 20px;margin-bottom:22px;background:#e5f1ed;border:1px solid #cfe4dc;border-radius:10px}
.gw .error{color:var(--red);background:#fff1f1;padding:12px;border:1px solid #efd4d4;border-radius:8px;overflow-wrap:anywhere}
.gw .metrics{display:grid;grid-template-columns:repeat(4,1fr);background:#fff;border:1px solid #dfe6e1;border-radius:12px;margin-bottom:24px}
.gw .metric{padding:18px;border-right:1px solid #dfe6e1}
.gw .metric:last-child{border:0}
.gw .number{font-size:28px;font-weight:650}
.gw .field-grid>*{min-width:0}
.gw .field-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
.gw .path-row{padding:15px 0;display:flex;gap:14px;border-bottom:1px solid #dfe6e1}
.gw .step-dot{width:28px;height:28px;border:1px solid #dfe6e1;border-radius:50%;display:grid;place-items:center;flex-shrink:0}
.gw .empty{padding:28px;text-align:center;color:var(--sub)}
.gw pre{white-space:pre-wrap;overflow-wrap:anywhere}
.gw label{display:block;margin:12px 0 5px;font-size:12px;font-weight:600}
.gw button.link{padding:3px 0;border:0;background:none;color:#14575C;font-size:inherit}
.gw button.link:hover{text-decoration:underline}
.gw input,.gw select,.gw textarea{width:100%;min-width:0;border:1px solid #AAB6B2;background:#fff;border-radius:9px;padding:9px 11px;color:var(--ink)}
.gw textarea{resize:vertical;min-height:76px}
.gw table{border-collapse:collapse;width:100%;font-size:12px}
.gw th,.gw td{text-align:left;padding:10px;border-bottom:1px solid #dfe6e1;vertical-align:top;max-width:300px;overflow-wrap:anywhere}
.gw th{background:#f2f5f3}
.gw td input,.gw td select{min-width:100px;padding:6px}
.gw dialog::backdrop{background:#10231b66}
.gw .modal{background:#fff;border:1px solid #dfe6e1;border-radius:14px;width:min(620px,100%);max-height:85vh;overflow:auto;padding:24px}
.gw .modal footer{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.gw .flow-layout{display:grid;grid-template-columns:minmax(0,1fr) 326px;border:1px solid #dfe6e1;border-radius:12px;background:#fff;overflow:hidden;min-height:600px}
.gw .flow-main{min-width:0}
.gw .flow-toolbar{padding:13px 16px;border-bottom:1px solid #dfe6e1;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.gw .canvas{height:600px;position:relative;overflow:auto;background-color:#fbfcfb;background-image:radial-gradient(#d9e2dd 1px,transparent 1px);background-size:20px 20px}
.gw .world{position:relative;transform-origin:0 0}
.gw .edges{position:absolute;inset:0;pointer-events:none}
.gw .node{position:absolute;width:216px;min-height:111px;text-align:left;background:#fff;border:1px solid #b8c9c1;border-radius:9px;box-shadow:0 3px 8px #203d2a09;padding:12px;user-select:none;touch-action:none}
.gw .node.selected{border:2px solid #14575C;box-shadow:0 0 0 4px #14575c14}
.gw .node-title{font-weight:650;margin:8px 0}
.gw .inspector{border-left:1px solid #dfe6e1;padding:20px;overflow-wrap:anywhere}
.gw .inspector dl{display:grid;gap:12px}
.gw .inspector dt{font-size:11px;color:var(--sub)}
.gw .inspector dd{margin:0}
.gw .segmented{display:flex;gap:3px;background:#e9edeb;border-radius:7px;padding:3px}
.gw .segmented button{padding:6px 11px;border:0;background:transparent;border-radius:6px}
.gw .segmented button.active{background:#fff;box-shadow:0 1px 4px #203d2a1a}
.gw .mobile-menu{display:none}
@container dsh-workbench (max-width:960px){
  .gw .metrics{grid-template-columns:repeat(2,1fr)}
  .gw .flow-layout{grid-template-columns:1fr}
  .gw .inspector{border-left:0;border-top:1px solid #dfe6e1}
  .gw .field-grid{grid-template-columns:1fr}
}
@container dsh-workbench (max-width:650px){
  .gw .modal{padding:18px}
  .gw .canvas{height:440px}
}
/* ===== U5 Wiki 三栏（基准 work/ui-reference-20261015/extracted/wiki.style.css；媒体查询→容器查询适配宿主） ===== */
.gw .wiki{display:flex;flex-direction:column;min-height:0;height:100%;background:#f7f9f8;color:#182a27;font-size:13px;line-height:1.5}
.gw .wiki .banner{height:65px;flex:0 0 65px;display:flex;justify-content:space-between;gap:12px;align-items:center;padding:0 24px;background:#fff;border-bottom:1px solid #dfe6e2}
.gw .wiki .banner h1{font:700 19px Georgia,"Noto Serif SC",serif;margin:0;letter-spacing:-.35px}
.gw .wiki .banner h1 span{font-size:12px;color:#8da29a;font-family:system-ui;font-weight:400}
.gw .wiki .banner p{margin:1px 0 0;color:#7a8982;font-size:11px}
.gw .wiki .banner-right{display:flex;align-items:center;gap:8px}
.gw .wiki .chip{padding:4px 9px;border:1px solid #dce6e0;border-radius:7px;color:#61746d;background:#f8faf9;font-size:11px;white-space:nowrap}
.gw .wiki .action{border:1px solid #d6e0da;border-radius:8px;background:#fff;color:#405d53;font-weight:600;padding:8px 12px;white-space:nowrap;font-size:12px;min-height:34px}
.gw .wiki .action:hover{background:#f2f7f3}
.gw .wiki .action.primary{background:#1b5e62;color:#fff;border-color:#1b5e62}
.gw .wiki .action.primary:hover{background:#144d51}
.gw .wiki .workspace{display:grid;grid-template-columns:235px minmax(0,1fr) 330px;flex:1;min-height:0}
.gw .wiki .left{border-right:1px solid #dfe6e2;background:#fff;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.gw .wiki .left-tabs{display:flex;align-items:center;gap:20px;padding:0 18px;height:54px;min-height:54px;border-bottom:1px solid #dfe6e2}
.gw .wiki .left-tabs button{border:0;border-bottom:2px solid transparent;background:none;height:54px;color:#7a8881;font-weight:600;font-size:12px;padding:0 2px}
.gw .wiki .left-tabs button.active{color:#174c4e;border-bottom-color:#1d676a}
.gw .wiki .filterbar{padding:14px 15px 12px;border-bottom:1px solid #eef2ef}
.gw .wiki .search{position:relative}
.gw .wiki .search input{width:100%;padding:10px 32px 10px 33px;border:1px solid #dae4de;border-radius:8px;background:#f7f9f8;min-height:39px;outline:none}
.gw .wiki .search input:focus{border-color:#3a8484;box-shadow:0 0 0 3px #dceee9}
.gw .wiki .search span{position:absolute;left:11px;top:11px;color:#899991}
.gw .wiki .result{margin:6px 0;color:#7f9187;font-size:11px}
.gw .wiki .left-scroll{overflow:auto;flex:1;min-height:0;padding:12px 10px 18px}
.gw .wiki .row-entry{width:100%;display:flex;align-items:center;gap:8px;text-align:left;background:transparent;border:1px solid transparent;border-radius:7px;color:#51645c;padding:7px 10px;min-height:34px;font-size:12px}
.gw .wiki .row-entry:hover{background:#f1f6f3}
.gw .wiki .row-entry.active{color:#13595d;background:#eaf4f0;border-color:#d3e9df;font-weight:700}
.gw .wiki .row-entry .label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.gw .wiki .type-dot{width:8px;height:8px;border-radius:50%;flex:0 0 8px}
.gw .wiki .fileicon{color:#a2b0ab;font-size:14px}
.gw .wiki .footinfo{padding:12px 15px;color:#91a097;border-top:1px solid #dfe6e2;font-size:11px}
.gw .wiki .graph-col{display:flex;flex-direction:column;min-width:0;min-height:0;position:relative;background:#fbfcfb}
.gw .wiki .graph-top{height:54px;display:flex;gap:12px;align-items:center;justify-content:space-between;padding:0 19px;background:#fff;border-bottom:1px solid #dfe6e2}
.gw .wiki .graph-title{display:flex;gap:9px;align-items:center;white-space:nowrap;min-width:0}
.gw .wiki .graph-title strong{font-weight:700;font-size:13px}
.gw .wiki .graph-title small{font:11px ui-monospace,monospace;color:#87958e;white-space:nowrap}
.gw .wiki .tabs{display:flex;gap:3px;align-items:center}
.gw .wiki .tabs button{border:0;border-radius:6px;background:none;color:#778880;padding:7px 10px;font-size:12px;white-space:nowrap}
.gw .wiki .tabs button.active{background:#e7f2ed;color:#165d60;font-weight:700}
.gw .wiki .tabs button:hover{background:#edf4f0}
.gw .wiki .graph-area{flex:1;min-height:400px;position:relative;overflow:hidden;background:radial-gradient(circle at 49% 42%,#fff 0,#fbfdfc 50%,#f4f8f6 100%)}
.gw .wiki .graph-area svg{width:100%;height:100%;display:block;touch-action:none;cursor:grab}
.gw .wiki .edge{stroke:#b0c7c2;stroke-width:1.15;stroke-opacity:.36;pointer-events:none}
.gw .wiki .edge.dim{stroke-opacity:.055}
.gw .wiki .edge.highlight{stroke:#34797c;stroke-opacity:.7;stroke-width:2.2}
.gw .wiki .gnode circle{stroke:#fff;stroke-width:2.2;cursor:pointer;filter:drop-shadow(0 2px 2px #244c3c17)}
.gw .wiki .gnode text{font:11px Inter,"Noto Sans SC",system-ui,sans-serif;paint-order:stroke;stroke:#fff;stroke-width:3px;stroke-linejoin:round;fill:#3a514a;pointer-events:none}
.gw .wiki .gnode.dim{opacity:.12}
.gw .wiki .gnode.selected circle{stroke:#124e52;stroke-width:3.2}
.gw .wiki .gnode.selected text{font-weight:750;fill:#194347}
.gw .wiki .corner{position:absolute;left:17px;bottom:19px;background:#fffffff0;border:1px solid #e1e9e4;border-radius:10px;padding:11px 13px;box-shadow:0 3px 14px #243b2e09;max-width:180px}
.gw .wiki .corner h3{font-size:10px;letter-spacing:.08em;color:#74887d;margin:0 0 8px}
.gw .wiki .legend{display:grid;grid-template-columns:1fr 1fr;gap:6px 13px}
.gw .wiki .legend span{display:flex;align-items:center;gap:6px;color:#77857f;font-size:10px;white-space:nowrap}
.gw .wiki .legend i{width:8px;height:8px;border-radius:50%;display:inline-block}
.gw .wiki .corner small{display:block;margin-top:8px;color:#8b9991;font-size:10px}
.gw .wiki .controls{position:absolute;right:16px;top:15px;display:flex;flex-direction:column;gap:7px}
.gw .wiki .controls button{height:31px;width:31px;background:#fff;border:1px solid #e1e7e3;border-radius:8px;font-size:17px;color:#506c63;box-shadow:0 2px 8px #1c39301a}
.gw .wiki .controls button:hover{background:#edf4f0}
.gw .wiki .graph-footer{height:35px;display:flex;align-items:center;justify-content:space-between;padding:0 17px;color:#8b9c91;font-size:10px;background:#fafcfb;border-top:1px solid #e8eeea;gap:12px}
.gw .wiki .graph-footer strong{color:#557267;font-weight:550}
.gw .wiki .graph-footer button{padding:4px 7px;border:0;background:none;color:#266d6e;font-size:11px}
.gw .wiki .graph-pop{position:absolute;z-index:5;top:72px;right:18px;width:min(310px,90%);border-radius:12px;background:#fff;box-shadow:0 14px 34px #1d383b22;border:1px solid #dae5de;padding:17px;max-height:70%;overflow:auto}
.gw .wiki .graph-pop h3{font-size:15px;margin:0 0 10px}
.gw .wiki .graph-pop p{font-size:12px;color:#688077;line-height:1.7}
.gw .wiki .graph-pop .statrow{display:flex;justify-content:space-between;border-bottom:1px solid #edf0ee;padding:7px 0}
.gw .wiki .graph-pop b{font-family:ui-monospace,monospace}
.gw .wiki .insightlink{display:flex;justify-content:space-between;width:100%;background:#f7f9f8;border:0;border-radius:6px;padding:6px 8px;margin-top:4px;text-align:left;font-size:12px}
.gw .wiki .right{background:#fff;border-left:1px solid #dfe6e2;display:flex;flex-direction:column;min-width:0;min-height:0}
.gw .wiki .doc-head{flex:0 0 auto;border-bottom:1px solid #e5ebe7;padding:19px 22px 15px}
.gw .wiki .doc-overline{display:flex;justify-content:space-between;align-items:center;color:#8a9b93;font:10px ui-monospace,monospace;letter-spacing:.08em}
.gw .wiki .doc-head h2{margin:13px 0 8px;font:700 19px/1.3 Georgia,"Noto Serif SC",serif;overflow-wrap:anywhere}
.gw .wiki .doc-head p{font-size:11px;line-height:1.55;color:#7f8c86;margin:0}
.gw .wiki .doc-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:12px}
.gw .wiki .doc-tags span{border:1px solid #e1e9e3;background:#f4f7f5;color:#5d756a;padding:3px 7px;border-radius:5px;font-size:10px}
.gw .wiki .right-tabs{height:44px;display:flex;padding:0 22px;border-bottom:1px solid #dfe6e2;gap:20px;flex:0 0 44px}
.gw .wiki .right-tabs button{border:0;border-bottom:2px solid transparent;background:none;color:#718078;font-weight:600;font-size:12px}
.gw .wiki .right-tabs button.active{border-color:#17676a;color:#195b5d}
.gw .wiki .doc-content{flex:1;overflow:auto;padding:19px 23px 32px;color:#41534b;font-size:12px;line-height:1.8}
.gw .wiki .doc-content h3{margin:14px 0 7px;color:#243b34;font:700 14px/1.5 Georgia,"Noto Serif SC",serif}
.gw .wiki .doc-content h3:first-child{margin-top:0}
.gw .wiki .doc-content h4{font-size:12px;margin:14px 0 5px}
.gw .wiki .doc-content p{margin:0 0 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.gw .wiki .doc-content .linked{display:flex;align-items:center;gap:8px;width:100%;background:#fff;border:1px solid #e6ece8;border-radius:7px;padding:9px;text-align:left;margin-top:6px;font-size:12px}
.gw .wiki .doc-content .linked:hover{background:#f3f7f4;border-color:#a5c8bd}
.gw .wiki .doc-content .linked small{margin-left:auto;color:#91a39a}
.gw .wiki .subnote{border-left:3px solid #d4e4dc;background:#f4f8f5;padding:10px 13px;border-radius:0 6px 6px 0;color:#607c70;font-size:11px;margin:12px 0}
.gw .wiki .empty{padding:22px 12px;text-align:center;font-size:12px;color:#87978f;line-height:1.8}
.gw .wiki .visually-hidden{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
.gw .wiki .modal-backdrop{position:absolute;inset:0;background:#102b29aa;display:grid;place-items:center;z-index:10}
.gw .wiki .modal{background:#fff;border:1px solid #d6e2da;border-radius:14px;width:min(460px,calc(100% - 24px));padding:24px;box-shadow:0 30px 60px #143c3433}
.gw .wiki .modal h2{font-size:20px;margin:0 0 8px;font-family:Georgia,"Noto Serif SC",serif}
.gw .wiki .modal label{display:block;font-weight:650;font-size:12px;margin:12px 0 5px}
.gw .wiki .modal input,.gw .wiki .modal select{display:block;width:100%;border:1px solid #d0ded6;border-radius:8px;padding:10px;font-size:14px;background:#fff}
.gw .wiki .modal footer{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}
@container dsh-workbench (max-width:1260px){.gw .wiki .workspace{grid-template-columns:200px minmax(0,1fr) 288px}.gw .wiki .doc-head{padding:16px}.gw .wiki .doc-content{padding:15px}.gw .wiki .graph-top{padding:0 12px}.gw .wiki .banner{padding:0 14px}}
@container dsh-workbench (max-width:1000px){.gw .wiki .workspace{grid-template-columns:192px minmax(0,1fr)}.gw .wiki .right{position:absolute;z-index:8;right:0;top:65px;bottom:0;width:min(370px,90%);box-shadow:-12px 0 22px #17292114}.gw .wiki .graph-col{grid-column:2}.gw .wiki .graph-top .graph-title small{display:none}}
@container dsh-workbench (max-width:650px){.gw .wiki .banner h1{font-size:17px}.gw .wiki .banner-right .chip{display:none}.gw .wiki .workspace{grid-template-columns:1fr}.gw .wiki .left{display:none}.gw .wiki .graph-col{grid-column:1}.gw .wiki .graph-top{height:60px;flex-wrap:wrap;align-content:center;gap:5px}.gw .wiki .graph-footer span:first-child{display:none}.gw .wiki .right{top:65px}.gw .wiki .corner{padding:8px}.gw .wiki .legend{gap:4px}}
${WIKI_WORKSPACE_CSS}`;
