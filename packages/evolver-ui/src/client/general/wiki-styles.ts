export const WIKI_WORKSPACE_CSS = `
.gw .wiki-page{padding:0!important;display:flex;min-height:0;overflow:hidden;height:100%}
.gw .wiki-host,.gw .wiki-mount{height:100%;min-height:0;width:100%;display:flex;flex-direction:column;position:relative}
.gw .wiki-aux-panel{flex:1;min-height:0;overflow:auto;padding:24px}.gw .top-actions select[aria-label="知识区视图"]{width:auto;max-width:150px;min-height:34px;padding:0 10px;border:1px solid #cedbd5;border-radius:9px;font-size:12px;background:#fff}
.gw .wiki-host>[hidden]{display:none!important}
.gw .wiki{position:relative;container-type:inline-size;container-name:wiki;flex:1;min-height:0;font:13px/1.5 Inter,"Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.gw .wiki .workspace{min-height:0;overflow:hidden;flex:1;grid-template-columns:235px minmax(0,1fr) 330px;background:transparent}
.gw .wiki .left-scroll section{padding:0;margin:0;border:0;background:transparent}
.gw .wiki .groupcap{font-size:10px;font-weight:700;letter-spacing:.08em;color:#778a81;margin:0;padding:13px 10px 9px;display:flex;justify-content:space-between;align-items:center}
.gw .wiki .groupcap b{font-size:11px;color:#9aaca4;font-weight:400}
.gw .wiki .graph-area{min-height:0}.gw .wiki .row-entry{font-weight:400;line-height:1.5}.gw .wiki .row-entry.active{font-weight:700}.gw .wiki .left-tabs button,.gw .wiki .right-tabs button{border-radius:0;line-height:1.5;min-height:0}.gw .wiki .right-tabs button{padding:1px 6px}.gw .wiki .tabs button{font-weight:400;line-height:1.5;min-height:0}.gw .wiki .tabs button.active{font-weight:700}
.gw .wiki .graph-mode-tabs{position:static;z-index:2;background:none;border:0;border-radius:0}
.gw .wiki .wiki-graph-toolbar{min-width:0}.gw .wiki .graph-footer>.tabs{display:flex;flex-shrink:0}.gw .wiki .graph-footer>.tabs button{padding:3px 5px;min-height:26px;font-size:10px}.gw .wiki .graph-footer>span:first-of-type{display:none}
.gw .wiki .mobile-detail,.gw .wiki .mobile-directory{display:none}
.gw .wiki-feedback{flex:0 0 auto;padding:6px 14px;background:#edf5f0;font-size:12px;display:flex;justify-content:space-between;gap:10px}
.gw .wiki-feedback button{border:0;background:none}
.gw .wiki-prose{overflow-wrap:anywhere;white-space:normal}
.gw .wiki-prose p{white-space:normal;margin:0 0 9px}
.gw .wiki-prose blockquote{border-left:3px solid #b5cfc4;margin:8px 0;padding:4px 10px;background:#f5f8f6}
.gw .wiki-prose pre{white-space:pre-wrap;font-size:11px;background:#f2f5f3;margin:0;padding:2px 8px}
.gw .wiki-prose code{background:#f0f4f1;padding:1px 4px;border-radius:3px}
.gw .wiki figure{margin:8px 0}.gw .wiki figure img,.gw .wiki .source-image{max-width:100%;height:auto;object-fit:contain;border-radius:6px;display:block}
.gw .wiki figcaption{font-size:10px;color:#71867a}
.gw .wiki-dialog{border:1px solid #d6e2da;border-radius:14px;width:min(640px,calc(100vw - 32px));max-height:85vh;overflow:auto;padding:24px;background:#fff;color:#243b34;box-shadow:0 30px 60px #143c3433}
.gw .wiki-dialog::backdrop{background:#102b2977}
.gw .wiki-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
.gw .wiki-dialog h2{font:700 21px Georgia,"Noto Serif SC",serif;margin:0 0 12px}
.gw .wiki-dialog label{display:block;margin:12px 0 5px;font-size:12px;font-weight:600}
.gw .wiki-dialog input:not([type=checkbox]),.gw .wiki-dialog select,.gw .wiki-dialog textarea{display:block;width:100%;font-family:inherit;font-size:14px;line-height:1.5;border:1px solid #d0ded6;border-radius:8px;padding:9px;background:#fff}
.gw .wiki-dialog select[multiple]{min-height:90px}.gw .wiki-dialog footer{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.gw .wiki-board{display:flex;flex-direction:column;flex:1;min-height:0}
.gw .board-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:10px 12px;background:#fff;border-bottom:1px solid #dfe6e2}
.gw .board-toolbar button,.gw .board-selection button{padding:5px 8px;font-size:11px;border-radius:6px}
.gw .board-toolbar select,.gw .board-toolbar input:not([type=range]),.gw .board-selection input{width:130px;min-height:28px;font-size:11px;padding:4px}
.gw .board-toolbar label{display:flex;align-items:center;gap:5px;font-size:10px}.gw .board-toolbar input[type=range]{width:70px}
.gw .board-selection{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 12px;background:#e9f3ef;font-size:11px}
.gw .board-canvas{flex:1;min-height:250px;overflow:hidden;position:relative;background-color:#f4f7f5;background-image:radial-gradient(#cbdad1 .8px,transparent .8px);background-size:20px 20px;touch-action:none}
.gw .board-world{position:absolute;top:0;left:0;transform-origin:0 0}
.gw .board-links{position:absolute;width:1px;height:1px;overflow:visible;pointer-events:none;left:0;top:0}
.gw .board-links line{stroke:#77a39a;stroke-width:2;stroke-dasharray:5 4}.gw .board-links text{font-size:11px;fill:#527a70}
.gw .knowledge-card{position:absolute;display:flex;flex-direction:column;background:#fff;border:1px solid #d5e1d9;border-radius:12px;box-shadow:0 5px 18px #1c46320d;overflow:hidden;text-align:left}
.gw .knowledge-card.chosen{outline:2px solid #267579;outline-offset:2px}
.gw .knowledge-card>header{padding:14px 16px 10px;border-bottom:1px solid #edf1ed;cursor:grab;touch-action:none;background:#f8fbf9}
.gw .knowledge-card>header span{font-size:10px;color:#6b8779}.gw .knowledge-card>header small{float:right;color:#80958a;font-size:10px}
.gw .knowledge-card h3{font:700 17px/1.4 Georgia,"Noto Serif SC",serif;margin:6px 0 0;color:#1d4038}
.gw .knowledge-card-content{flex:1;min-height:0;overflow:auto;padding:12px 16px;font-size:12px;line-height:1.7}
.gw .knowledge-card-content .wiki-prose{display:-webkit-box;-webkit-line-clamp:8;-webkit-box-orient:vertical;overflow:hidden}
.gw .knowledge-card footer{padding:5px 12px;border-top:1px solid #edf1ed;display:flex;justify-content:space-between}
.gw .knowledge-card footer button{border:0;background:none;color:#386b5e;padding:3px;font-size:11px}
.gw .card-evidence{color:#6f8c7d;font-size:10px}.gw .resize-card{touch-action:none;cursor:nwse-resize}
.gw .selection-box{position:absolute;border:1px solid #1b6a70;background:#54a2a222;pointer-events:none}
.gw .board-empty{position:absolute;top:38%;left:50%;transform:translateX(-50%);text-align:center;max-width:360px;width:80%;color:#688075;pointer-events:none}
.gw .board-empty h3{font:700 20px Georgia,"Noto Serif SC",serif;color:#335b4c}.gw .board-empty p{font-size:12px;line-height:1.8}
.gw .wiki button:focus-visible,.gw .wiki [tabindex]:focus-visible{outline:2px solid #267c84;outline-offset:2px}
.gw .wiki .search input{color:#000}.gw .wiki .controls button{min-height:0;font-weight:400;line-height:1.5;padding:1px 6px}
@container wiki (max-width:1260px){.gw .wiki .banner{padding:0 14px}.gw .wiki .doc-head{padding:16px}.gw .wiki .doc-content{padding:15px}.gw .wiki .graph-top{padding:0 12px}.gw .wiki .workspace{grid-template-columns:200px minmax(0,1fr) 288px}}
@container wiki (max-width:1000px){.gw .wiki .workspace{grid-template-columns:192px minmax(0,1fr)}.gw .wiki .right{display:none;top:65px;bottom:0;right:0;width:min(370px,90%);position:absolute;z-index:8;box-shadow:-12px 0 22px #17292114}.gw .wiki .right.mobile-open{display:flex}.gw .wiki .mobile-detail{display:inline-flex}.gw .wiki .graph-col{grid-column:2}.gw .wiki .graph-title small{display:none}}
@container wiki (max-width:650px){.gw .wiki .workspace{grid-template-columns:1fr}.gw .wiki .graph-col{grid-column:1}.gw .wiki .left{display:none}.gw .wiki .left.mobile-open{display:flex;position:absolute;left:0;top:65px;bottom:0;width:min(280px,90%);z-index:9;box-shadow:12px 0 22px #17292114}.gw .wiki .mobile-directory{display:inline-flex}.gw .wiki .banner{padding:0 14px;gap:4px}.gw .wiki .banner h1{font-size:17px}.gw .wiki .banner p,.gw .wiki .banner .chip{display:none}.gw .wiki .banner .action{font-size:10px;padding:6px}.gw .wiki .banner-right{gap:4px}.gw .wiki .graph-top{padding:0 12px;height:60px;flex-shrink:0;gap:5px}.gw .wiki .corner{padding:8px}.gw .wiki .legend{gap:4px}.gw .wiki .tabs button{padding:7px 10px;font-size:12px}}
@media(prefers-reduced-motion:reduce){.gw .wiki *{transition:none!important}}
`;
