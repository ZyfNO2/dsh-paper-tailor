/**
 * Scoped styles for the redesigned workbench.
 *
 * Everything lives under `.rd-root` so the redesign never bleeds into the DSH
 * shell or the legacy evolver-ui styles (evw-* prefix). One self-injecting
 * stylesheet, dark theme tuned to the 1586×992 references.
 */

const CSS = `
.rd-root,[data-dsh-workbench]{
  --rd-bg:#0e1013; --rd-panel:#15181d; --rd-panel-2:#181c22; --rd-inset:#101317;
  --rd-border:rgba(255,255,255,.08); --rd-border-strong:rgba(255,255,255,.16);
  --rd-text:#e9ebef; --rd-text-2:#9aa1ab; --rd-text-3:#6f7681;
  --rd-blue:#5b93ff; --rd-blue-soft:rgba(91,147,255,.14);
  --rd-gray:#9aa3b2; --rd-purple:#b48cff; --rd-green:#43d39a; --rd-yellow:#f0b94e; --rd-pink:#f473a2;
  --rd-amber-bg:rgba(214,158,46,.08); --rd-amber-border:rgba(214,158,46,.42); --rd-amber-text:#e6c171;
  --rd-red:#f06c6c; --rd-red-soft:rgba(240,108,108,.12);
  --rd-onAccent:#fff;
}
body:not([data-ds-dark-theme]) .rd-root,body:not([data-ds-dark-theme]) [data-dsh-workbench]{
  --rd-bg:#f7f8fa;--rd-panel:#fff;--rd-panel-2:#f0f3f7;--rd-inset:#f6f8fb;
  --rd-border:rgba(20,30,50,.12);--rd-border-strong:rgba(20,30,50,.24);
  --rd-text:#202732;--rd-text-2:#526174;--rd-text-3:#68788a;
  --rd-blue:#245dcc;--rd-purple:#7643bc;--rd-green:#13794d;--rd-yellow:#966307;--rd-pink:#b33866;
  --rd-amber-bg:#fff8e9;--rd-amber-border:#d9b96c;--rd-amber-text:#765210;
  --rd-red:#b83232;
  --rd-onAccent:#fff;
}
.rd-root{
  position:relative;
  background:var(--rd-bg); color:var(--rd-text);
  font-family:"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,-apple-system,sans-serif;
  font-size:14px; line-height:1.55;
  height:100%; min-height:0; display:flex; flex-direction:column; overflow:hidden;
}
.rd-root *{box-sizing:border-box}
.rd-root,.rd-root *{min-width:0}
.rd-root .rd-row,.rd-contribHead{flex-wrap:wrap}
.rd-root .rd-chip{max-width:100%;white-space:normal;overflow-wrap:anywhere}
.rd-root h2,.rd-root dd,.rd-root .rd-section,.rd-root .rd-contrib{overflow-wrap:anywhere}
/* The bottom inset is a declared HOST value (--rd-bottom-inset), defaulting to
   the composer height; nothing else in the sheet stacks another padding to
   "probably" clear the input (FE-01 §4). It is applied to the element that
   actually scrolls: the host box reserves the space, and each page's own
   scroller ALSO keeps the last row above the composer — the tree page scrolls
   inside .rd-execViewport, so padding only on the outer box left its bottom
   card hidden behind the input (measured live: 152px covered). */
[data-dsh-workbench]{background:var(--rd-bg);color:var(--rd-text);overflow:hidden;max-width:100%;
  padding-bottom:var(--rd-bottom-inset,112px);box-sizing:border-box}
.rd-hostHeader{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 20px;border-bottom:1px solid var(--rd-border);font-size:12px;flex-shrink:0}
.rd-hostHeader label{min-width:0;display:flex;align-items:center;gap:6px;flex:1}
.rd-hostHeader select{width:100%;max-width:360px;min-width:0;background:var(--rd-panel-2);color:var(--rd-text);padding:5px;border:1px solid var(--rd-border-strong);border-radius:6px}
.rd-hostHeader button{background:var(--rd-panel-2);color:var(--rd-text);border:1px solid var(--rd-border-strong);border-radius:6px;padding:5px 12px}
body:not([data-ds-dark-theme]) .rd-root .rd-chip{color:var(--rd-text-2)}
body:not([data-ds-dark-theme]) .rd-root .rd-chip-blue,body:not([data-ds-dark-theme]) .rd-root .rd-evidTag.rd-paper{color:var(--rd-blue)}
body:not([data-ds-dark-theme]) .rd-root .rd-chip-green,body:not([data-ds-dark-theme]) .rd-root .rd-evidTag.rd-local{color:var(--rd-green)}
body:not([data-ds-dark-theme]) .rd-root .rd-chip-purple{color:var(--rd-purple)}
body:not([data-ds-dark-theme]) .rd-root .rd-chip-yellow{color:var(--rd-yellow)}
.rd-root .rd-menu,.rd-root .rd-zoomBtns .rd-btn,.rd-root .rd-hiddenChip,.rd-root .rd-toast{background:var(--rd-panel-2)}
.rd-root ::-webkit-scrollbar-thumb{background:var(--rd-border-strong)}
.rd-root button{font-family:inherit}
.rd-root ::-webkit-scrollbar{width:9px;height:9px}
.rd-root ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:6px}
.rd-root ::-webkit-scrollbar-track{background:transparent}

.rd-tabs{display:flex;gap:34px;padding:0 30px;border-bottom:1px solid var(--rd-border);flex:0 0 auto}
.rd-tab{appearance:none;background:none;border:none;color:var(--rd-text-2);font-size:19px;font-weight:600;
  padding:16px 2px 12px;cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-1px}
.rd-tab:hover{color:var(--rd-text)}
.rd-tab[aria-selected=true]{color:var(--rd-text);border-bottom-color:var(--rd-text)}
.rd-tab:focus-visible{outline:2px solid var(--rd-blue);outline-offset:2px}

.rd-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:22px 28px 26px;display:flex;flex-direction:column;gap:16px}

.rd-precond{border:1px solid var(--rd-amber-border);background:var(--rd-amber-bg);border-radius:10px;flex:0 0 auto;position:relative;z-index:2}
.rd-precond>summary{list-style:none;cursor:pointer;padding:12px 16px;font-size:15px;color:var(--rd-amber-text);
  display:flex;align-items:center;gap:10px;user-select:none}
.rd-precond>summary::-webkit-details-marker{display:none}
.rd-precond .rd-caret{transition:transform .15s}
.rd-precond[open] .rd-caret{transform:rotate(90deg)}
.rd-precondBody{padding:0 16px 12px 40px;display:flex;flex-direction:column;gap:6px;color:var(--rd-text-2)}
.rd-precondItem{display:flex;gap:8px;align-items:flex-start}
.rd-precondItem b{color:var(--rd-amber-text);font-weight:600}

.rd-demoBadge{position:fixed;right:14px;bottom:12px;z-index:60;font-size:12px;color:var(--rd-amber-text);
  background:rgba(20,18,10,.92);border:1px solid var(--rd-amber-border);border-radius:20px;padding:5px 14px;
  display:flex;gap:8px;align-items:center;pointer-events:none}

/* generic panels */
.rd-panel{background:var(--rd-panel);border:1px solid var(--rd-border);border-radius:11px}
.rd-pad{padding:14px 16px}
.rd-muted{color:var(--rd-text-2)}
.rd-dim{color:var(--rd-text-3)}
.rd-row{display:flex;align-items:center;gap:8px}
.rd-spacer{flex:1 1 auto}

.rd-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--rd-border-strong);
  background:transparent;color:var(--rd-text-2);border-radius:14px;padding:2px 11px;font-size:12px;line-height:1.6;white-space:nowrap}
.rd-chip-blue{border-color:rgba(91,147,255,.55);color:#9dbdff;background:rgba(91,147,255,.1)}
.rd-chip-green{border-color:rgba(67,211,154,.5);color:#7fe6bd;background:rgba(67,211,154,.1)}
.rd-chip-purple{border-color:rgba(180,140,255,.5);color:#cbb2ff;background:rgba(180,140,255,.1)}
.rd-chip-yellow{border-color:rgba(240,185,78,.5);color:#f3cc84;background:rgba(240,185,78,.1)}
.rd-chip-gray{border-color:var(--rd-border-strong);color:var(--rd-text-2);background:rgba(255,255,255,.04)}
.rd-chip-red{border-color:rgba(240,108,108,.5);color:#f59a9a;background:var(--rd-red-soft)}

.rd-btn{appearance:none;border:1px solid var(--rd-border-strong);background:transparent;color:var(--rd-text);
  border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.rd-btn:hover:not(:disabled){border-color:rgba(255,255,255,.32);background:rgba(255,255,255,.05)}
.rd-btn:disabled{opacity:.45;cursor:not-allowed}
.rd-btn-primary{background:var(--rd-blue);border-color:var(--rd-blue);color:#fff;font-weight:600}
.rd-btn-primary:hover:not(:disabled){background:#6fa0ff;border-color:#6fa0ff}
.rd-btn-ghost{border-color:transparent;color:var(--rd-text-2)}
.rd-btn-ghost:hover:not(:disabled){background:rgba(255,255,255,.06);color:var(--rd-text)}
.rd-btn:focus-visible{outline:2px solid var(--rd-blue);outline-offset:1px}

.rd-input,.rd-select{appearance:none;background:var(--rd-inset);border:1px solid var(--rd-border);
  border-radius:9px;color:var(--rd-text);font-size:14px;padding:9px 13px;width:100%}
.rd-input::placeholder{color:var(--rd-text-3)}
.rd-input:focus,.rd-select:focus{outline:none;border-color:var(--rd-blue)}
.rd-select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%239aa1ab' fill='none' stroke-width='1.6'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 12px center;padding-right:30px;cursor:pointer}
.rd-select option{background:#171a1f;color:var(--rd-text)}
.rd-searchIcon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--rd-text-3)}
.rd-searchWrap{position:relative}
.rd-searchWrap .rd-input{padding-left:36px}

/* region state boxes */
.rd-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
  padding:60px 30px;text-align:center;color:var(--rd-text-2);flex:1 1 auto;min-height:240px}
.rd-state .rd-stateTitle{font-size:16px;color:var(--rd-text);font-weight:600}
.rd-stateError{border:1px solid rgba(240,108,108,.4);background:var(--rd-red-soft);color:#f1a3a3;border-radius:9px;
  padding:10px 14px;max-width:560px;font-size:13px;text-align:left}
.rd-stateBlocked{border-color:rgba(240,185,78,.4);background:rgba(240,185,78,.07);color:var(--rd-amber-text)}
.rd-spinner{width:26px;height:26px;border-radius:50%;border:3px solid rgba(255,255,255,.15);
  border-top-color:var(--rd-blue);animation:rdspin .8s linear infinite}
@keyframes rdspin{to{transform:rotate(360deg)}}
.rd-staleBanner{display:flex;gap:8px;align-items:center;background:rgba(240,185,78,.1);
  border:1px solid rgba(240,185,78,.4);color:var(--rd-amber-text);border-radius:8px;padding:7px 12px;font-size:12.5px}

/* shared inspector */
.rd-inspector{display:flex;flex-direction:column;min-height:0}
.rd-inspHead{display:flex;align-items:flex-start;gap:12px;padding:16px 18px 10px}
.rd-inspIcon{width:46px;height:46px;border-radius:11px;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
.rd-inspClose{margin-left:auto}
.rd-inspTitle{font-size:19px;font-weight:700;margin:0}
.rd-inspSub{color:var(--rd-text-2);font-size:13px;margin-top:2px}
.rd-inspTabs{display:flex;gap:22px;padding:0 18px;border-bottom:1px solid var(--rd-border)}
.rd-inspTab{appearance:none;background:none;border:none;color:var(--rd-text-2);font-size:14px;font-weight:600;
  padding:9px 2px;border-bottom:2px solid transparent;margin-bottom:-1px;cursor:pointer}
.rd-inspTab[aria-selected=true]{color:var(--rd-text);border-bottom-color:var(--rd-text)}
.rd-inspBody{padding:14px 18px 18px;padding-bottom:calc(18px + var(--rd-bottom-inset,0px));overflow-y:auto;display:flex;flex-direction:column;gap:12px;min-height:0}
.rd-section{border:1px solid var(--rd-border);border-radius:9px;padding:11px 13px;display:flex;flex-direction:column;gap:7px}
.rd-sectionTitle{display:flex;align-items:center;gap:7px;font-weight:700;font-size:14px}
.rd-sectionTitle::before{content:"";width:3px;height:14px;border-radius:2px;background:var(--rd-blue)}
.rd-kv{display:grid;grid-template-columns:88px 1fr;gap:5px 12px;font-size:13px}
.rd-kv dt{color:var(--rd-text-2)}
.rd-kv dd{margin:0;min-width:0;word-break:break-word}
.rd-linkBtn{appearance:none;background:none;border:none;padding:0;color:#8fb4ff;font-size:13px;cursor:pointer;text-align:left}
.rd-linkBtn:hover{text-decoration:underline}
.rd-broken{color:var(--rd-text-3);font-size:12px;display:flex;gap:5px;align-items:center}
.rd-emptyHint{color:var(--rd-text-3);font-size:13px;text-align:center;padding:26px 10px}
.rd-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
  height:100%;min-height:300px;color:var(--rd-text-2);text-align:center;padding:24px}
.rd-placeholder .rd-big{font-size:17px;color:var(--rd-text)}

/* toast */
.rd-toast{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);z-index:70;
  background:#20242b;border:1px solid var(--rd-border-strong);border-radius:9px;padding:10px 16px;
  font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.5);display:flex;gap:10px;align-items:center;max-width:70%}
.rd-toastErr{border-color:rgba(240,108,108,.5)}
.rd-toastOk::before{content:"✓";color:var(--rd-green);font-weight:700}

/* modal */
.rd-modalMask{position:absolute;inset:0;background:rgba(5,7,10,.62);z-index:65;display:flex;
  align-items:center;justify-content:center;padding:40px}
.rd-modal{width:min(620px,92%);max-height:82%;overflow-y:auto;background:var(--rd-panel);
  border:1px solid var(--rd-border-strong);border-radius:13px;padding:20px 22px;display:flex;flex-direction:column;gap:14px}
.rd-modalTitle{font-size:17px;font-weight:700}
.rd-field{display:flex;flex-direction:column;gap:5px}
.rd-field label{font-size:12.5px;color:var(--rd-text-2)}
.rd-reject{border:1px solid rgba(240,108,108,.4);background:var(--rd-red-soft);color:#f1a3a3;border-radius:8px;
  padding:8px 12px;font-size:12.5px}

/* ---------- work tree ---------- */
.rd-summary{display:flex;gap:18px;align-items:stretch}
.rd-summaryNarr{flex:1 1 auto;padding-right:18px;font-size:15px}
.rd-summaryNarr h3{margin:0 0 10px;font-size:17px}
.rd-stats{flex:0 0 auto;display:grid;grid-template-columns:repeat(4,minmax(104px,1fr));
  border-left:1px solid var(--rd-border)}
.rd-stat{padding:2px 22px;display:flex;flex-direction:column;gap:6px;justify-content:flex-start}
.rd-stat+.rd-stat{border-left:1px solid var(--rd-border)}
.rd-statLabel{color:var(--rd-text-2);font-size:13px}
.rd-statVal{font-size:27px;font-weight:700;line-height:1.2}
.rd-treeBody{flex:1 1 auto;display:flex;gap:14px;min-height:0}
.rd-graphCard{flex:1 1 74%;min-width:0;display:flex;flex-direction:column}
.rd-graphToolbar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--rd-border);flex:0 0 auto}
.rd-seg{display:flex;border:1px solid var(--rd-border-strong);border-radius:8px;overflow:hidden}
.rd-seg button{appearance:none;background:transparent;border:none;color:var(--rd-text-2);padding:5px 12px;
  font-size:12.5px;cursor:pointer}
.rd-seg button[aria-pressed=true]{background:var(--rd-blue-soft);color:#bcd3ff}
.rd-graphViewport{flex:1 1 auto;position:relative;overflow:hidden;cursor:grab;min-height:300px}
.rd-graphViewport.rd-panning{cursor:grabbing}
.rd-graphSvg{position:absolute;left:0;top:0;transform-origin:0 0}
.rd-gNode{cursor:pointer}
.rd-gNode rect{stroke-width:1.4;transition:stroke-width .1s}
.rd-gNode:focus{outline:none}
.rd-gNode:focus-visible rect{stroke-width:3;stroke:#fff}
.rd-gNode.rd-selected rect{stroke-width:2.6}
.rd-gNode .rd-gTitle{font-size:12px;font-weight:700;fill:var(--rd-text)}
.rd-gNode .rd-gSub{font-size:11.5px;fill:var(--rd-text-2)}
.rd-gNode .rd-gStatusTxt{font-size:10.5px}
.rd-edgePath{fill:none;stroke-width:1.7}
.rd-zoomBtns{position:absolute;right:10px;top:10px;display:flex;flex-direction:column;gap:6px;z-index:5}
.rd-zoomBtns .rd-btn{padding:5px 9px;background:rgba(20,23,28,.85)}
.rd-hiddenChip{position:absolute;left:10px;top:10px;z-index:5;display:flex;gap:8px;align-items:center;
  background:rgba(20,23,28,.9);border:1px dashed var(--rd-border-strong);border-radius:8px;padding:5px 10px;font-size:12px}
.rd-legend{flex:0 0 auto;display:flex;gap:26px;align-items:center;padding:10px 16px;border-top:1px solid var(--rd-border);
  color:var(--rd-text-2);font-size:13px;flex-wrap:wrap}
.rd-legendItem{display:flex;align-items:center;gap:7px}
.rd-legendLine{width:34px;height:0;border-top:2px solid var(--rd-text-2)}
.rd-legendLine.dashed{border-top:2px dashed var(--rd-text-2)}
.rd-legendDot{width:11px;height:11px;border-radius:50%}
.rd-treeInsp{flex:0 0 26%;min-width:280px}

.rd-activity{flex:0 0 auto;position:relative;z-index:2}
.rd-activity>summary{list-style:none;cursor:pointer;padding:11px 16px;font-size:15px;font-weight:600;
  display:flex;align-items:center;gap:10px;user-select:none}
.rd-activity>summary::-webkit-details-marker{display:none}
.rd-activity .rd-caret{transition:transform .15s}
.rd-activity[open] .rd-caret{transform:rotate(90deg)}
.rd-activityBody{padding:0 16px 14px 40px;display:flex;flex-direction:column;gap:8px}
.rd-actItem{display:grid;grid-template-columns:132px 1fr;gap:12px;font-size:13px;border-left:2px solid var(--rd-border);padding:2px 0 2px 12px}
.rd-actTime{color:var(--rd-text-3)}
.rd-actReject{color:#f1a3a3}

/* provenance / identity (FE-01) — long values never widen a column */
.rd-summaryLine{display:flex;gap:10px;align-items:center;flex:0 0 auto;flex-wrap:wrap;font-size:12px}
.rd-summaryLine .rd-linkBtn{display:inline-flex;align-items:center;gap:4px;font-size:12px}
.rd-sourcePanel{flex:0 0 auto;max-height:34vh;overflow-y:auto;border:1px solid var(--rd-border);
  border-radius:9px;background:var(--rd-inset);padding:9px 12px;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.rd-sourceRow{display:flex;gap:10px;align-items:center;min-width:0;font-size:12.5px}
.rd-sourceName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rd-sourceOwn{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--rd-border);padding-top:8px}
.rd-quote summary{cursor:pointer;color:var(--rd-text-2);font-size:12.5px}
.rd-quote blockquote{margin:6px 0 0;padding:6px 0 6px 10px;border-left:2px solid var(--rd-border-strong);
  color:var(--rd-text-2);font-size:12.5px;overflow-wrap:anywhere}
.rd-rev{display:inline-flex;align-items:center;gap:5px;max-width:100%;min-width:0}
.rd-rev code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;
  overflow-wrap:anywhere;word-break:break-all}
.rd-revCopy{appearance:none;background:none;border:none;padding:0;color:#8fb4ff;font-size:11.5px;cursor:pointer;
  display:inline-flex;align-items:center;gap:3px;flex:0 0 auto}
.rd-revCopy:hover{text-decoration:underline}
/* 2-line clamp for list cards; the full text stays in the detail panel */
.rd-compCard .rd-compName{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}

/* ---------- tailor shop ---------- */
.rd-tailorBody{flex:1 1 auto;display:flex;gap:13px;min-height:0}
.rd-tl-left{flex:0 0 25%;min-width:230px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;padding-right:2px}
.rd-tl-mid{flex:1 1 47%;min-width:0;display:flex;flex-direction:column;gap:11px;min-height:0}
.rd-tl-right{flex:0 0 28%;min-width:280px;min-height:0;display:flex}
.rd-tl-right>.rd-panel,.rd-tl-right .rd-inspector{flex:1 1 auto;min-height:0}
.rd-posGroup{border-left:3px solid var(--rd-blue);border-radius:0 10px 10px 0;background:var(--rd-panel);
  border:1px solid var(--rd-border);border-left:3px solid var(--rd-blue);padding:10px 12px;display:flex;flex-direction:column;gap:9px}
.rd-posHead{font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px}
.rd-posDot{width:9px;height:9px;border-radius:50%;background:var(--rd-blue);box-shadow:0 0 0 3px rgba(91,147,255,.18)}
.rd-posChips{display:flex;flex-wrap:wrap;gap:7px}
.rd-posChip{border:1px solid var(--rd-border-strong);border-radius:16px;background:var(--rd-inset);
  color:var(--rd-text);font-size:12.5px;padding:3px 12px;cursor:pointer}
.rd-posChip:hover{border-color:var(--rd-blue);color:#bcd3ff}
.rd-addChip{border:1px dashed var(--rd-border-strong);border-radius:16px;background:transparent;color:var(--rd-text-2);
  font-size:12.5px;padding:3px 12px;cursor:pointer}
.rd-addChip:hover{border-color:var(--rd-blue);color:#bcd3ff}
.rd-posArrow{text-align:center;color:var(--rd-text-3);font-size:15px;line-height:1}
.rd-modeSwitch{display:flex;justify-content:center}
.rd-modeSwitch .rd-seg button{padding:6px 20px;font-size:13px}
.rd-catGroup{display:flex;flex-direction:column;gap:9px}
.rd-catHead{font-size:13px;font-weight:700;color:var(--rd-text-2);display:flex;justify-content:space-between}

.rd-filterRow{display:flex;gap:8px;align-items:center;flex:0 0 auto;flex-wrap:wrap}
.rd-fchip{appearance:none;border:1px solid var(--rd-border-strong);background:transparent;color:var(--rd-text-2);
  border-radius:17px;padding:5px 14px;font-size:13px;cursor:pointer;white-space:nowrap}
.rd-fchip:hover{border-color:rgba(255,255,255,.3)}
.rd-fchip[aria-pressed=true]{background:var(--rd-blue);border-color:var(--rd-blue);color:#fff;font-weight:600}
.rd-cardList{flex:1 1 auto;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding-right:3px;min-height:0}
.rd-compCard{display:flex;gap:12px;align-items:center;border:1px solid var(--rd-border);border-radius:10px;
  background:var(--rd-panel);padding:12px 14px;text-align:left;width:100%;color:var(--rd-text)}
/* The select target is its own button so the action buttons beside it are not
   nested controls (invalid <button> in <button>, unreachable by keyboard). */
.rd-compSelect{appearance:none;background:none;border:none;padding:0;color:inherit;font:inherit;
  display:flex;gap:12px;align-items:center;flex:1 1 auto;min-width:0;cursor:pointer;text-align:left}
.rd-compSelect:focus-visible{outline:2px solid var(--rd-blue);outline-offset:2px;border-radius:8px}
.rd-compCard:hover{border-color:var(--rd-border-strong)}
.rd-compCard.rd-selected{border-color:var(--rd-blue);box-shadow:0 0 0 1px var(--rd-blue) inset}
.rd-compIcon{width:38px;height:38px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
.rd-compMain{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:5px}
.rd-compName{font-weight:700;font-size:14.5px}
.rd-compDesc{color:var(--rd-text-2);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.rd-compActions{display:flex;align-items:center;gap:12px;flex:0 0 auto}
.rd-moreBtn{appearance:none;background:none;border:none;color:var(--rd-text-2);font-size:17px;cursor:pointer;padding:2px 6px;border-radius:6px}
.rd-moreBtn:hover{background:rgba(255,255,255,.08);color:var(--rd-text)}
.rd-advPanel{border:1px solid var(--rd-border);border-radius:9px;padding:10px 12px;display:flex;gap:18px;flex-wrap:wrap;
  background:var(--rd-inset);font-size:12.5px}
.rd-check{display:flex;gap:6px;align-items:center;color:var(--rd-text-2);cursor:pointer}
.rd-menu{position:absolute;background:#1d2128;border:1px solid var(--rd-border-strong);border-radius:9px;
  padding:6px;z-index:40;min-width:170px;display:flex;flex-direction:column;box-shadow:0 10px 28px rgba(0,0,0,.5)}
.rd-menu button{appearance:none;background:none;border:none;color:var(--rd-text);text-align:left;padding:7px 10px;
  border-radius:6px;font-size:13px;cursor:pointer}
.rd-menu button:hover{background:rgba(255,255,255,.07)}

/* ---------- papers ---------- */
.rd-paperToolbar{display:flex;gap:10px;align-items:center;flex:0 0 auto}
.rd-paperToolbar .rd-searchWrap{flex:1 1 auto}
.rd-paperBody{flex:1 1 auto;display:flex;gap:13px;min-height:0}
.rd-pl-left{flex:0 0 29%;min-width:240px;display:flex;flex-direction:column;min-height:0}
.rd-pl-listHead{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--rd-border);font-size:13px;color:var(--rd-text-2)}
.rd-pl-list{flex:1 1 auto;overflow-y:auto;padding:8px;padding-bottom:calc(8px + var(--rd-bottom-inset,0px));display:flex;flex-direction:column;gap:4px;min-height:0}
.rd-pl-item{appearance:none;display:flex;gap:10px;align-items:flex-start;width:100%;text-align:left;
  background:transparent;border:1px solid transparent;border-radius:9px;padding:10px;cursor:pointer;color:var(--rd-text)}
.rd-pl-item:hover{background:rgba(255,255,255,.04)}
.rd-pl-item.rd-selected{border-color:var(--rd-blue);background:rgba(91,147,255,.07)}
.rd-pl-doc{width:34px;height:34px;border-radius:8px;background:var(--rd-panel-2);border:1px solid var(--rd-border);
  display:flex;align-items:center;justify-content:center;flex:0 0 auto;color:var(--rd-text-2)}
.rd-pl-main{flex:1 1 auto;min-width:0}
.rd-pl-title{display:block;font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rd-pl-sub{display:block;font-size:12px;color:var(--rd-text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rd-pl-flags{display:flex;gap:5px;margin-top:5px;flex-wrap:wrap}
.rd-pl-score{flex:0 0 auto;font-size:14px;color:#b9c8ff;font-weight:600;padding-top:8px}
.rd-pl-score.none{color:var(--rd-text-3);font-weight:400;font-size:12px}
.rd-pr-right{flex:1 1 71%;min-width:0;display:flex;flex-direction:column;gap:12px;min-height:0}
.rd-pr-detail{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.rd-pr-top{padding:14px 18px 12px;display:flex;gap:14px;align-items:flex-start}
.rd-pr-doc{width:46px;height:46px;border-radius:10px;background:var(--rd-panel-2);border:1px solid var(--rd-border);
  display:flex;align-items:center;justify-content:center;flex:0 0 auto;color:var(--rd-text-2)}
.rd-pr-actions{display:flex;gap:8px;margin-left:auto;flex:0 0 auto}
.rd-pr-split{flex:1 1 auto;min-height:0;display:flex;gap:13px;padding:0 16px 16px}
.rd-pr-contribs{flex:1 1 65%;min-width:0;overflow-y:auto;display:flex;flex-direction:column;gap:11px;padding-right:2px}
.rd-pr-meta{flex:0 0 35%;min-width:230px;overflow-y:auto;display:flex;flex-direction:column;gap:11px}
.rd-contrib{border:1px solid var(--rd-border);border-radius:10px;padding:11px 13px;display:flex;flex-direction:column;gap:8px;background:var(--rd-panel)}
.rd-contribHead{display:flex;align-items:center;gap:9px}
.rd-contribIcon{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center}
.rd-contribTitle{font-weight:700;font-size:14px}
.rd-evidList{display:flex;flex-direction:column;gap:6px;margin-top:2px}
.rd-evid{border-left:3px solid var(--rd-border-strong);padding:2px 0 2px 10px;font-size:12.5px;display:flex;flex-direction:column;gap:2px}
.rd-evid.rd-paper{border-left-color:#7fa8ff}
.rd-evid.rd-local{border-left-color:var(--rd-green)}
.rd-evidTag{font-size:11px;font-weight:700;border-radius:4px;padding:0 6px;margin-right:6px}
.rd-evidTag.rd-paper{color:#9dbdff;background:rgba(91,147,255,.15)}
.rd-evidTag.rd-local{color:#7fe6bd;background:rgba(67,211,154,.14)}
.rd-note textarea{width:100%;min-height:84px;resize:vertical;background:var(--rd-inset);border:1px solid var(--rd-border);
  border-radius:8px;color:var(--rd-text);font-size:13px;padding:9px 11px;font-family:inherit}
.rd-noteFoot{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--rd-text-3)}
.rd-relList{display:flex;flex-direction:column}
/* Fallback for hosts that do not expose the workbench container: the viewport
   query keeps the layout usable, and the container queries below (later in the
   sheet, so they win when supported) are what actually drive the breakpoints. */
@media (max-width:1180px){
  .rd-treeBody{flex-direction:column}
  .rd-treeInsp{flex:1 1 auto;min-width:0;min-height:260px}
  .rd-graphCard{flex:1 1 auto}
  .rd-tailorBody{flex-direction:column;overflow-y:auto}
  .rd-tl-left,.rd-tl-mid,.rd-tl-right{flex:1 1 auto;min-width:0;width:100%}
  .rd-tl-left{overflow:visible}
  .rd-cardList{min-height:220px}
  .rd-paperBody{flex-direction:column;overflow-y:auto}
  .rd-pl-left{flex:1 1 auto;min-width:0;width:100%;min-height:260px}
  .rd-pr-right{flex:1 1 auto;min-width:0}
  .rd-stats{grid-template-columns:repeat(2,minmax(120px,1fr));gap:8px 0}
  .rd-summary{flex-direction:column}
  .rd-stats{border-left:none;border-top:1px solid var(--rd-border);padding-top:12px}
  .rd-pr-split{flex-direction:column}
  .rd-pr-meta{flex:1 1 auto;min-width:0}
}
@container dsh-workbench (max-width:1099px){
  .rd-paperToolbar{flex-wrap:wrap}.rd-paperToolbar .rd-searchWrap{flex-basis:100%}
  .rd-treeBody,.rd-tailorBody{flex-direction:column;flex:none;min-height:0}
  .rd-treeInsp{flex:none;min-width:0;min-height:200px}
  .rd-graphCard{flex:none;min-height:400px}
  /* 700–1099px: list + detail stay, the nav column collapses to a drawer. */
  .rd-tl-left{flex:none;min-width:0;width:100%;max-height:210px;overflow-y:auto}
  .rd-tl-mid{flex:1 1 auto;min-width:0;width:100%;min-height:260px}
  .rd-tl-right{flex:1 1 auto;min-width:0;width:100%;min-height:240px}
  .rd-cardList{max-height:none;min-height:180px}
  .rd-summary{flex-direction:column}
  .rd-stats{border-left:none;border-top:1px solid var(--rd-border);padding-top:12px;grid-template-columns:repeat(4,minmax(0,1fr))}
  .rd-pr-top{flex-wrap:wrap}
  .rd-pr-actions{flex-wrap:wrap;margin-left:0;width:100%}
  .rd-pr-split{flex-direction:column;overflow-y:auto}
  .rd-pr-meta{flex:1 1 auto;min-width:0;overflow:visible}
  .rd-pr-contribs{flex:1 0 auto;overflow:visible}
  .rd-inspTabs{gap:12px;flex-wrap:wrap}
}
@container dsh-workbench (max-width:699px){
  .rd-scroll{padding:14px;overflow-x:hidden}
  .rd-tabs{gap:22px;padding:0 14px}.rd-tab{font-size:16px}
  .rd-paperToolbar{flex-wrap:wrap}.rd-paperToolbar .rd-searchWrap{flex-basis:100%}
  .rd-paperBody{flex-direction:column;flex:none}
  .rd-pl-left,.rd-pr-right{flex:none;min-width:0;width:100%}
  .rd-pl-list{max-height:300px}
  .rd-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.rd-stat{padding:4px 12px}
  .rd-legend{gap:12px}.rd-pr-split{overflow:visible}.rd-pr-contribs{overflow:visible}
  /* <700px: single list column; nav and detail become drawers. */
  .rd-tailorBody{flex-direction:column;flex:none;overflow-y:auto}
  .rd-tl-left{flex:none;width:100%;max-height:none}
  .rd-tl-mid{flex:none;width:100%;min-height:0}
  .rd-tl-right{flex:none;width:100%;min-height:0}
  .rd-cardList{overflow:visible;min-height:0;max-height:none}
  .rd-sourcePanel{max-height:none}
  .rd-drawer{position:absolute;inset:0;z-index:50;background:var(--rd-bg);border:1px solid var(--rd-border-strong);
    border-radius:10px;display:flex;flex-direction:column;min-height:0;overflow:hidden}
  .rd-drawerHead{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--rd-border);flex:0 0 auto}
  .rd-drawerBody{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px}
}
.rd-relRow{display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid rgba(255,255,255,.05);font-size:13px}
.rd-relRow:last-child{border-bottom:none}
.rd-relRow b{font-weight:600;color:var(--rd-text-2)}

/* ---------- research bootstrap (FE-02) ---------- */
.rd-gNode .rd-gPlanTxt{font-size:10px;fill:var(--rd-text-2)}
.rd-unsaved{color:var(--rd-amber-text)}
.rd-hint{font-size:12px;color:var(--rd-text-2);border:1px solid var(--rd-border);
  border-radius:7px;padding:6px 10px;background:var(--rd-inset)}
.rd-group{border:1px solid var(--rd-border);border-radius:9px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;margin:0}
.rd-group legend{font-size:12.5px;color:var(--rd-text-2);padding:0 6px}
.rd-startGrid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(260px,1fr);gap:13px;align-items:start}
.rd-startMain,.rd-startEnv{display:flex;flex-direction:column;gap:10px;min-width:0}
.rd-envList{display:flex;flex-direction:column;gap:5px}
.rd-envRow{display:flex;gap:8px;align-items:center;min-width:0;font-size:12.5px}
.rd-envProbe{flex:0 0 auto;font-weight:600}
.rd-envValue{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}

.rd-bsBody{display:flex;flex-direction:column;gap:12px;min-height:0;flex:1 1 auto}
.rd-bsHead,.rd-bsRuns{display:flex;flex-direction:column;gap:8px;min-width:0}
.rd-bsCards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:11px;align-items:start}
.rd-bsFoot{flex:0 0 auto;border-top:1px solid var(--rd-border);padding-top:10px;flex-wrap:wrap}
.rd-bsEmpty{display:flex;flex-direction:column;gap:12px;min-height:0}
.bs-state{display:flex}
.rd-ideaCard{border:1px solid var(--rd-border);border-radius:11px;background:var(--rd-panel);
  padding:12px 14px;display:flex;flex-direction:column;gap:9px;min-width:0}
.rd-ideaCard.rd-selected{border-color:var(--rd-blue);box-shadow:0 0 0 1px var(--rd-blue) inset}
.rd-ideaHead{display:flex;gap:9px;align-items:center;min-width:0;flex-wrap:wrap}
.rd-ideaTitle{min-width:0;overflow-wrap:anywhere;font-size:14.5px}
.rd-ideaBody{display:flex;flex-direction:column;gap:5px}
.rd-ideaRow{display:grid;grid-template-columns:78px minmax(0,1fr);gap:10px;font-size:12.5px;align-items:start}
.rd-ideaLabel{color:var(--rd-text-2);font-size:12px}
.rd-ideaValue{min-width:0;overflow-wrap:anywhere}
.rd-ideaList{margin:0;padding-left:16px}
.rd-ideaFoot{flex-wrap:wrap;gap:8px}
.rd-ideaEdit{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--rd-border);padding-top:8px}
.rd-evidRefs{display:flex;flex-direction:column;gap:4px}
.rd-evidRef{display:flex;gap:7px;align-items:center;min-width:0;flex-wrap:wrap;font-size:12px}

/* BR-FE2: collapsible sections (失败记录 / 技术详情) and the plain-language layer. */
.rd-collapse{border:1px solid var(--rd-border);border-radius:9px;padding:7px 10px;background:var(--rd-inset)}
.rd-collapse>summary{cursor:pointer;font-size:12px;color:var(--rd-text-2);user-select:none}
.rd-collapse>summary:hover{color:var(--rd-text)}
.rd-collapse[open]{padding-bottom:10px}
.rd-ideaPlain{font-size:12.8px;line-height:1.55;color:var(--rd-text);
  border-left:3px solid var(--rd-blue);padding:2px 0 2px 10px;margin-bottom:2px;overflow-wrap:anywhere}

/* BR-FE3: Mermaid work-tree container. The svg scales to the viewport width so the
   auto-layout never overflows the workbench frame; pan/zoom transforms apply outside. */
.rd-mmContainer{min-width:0;overflow:auto;border-radius:8px;background:var(--rd-panel)}
.rd-mmContainer svg{max-width:100%;height:auto;display:block;margin:0 auto}
.rd-mmContainer .rd-mmSelected>rect,.rd-mmContainer .rd-mmSelected>.basic.label-container{stroke-width:3px}
.rd-mmFallback{font-size:12px;min-width:0;overflow-wrap:anywhere}

/* Quick fix 2026-10-10: label text must contrast the classDef FILLS, which are light
   pastels in BOTH themes (worktree-mermaid.ts). Mermaid's dark theme paints label text
   near-white (#e6e9ef) → white-on-white, unreadable. The svg's own <style> is ID-scoped
   (#rd-mm-N …), so page rules need !important to win. Status strokes (BR-11 legend
   colors) are untouched — only text/edge-label contrast is forced. */
.rd-mmContainer g.node text{fill:#172033!important}
.rd-mmContainer g.node .nodeLabel span,.rd-mmContainer g.node span.nodeLabel{color:#172033!important}
.rd-mmContainer .edgeLabel rect{fill:#e8ecf2!important;background:#e8ecf2!important;opacity:.92!important}
.rd-mmContainer .edgeLabel text,.rd-mmContainer .edgeLabel span,.rd-mmContainer .edgeLabel p{fill:#172033!important;color:#172033!important}

.rd-slotPane{display:flex;flex-direction:column;gap:7px;border:1px solid var(--rd-border);
  border-radius:10px;padding:10px 12px;background:var(--rd-inset);flex:0 0 auto}
.rd-slotNav{display:flex;flex-direction:column;gap:9px;min-width:0}
.rd-slotList{display:flex;flex-direction:column;gap:6px}
.rd-slotItem{appearance:none;text-align:left;background:var(--rd-panel);border:1px solid var(--rd-border);
  border-radius:9px;padding:8px 10px;cursor:pointer;color:var(--rd-text);display:flex;flex-direction:column;gap:3px;min-width:0}
.rd-slotItem.rd-selected{border-color:var(--rd-blue);box-shadow:0 0 0 1px var(--rd-blue) inset}
.rd-slotName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:13px}
.rd-slotDetail{display:flex;flex-direction:column;gap:7px;border-top:1px solid var(--rd-border);padding-top:9px}
.rd-candList{display:flex;flex-direction:column;gap:8px}
.rd-candItem{border:1px solid var(--rd-border);border-radius:9px;padding:9px 11px;
  display:flex;flex-direction:column;gap:6px;background:var(--rd-panel);min-width:0}
.rd-candReason{font-size:12px;overflow-wrap:anywhere}
@container dsh-workbench (max-width:1099px){
  .rd-startGrid{grid-template-columns:minmax(0,1fr)}
  .rd-bsCards{grid-template-columns:minmax(0,1fr)}
}
@container dsh-workbench (max-width:699px){
  .rd-ideaRow{grid-template-columns:minmax(0,1fr);gap:2px}
}

/* responsive: drawer style detail under 1180px — see the fallback media query
   above; the container queries are authoritative and come earlier. */
/* ---------- 实验执行图 (2026-10-11 round) ----------
   Default work-tree projection: a fixed vertical main flow (准备 → 单变量验证 →
   结果比较 → 组合与验证) with parallel experiments in one wrapping row. Every
   colour goes through the theme variables, so dark and light stay readable and
   nothing hardcodes a hex (FE-R08). Titles wrap — they are never clipped. */
.rd-execViewport{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:12px;
  /* The tree page scrolls HERE, so the composer inset must reserve space on this
     scroller too — padding only on the outer host box left the last card hidden
     behind the input (measured live: 152px covered). */
  padding-bottom:calc(12px + var(--rd-bottom-inset,0px))}
.rd-nextCard{border:1px solid var(--rd-border);border-left:3px solid var(--rd-blue);border-radius:10px;
  background:var(--rd-panel);padding:10px 14px;display:flex;flex-direction:column;gap:6px}
.rd-nextLabel{align-self:flex-start;font-size:12px;font-weight:700;color:var(--rd-blue);
  border:1px solid var(--rd-blue);border-radius:12px;padding:1px 10px;letter-spacing:1px}
.rd-nextBody{display:flex;flex-direction:column;gap:3px;min-width:0}
.rd-nextText{font-size:15px;font-weight:600;overflow-wrap:anywhere}
.rd-nextJump{margin-left:10px;font-size:13px;font-weight:400}
.rd-nextDetail{font-size:13px;color:var(--rd-text-2);overflow-wrap:anywhere}
.rd-nextFoot{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12.5px}
.rd-nextReadOnly{font-size:12px}
.rd-execFlow{display:flex;flex-direction:column;gap:0;min-width:0}
.rd-stage{border:1px solid var(--rd-border);border-radius:11px;background:var(--rd-panel);
  padding:10px 12px;display:flex;flex-direction:column;gap:9px}
.rd-stageHead{display:flex;align-items:baseline;gap:10px;min-width:0;flex-wrap:wrap}
.rd-stageLabel{font-size:14.5px;font-weight:700;flex:0 0 auto}
.rd-stageHint{font-size:12px;color:var(--rd-text-3);min-width:0;overflow-wrap:anywhere}
.rd-stageCount{margin-left:auto;font-size:12px;flex:0 0 auto}
.rd-stageBody{display:flex;flex-wrap:wrap;gap:10px;min-width:0}
.rd-stageArrow{text-align:center;color:var(--rd-text-3);font-size:15px;line-height:1;padding:5px 0;user-select:none}
.rd-stageEmpty{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:var(--rd-text-3);
  border:1px dashed var(--rd-border-strong);border-radius:9px;padding:10px 12px;flex:1 1 100%;
  background:var(--rd-inset)}
.rd-prepCard,.rd-execCard,.rd-outCard{border:1px solid var(--rd-border);border-radius:10px;
  background:var(--rd-panel-2);padding:10px 12px;display:flex;flex-direction:column;gap:7px;
  min-width:0;cursor:pointer;text-align:left}
.rd-prepCard{flex:1 1 200px;max-width:340px}
.rd-outCard{flex:1 1 240px;max-width:420px}
.rd-execCard{flex:1 1 320px;max-width:520px}
.rd-prepCard:focus-visible,.rd-execCard:focus-visible,.rd-outCard:focus-visible{outline:2px solid var(--rd-blue);outline-offset:1px}
.rd-prepHead{display:flex;align-items:center;gap:7px;flex-wrap:wrap;color:var(--rd-text-2);font-size:12.5px}
.rd-prepTitle{font-size:14px;font-weight:600;overflow-wrap:anywhere}
.rd-prepNote{font-size:12.5px;color:var(--rd-text-2);overflow-wrap:anywhere}
/* Status is never colour alone: every accent also keeps its word chip in the header. */
.rd-execCard.rd-exec-done{border-left:3px solid var(--rd-green)}
.rd-execCard.rd-exec-in_progress{border-left:3px solid var(--rd-blue)}
.rd-execCard.rd-exec-failed{border-left:3px solid var(--rd-red)}
.rd-execCard.rd-exec-blocked{border-left:3px solid var(--rd-yellow)}
.rd-execCard.rd-exec-planned{border-left:3px solid var(--rd-border-strong)}
.rd-execCard.rd-exec-pruned{border-left:3px dashed var(--rd-text-3);opacity:.82}
.rd-execCard.rd-execNext{border-color:var(--rd-blue);box-shadow:0 0 0 1px var(--rd-blue) inset,0 0 0 3px var(--rd-blue-soft)}
.rd-exSelected{outline:2px solid var(--rd-blue);outline-offset:2px}
.rd-execHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rd-execNo{flex:0 0 auto;font-weight:700;font-size:12.5px;color:var(--rd-onAccent);background:var(--rd-blue);
  border-radius:6px;padding:1px 8px;letter-spacing:.5px}
.rd-execAction{flex:0 0 auto;font-size:12.5px;color:var(--rd-text-2);border:1px solid var(--rd-border-strong);
  border-radius:6px;padding:0 7px}
.rd-execStatus{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}
.rd-execTitle{font-size:15px;font-weight:700;line-height:1.4;overflow-wrap:anywhere}
.rd-execSlots{margin:0;display:flex;flex-direction:column;gap:5px}
.rd-execSlot{display:grid;grid-template-columns:76px minmax(0,1fr);gap:8px;font-size:13px;align-items:start}
.rd-execSlot dt{color:var(--rd-text-2);font-size:12.5px;flex:0 0 auto}
.rd-execSlot dd{margin:0;min-width:0;overflow-wrap:anywhere}
.rd-execPending{color:var(--rd-yellow)}
.rd-execBlocked{display:flex;gap:6px;align-items:flex-start;font-size:12.5px;color:var(--rd-amber-text);
  background:var(--rd-amber-bg);border:1px solid var(--rd-amber-border);border-radius:8px;padding:6px 9px}
.rd-execBasis{font-size:12.5px;color:var(--rd-text-2);border-left:2px solid var(--rd-border-strong);
  padding-left:9px;overflow-wrap:anywhere}
.rd-execOutcome{font-size:12.5px;color:var(--rd-text);overflow-wrap:anywhere}
.rd-execSrc{display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;font-size:12.5px}
.rd-execSrcIdea{color:var(--rd-text-2);min-width:0;overflow-wrap:anywhere}
.rd-execMore{border-top:1px dashed var(--rd-border);padding-top:7px}
.rd-execMore>summary{cursor:pointer;font-size:12px;color:var(--rd-text-2);user-select:none}
.rd-execMore>summary:hover{color:var(--rd-text)}
.rd-execMoreBody{display:flex;flex-direction:column;gap:5px;padding-top:7px}
.rd-execConfRow{display:grid;grid-template-columns:120px minmax(0,1fr);gap:8px;font-size:12.5px}
.rd-execConfName{color:var(--rd-text-2)}
@container dsh-workbench (max-width:699px){
  .rd-execCard,.rd-prepCard,.rd-outCard{flex-basis:100%;max-width:none}
  .rd-execSlot{grid-template-columns:minmax(0,1fr);gap:1px}
  .rd-execConfRow{grid-template-columns:minmax(0,1fr);gap:1px}
}

@container dsh-workbench (max-width:1050px){
  .rd-paperBody{flex-direction:column;flex:none;overflow:visible}
  .rd-pl-left{flex:none;min-width:0;min-height:0;width:100%;max-height:260px}
  .rd-pl-list{flex:none;max-height:210px}
  .rd-pr-right{flex:none;width:100%}.rd-pr-split{overflow:visible}
}
`;

let injected = false;

export function ensureRedesignStyles(): void {
  if (injected || typeof document === 'undefined') {
    injected = injected || typeof document !== 'undefined';
    return;
  }
  const style = document.createElement('style');
  style.setAttribute('data-rd-redesign', '1');
  style.textContent = CSS;
  document.head.appendChild(style);
  injected = true;
}
