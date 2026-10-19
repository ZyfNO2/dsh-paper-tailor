import { useEffect, useState } from 'react';
import { useWorkbench } from './WorkbenchView.tsx';
import { BrainstormPage } from './BrainstormPage.tsx';
import { TailorShopView } from './TailorShopView.tsx';
import { PaperLibraryView } from './PaperLibraryView.tsx';
import { NODE_STATUS_META, PLANNING_STATUS_META } from './view-utils.ts';
import type { ResearchNodeView } from './view-model.ts';
import { newOperationId } from './research-actions.ts';
import { ResearchTeamPanel } from './ResearchTeamPanel.tsx';

const CSS = `
.rc-contract,.rc-inspector{max-height:450px;overflow:auto!important}.rc-contract>header{position:sticky;top:0;background:var(--rd-panel);z-index:1}
.rc{color:var(--rd-text);background:var(--rd-bg);font-size:12px;height:100%;min-height:0;overflow:auto;padding:12px;box-sizing:border-box}
.rc button{font:inherit;cursor:pointer;color:inherit}.rc button:disabled{cursor:wait;opacity:.55}.rc button:focus-visible{outline:2px solid var(--rd-blue);outline-offset:2px}
.rc-head{display:flex;align-items:center;gap:8px;margin-bottom:12px}.rc-title{flex:1;min-width:0}.rc-title strong{display:block;font-size:17px}.rc-muted{color:var(--rd-text-2);font-size:11px}.rc-btn{border:1px solid var(--rd-border-strong);border-radius:6px;padding:6px 10px;background:var(--rd-panel)}.rc-primary{background:var(--rd-blue);color:var(--rd-onAccent)!important;border-color:var(--rd-blue)}
.rc-stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-bottom:12px}.rc-stat{background:var(--rd-panel);border:1px solid var(--rd-border);border-radius:8px;text-align:left;padding:10px}.rc-stat b{font-size:17px;display:block;margin-bottom:3px}.rc-stat:hover,.rc-node:hover{border-color:var(--rd-blue)}
.rc-grid{display:grid;grid-template-columns:220px minmax(300px,1fr) 270px;gap:10px;align-items:stretch}.rc-card{background:var(--rd-panel);border:1px solid var(--rd-border);border-radius:8px;min-width:0;overflow:hidden}.rc-card header{padding:11px 12px;border-bottom:1px solid var(--rd-border);display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:650}.rc-section{padding:12px;border-bottom:1px solid var(--rd-border);line-height:1.65;overflow-wrap:anywhere}.rc-section:last-child{border:0}.rc-section h4{font-size:11px;color:var(--rd-text-2);margin:0 0 7px;font-weight:600}.rc-link{border:0;background:transparent;padding:0;text-align:left;color:var(--rd-blue)!important}.rc-tag{display:inline-block;border-radius:4px;background:var(--rd-blue-soft);padding:2px 6px;margin:3px 4px 0 0;font-size:10px}.rc-warning{color:var(--rd-yellow)}
.rc-flow{height:370px;overflow:auto;background-color:var(--rd-inset);background-image:radial-gradient(var(--rd-border-strong) .7px,transparent .7px);background-size:16px 16px}.rc-canvas{position:relative;min-height:350px}.rc-canvas svg{position:absolute;inset:0;pointer-events:none}.rc-node{position:absolute;width:194px;min-height:86px;text-align:left;border:1px solid var(--rd-border-strong);border-radius:8px;background:var(--rd-panel);padding:10px;box-shadow:0 2px 6px #00000008}.rc-node[aria-pressed=true]{border:2px solid var(--rd-blue);background:var(--rd-blue-soft)}.rc-node strong{display:block;max-height:36px;overflow:hidden;font-size:12px;margin:3px 0 7px}.rc-node small{display:block;color:var(--rd-text-2);font-size:10px}.rc-state{padding:25px;line-height:1.8;color:var(--rd-text-2)}
.rc-table{overflow:auto}.rc-table table{border-collapse:collapse;width:100%;white-space:nowrap;font-size:11px}.rc-table th{background:var(--rd-panel-2);color:var(--rd-text-2);text-align:left;font-weight:500}.rc-table th,.rc-table td{border-bottom:1px solid var(--rd-border);padding:9px 12px}.rc-table tr:hover td{background:var(--rd-blue-soft)}.rc-bottom{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:10px;margin-top:10px}.rc-activity{padding:10px 12px;display:flex;gap:10px;border-bottom:1px solid var(--rd-border);line-height:1.5}.rc-activity time{color:var(--rd-text-2);font-size:10px}.rc-alert{border:1px solid var(--rd-amber-border);background:var(--rd-amber-bg);padding:10px;border-radius:7px;margin-bottom:10px}
.rc-overlay{position:fixed;inset:40px 24px 24px;z-index:80;background:var(--rd-panel);color:var(--rd-text);border:1px solid var(--rd-border-strong);border-radius:12px;box-shadow:0 20px 100px #0005;display:flex;flex-direction:column}.rc-overlay header{padding:12px 18px;display:flex;justify-content:space-between;border-bottom:1px solid var(--rd-border)}.rc-overlay-body{overflow:auto;flex:1;min-height:0;padding:12px}.rc-overlay-body>.rd-library,.rc-overlay-body>.rd-tailor{height:100%}
@container dsh-workbench (max-width:1100px){.rc-grid{grid-template-columns:190px minmax(260px,1fr)}.rc-inspector{grid-column:1/-1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}.rc-inspector header{grid-column:1/-1}.rc-inspector .rc-section{border-right:1px solid var(--rd-border)}.rc-bottom{grid-template-columns:minmax(0,1fr) 240px}}
@container dsh-workbench (max-width:700px){.rc-grid{grid-template-columns:1fr}.rc-inspector{display:block}.rc-stats{grid-template-columns:repeat(3,minmax(0,1fr))}.rc-bottom{grid-template-columns:1fr}.rc-head{flex-wrap:wrap}.rc-title{flex-basis:100%}.rc-flow{height:300px}}
`;

function runStatus(node: ResearchNodeView): string {
  return NODE_STATUS_META[node.status]?.label ?? node.status;
}

/** A projection of existing persisted state; no generated sample nodes or metrics. */
export function ResearchCockpit(): JSX.Element {
  const { snapshot, research, activeNodeId, setActiveNodeId, navSignal, navigate, workspace, goToTab, emit } = useWorkbench();
  const [cyclePending, setCyclePending] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<'brainstorm' | 'papers' | 'tailor' | null>(null);
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const bootstrap = snapshot.bootstrap?.data;
  const active = bootstrap?.researches.find((r) => r.researchId === bootstrap.activeResearchId);
  const contract = active?.contract;
  const sourceNodes = snapshot.tree.data?.nodes ?? [];
  const columns = [...new Set(sourceNodes.map((n) => n.x))].sort((a, b) => a - b);
  const minY = sourceNodes.length ? Math.min(...sourceNodes.map((n) => n.y)) : 0;
  const nodes = sourceNodes.map((n) => ({ ...n, x: 16 + columns.indexOf(n.x) * 224, y: 24 + n.y - minY }));
  const selected = nodes.find((n) => n.id === activeNodeId) ?? nodes.find((n) => n.kind === 'baseline') ?? nodes[0];
  const selectedIdea = active?.ideas.find((i) => i.ideaId === selected?.ideaRef);
  const cycle = snapshot.cycle;
  const runningCycle = cycle?.runs.find((r) => ['queued', 'running', 'waiting_result', 'cancelling'].includes(r.status));
  const runCycle = async (ideaId: string) => {
    if (!cycle || !bootstrap) return;
    setCyclePending(true);
    try { await emit({ type: 'start_cycle', researchId: cycle.research.researchId, baseRevision: bootstrap.revision, cycleRevision: cycle.research.cycleRevision, operationId: newOperationId('cycle'), selectedIdeaId: ideaId }); }
    finally { setCyclePending(false); }
  };
  const papers = snapshot.papers.data?.papers ?? [];
  const experiments = snapshot.papers.data?.experiments ?? [];
  const selectedRun = experiments.find((e) => e.experimentKey === runId);
  const branches = nodes.filter((n) => n.kind === 'hypothesis');
  const activity = snapshot.tree.data?.activity ?? [];
  const metrics = [...new Set(experiments.flatMap((e) => e.metricRows.map((m) => m.name)))];
  const sources = papers.reduce((total, p) => total + p.wikiLinks.length, 0);
  const components = snapshot.tailor.data?.components ?? [];
  const width = Math.max(600, ...nodes.map((n) => n.x + 224));
  const height = Math.max(350, ...nodes.map((n) => n.y + 120));
  useEffect(() => { setOverlay(workspace === 'tree' ? null : workspace); }, [workspace]);
  useEffect(() => {
    if (!navSignal) return;
    const { target } = navSignal;
    if (target.kind === 'paper' || target.kind === 'wiki' || target.kind === 'contribution') setOverlay('papers');
    else if (target.kind === 'component') setOverlay('tailor');
    else if (nodes.some((n) => n.id === target.key)) setActiveNodeId(target.key);
  }, [navSignal]);
  useEffect(() => {
    if (!overlay) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOverlay(null); goToTab('tree'); } };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [overlay]);
  const baselineEvidence = contract?.baseline.paperRef ? '已关联文献' : contract?.baseline.name ? '已记录候选' : '未知';
  const next = () => {
    if (!contract || !(bootstrap?.selectedIdeaIds.length)) setOverlay('brainstorm');
    else if (!nodes.length) void research.initialize(bootstrap.selectedIdeaIds, contract.revision);
    else if (selected?.ideaRef && cycle && bootstrap.selectedIdeaIds.includes(selected.ideaRef)) void runCycle(selected.ideaRef);
    else setOverlay('tailor');
  };
  return <div className="rc" data-research-cockpit>
    <style>{CSS}</style>
    <div className="rc-head"><div className="rc-title"><strong>{active?.title ?? snapshot.task.displayName ?? 'Research Workspace'}</strong><span className="rc-muted">研究目标、证据、流程与结果 · 自动同步 · 规划与运行分别记录</span></div>
      {bootstrap && bootstrap.researches.length > 1 && <select aria-label="切换研究" value={bootstrap.activeResearchId ?? ''} onChange={(e) => void research.selectResearch(e.target.value)}>{bootstrap.researches.map((r) => <option key={r.researchId} value={r.researchId}>{r.title}</option>)}</select>}
      <button className="rc-btn" onClick={() => setOverlay('brainstorm')}>＋ Brainstorm</button><button className="rc-btn rc-primary" onClick={next} disabled={research.isPending('initialize') || cyclePending || !!runningCycle}>推进下一步 →</button>
    </div>
    <div className="rc-stats">
      {[
        { label: '论文 / Wiki 条目', value: `${papers.length} / ${sources}`, action: () => setOverlay('papers') },
        { label: 'Baseline · 复现仍需实验依据', value: contract?.baseline.name ? contract.baseline.status === 'confirmed' ? '1 个已选基线' : '1 个候选' : '未确定', action: () => { const n = nodes.find((n) => n.kind === 'baseline'); if (n) setActiveNodeId(n.id); else setOverlay('brainstorm'); } },
        { label: '研究分支 / 实验', value: `${branches.length} / ${experiments.length}`, action: () => document.getElementById('rc-matrix')?.scrollIntoView({ block: 'nearest' }) },
        { label: '研究组件', value: String(components.length), action: () => setOverlay('tailor') },
        { label: '待解决事项', value: String(snapshot.preconditions.length + (contract?.pendingQuestions.length ?? 0)), action: () => setOverlay('brainstorm') },
      ].map((s) => <button className="rc-stat" key={s.label} onClick={s.action}><b>{s.value}</b><span className="rc-muted">{s.label}</span></button>)}
    </div>
    {snapshot.bootstrap?.state.status === 'error' && <div className="rc-alert" role="alert">研究状态读取失败：{snapshot.bootstrap.state.reason}</div>}
    <div className="rc-grid">
      <aside className="rc-card rc-contract"><header>Research Contract<button className="rc-btn" onClick={() => setOverlay('brainstorm')}>编辑</button></header>
        <div className="rc-section"><h4>研究问题 / 目标</h4>{contract?.question ?? contract?.objective ?? '先整理已有研究输入，未知项保留为空。'}</div>
        <div className="rc-section"><h4>Baseline</h4><button className="rc-link" onClick={() => contract?.baseline.paperRef ? navigate(contract.baseline.paperRef) : setOverlay('brainstorm')}>{contract?.baseline.name ?? '未确定'}</button><div><span className="rc-tag">{baselineEvidence}</span><span className="rc-tag">复现：{nodes.some((n) => n.kind === 'baseline' && n.status === 'done') ? '已记录来源结果' : '未知'}</span></div></div>
        <div className="rc-section"><h4>候选方向</h4>{active?.ideas.length ? active.ideas.map((idea) => <button key={idea.ideaId} className="rc-link" style={{ display: 'block', marginBottom: 6 }} onClick={() => { const n = nodes.find((n) => n.ideaRef === idea.ideaId); if (n) setActiveNodeId(n.id); else setOverlay('brainstorm'); }}>{idea.title}<span className="rc-tag">{idea.status === 'selected' ? '已选' : '候选'}</span></button>) : '尚无候选方向'}</div>
        <div className="rc-section"><h4>数据 / 指标</h4>{contract?.dataTarget ?? '数据未记录'}<div>{contract?.metricTarget ?? '指标未记录'}</div></div>
        <div className="rc-section"><h4>约束 / 预算</h4>{contract?.guardrails.join('；') || '约束未记录'}<div>{contract?.computeBudget ?? '计算预算未知'} · {contract?.timeBudget ?? '时间预算未知'}</div></div>
        <div className="rc-section"><h4>知识与证据</h4><button className="rc-link" onClick={() => setOverlay('papers')}>打开 {papers.length} 篇论文 · {sources} 条 Wiki</button><div><button className="rc-link" onClick={() => setOverlay('tailor')}>打开 {components.length} 个组件 / 裁缝铺</button></div></div>
      </aside>
      <section className="rc-card"><header><span>Research Flow / DAG</span><div><button className="rc-btn" aria-pressed={view === 'graph'} onClick={() => setView('graph')}>流程图</button> <button className="rc-btn" aria-pressed={view === 'list'} onClick={() => setView('list')}>列表</button></div></header>
        {!nodes.length ? <div className="rc-state"><strong>从已有证据继续研究</strong><p>已登记的知识和候选方向会保留。选择方向后，按当前 Contract 合并研究流程。</p><button className="rc-btn rc-primary" onClick={next}>整理研究输入 →</button></div> : view === 'graph' ? <div className="rc-flow"><div className="rc-canvas" style={{ width, height }}>
          <svg width={width} height={height}><defs><marker id="rc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--rd-text-3)" /></marker></defs>{snapshot.tree.data?.edges.map((edge) => {
            // Stored depends_on edges name dependent → prerequisite; the cockpit
            // shows the forward research flow prerequisite → dependent.
            const dependency = edge.relation.startsWith('依赖');
            const from = nodes.find((n) => n.id === (dependency ? edge.targetId : edge.sourceId)), to = nodes.find((n) => n.id === (dependency ? edge.sourceId : edge.targetId));
            if (!from || !to) return null;
            return <path key={edge.id} d={`M ${from.x + 194} ${from.y + 44} C ${from.x + 215} ${from.y + 44},${to.x - 20} ${to.y + 44},${to.x} ${to.y + 44}`} fill="none" stroke="var(--rd-text-3)" strokeWidth="1.3" strokeDasharray={edge.planned ? '4 3' : undefined} markerEnd="url(#rc-arrow)" />;
          })}</svg>{nodes.map((node) => <button className="rc-node" key={node.id} aria-pressed={selected?.id === node.id} onClick={() => setActiveNodeId(node.id)} style={{ left: node.x, top: node.y }}><span className="rc-tag">{node.kind === 'baseline' ? '基线' : node.kind === 'hypothesis' ? '待验证分支' : node.kind === 'goal' ? '目标' : node.kind === 'protocol' ? '协议' : node.kind}</span><strong>{node.title}</strong><small>{runStatus(node)} · {node.links.length} 个引用</small><small>{node.planningStatus ? PLANNING_STATUS_META[node.planningStatus]?.label : '规划未记录'}</small></button>)}</div></div> : <div className="rc-table"><table><thead><tr><th>节点</th><th>运行</th><th>规划</th><th>引用</th></tr></thead><tbody>{nodes.map((n) => <tr key={n.id}><td><button className="rc-link" onClick={() => setActiveNodeId(n.id)}>{n.title}</button></td><td>{runStatus(n)}</td><td>{n.planningStatus ? PLANNING_STATUS_META[n.planningStatus]?.label : '—'}</td><td>{n.links.length}</td></tr>)}</tbody></table></div>}
        <div className="rc-section rc-muted">节点来自持久研究状态；文献支持、规划完成与真实实验完成分别展示。</div>
      </section>
      <aside className="rc-card rc-inspector"><header>Node / Evidence Inspector</header>
        <div className="rc-section"><h4>当前节点</h4><strong>{selected?.title ?? '点击流程节点查看详情'}</strong><div><span className="rc-tag">{selected ? runStatus(selected) : '未选择'}</span></div><p>{selected?.summary}</p>{selected?.outcome && <p>{selected.outcome}</p>}{selected?.rationale && <div className="rc-warning">{selected.rationale}</div>}</div>
        <div className="rc-section"><h4>研究理由 / 验证方法</h4>{selected?.ideaRef && cycle && <button className="rc-btn rc-primary" disabled={cyclePending || !!runningCycle || cycle.runtime?.available === false || !bootstrap?.selectedIdeaIds.includes(selected.ideaRef)} onClick={() => void runCycle(selected.ideaRef!)}>启动 Agent Team · 分析已有证据</button>}{selectedIdea?.rationale ?? '没有已记录的研究理由'}<p>{selectedIdea?.validationPlan ?? '验证方法尚未记录'}</p></div>
        <div className="rc-section"><ResearchTeamPanel nodeId={selected?.id} /></div>
        {selectedRun && <div className="rc-section"><h4>运行结果 · {selectedRun.experimentKey}</h4>{selectedRun.metricRows.map((m) => <div key={m.name}>{m.name}: <strong>{m.value ?? '—'}</strong></div>)}<p className="rc-muted">{selectedRun.diagnostics}</p>{selectedRun.evidenceLinks.map((a) => <div key={a.key}><a className="rc-link" download href={`/evolver/research-bootstrap/artifacts?sessionId=${encodeURIComponent(snapshot.task.taskKey)}&runId=${encodeURIComponent(selectedRun.experimentKey)}&role=${encodeURIComponent(a.label.split(':')[0])}`}>{a.label}</a></div>)}</div>}
        <div className="rc-section"><h4>关联证据 / 方案</h4>{cycle?.artifacts.filter((a) => selected?.links.some((l) => l.key === a.ref.id)).map((a) => <div key={a.artifactId}><a className="rc-link" target="_blank" rel="noreferrer" href={`/evolver/research-cycle/artifacts?sessionId=${encodeURIComponent(snapshot.task.taskKey)}&researchId=${encodeURIComponent(cycle.research.researchId)}&id=${encodeURIComponent(a.ref.id)}&sha256=${encodeURIComponent(a.ref.sha256)}`}>{a.kind} · 已登记产物</a></div>)}{selectedIdea?.evidenceRefs.map((ref, i) => <div key={i}>{ref.link ? <button className="rc-link" onClick={() => navigate(ref.link!)}>{ref.link.label} · 第 {ref.page ?? '?'} 页</button> : ref.locator}<div className="rc-muted">{ref.state} · {ref.quote}</div></div>)}{selected?.links.filter((l) => l.kind !== 'external').map((link) => <div key={link.key}><button className="rc-link" onClick={() => navigate(link)}>{link.label}</button></div>)}<button className="rc-btn" onClick={() => setOverlay('tailor')}>查看输入输出 / 编辑组件</button> <button className="rc-btn" onClick={() => setOverlay('papers')}>查看证据库</button></div>
      </aside>
    </div>
    <div className="rc-bottom"><section className="rc-card" id="rc-matrix"><header>Experiment Matrix <span className="rc-muted">{experiments.length} 个实验 · {branches.length} 条待验证分支</span></header><div className="rc-table"><table><thead><tr><th>实验 / 分支</th><th>状态</th><th>验证</th>{metrics.map((m) => <th key={m}>{m}</th>)}<th>证据</th></tr></thead><tbody>{experiments.map((e) => <tr key={e.experimentKey}><td><button className="rc-link" onClick={() => { setRunId(e.experimentKey); if (e.schemeKey) setActiveNodeId(e.schemeKey); }}>{e.label}</button></td><td>{e.status}</td><td>{e.verificationStatus}</td>{metrics.map((m) => <td key={m}>{e.metricRows.find((v) => v.name === m)?.value ?? '—'}</td>)}<td><button className="rc-link" onClick={() => setOverlay('papers')}>{e.evidenceLinks.length} 个引用</button></td></tr>)}{branches.map((n) => <tr key={n.id}><td><button className="rc-link" onClick={() => setActiveNodeId(n.id)}>{n.title}</button></td><td>{runStatus(n)}</td><td>尚未实验验证</td>{metrics.map((m) => <td key={m}>—</td>)}<td>{active?.ideas.find((i) => i.ideaId === n.ideaRef)?.evidenceRefs.length ?? 0} 个来源</td></tr>)}</tbody></table>{!experiments.length && !branches.length && <div className="rc-state">暂无实验或已选分支。已有论文与组件可直接查看，实验指标保持未知。</div>}</div></section>
      <section className="rc-card"><header>Recent Activity / Team</header><div className="rc-section"><ResearchTeamPanel /></div>{cycle?.decisions.slice(-1).map((d, i) => <details className="rc-section" key={i}><summary style={{ cursor: 'pointer' }}>Reviewer · {d.decision} · {d.nextActions?.length ?? 0} 项后续建议</summary><div style={{ maxHeight: 260, overflow: 'auto' }}><p>{d.reason}</p>{d.nextActions?.map((a) => <details key={a.actionId}><summary>{a.title}</summary><p>{a.detail}</p></details>)}</div><p className="rc-muted">建议已保存；尚未自动执行。</p></details>)}{activity.slice(-6).reverse().map((a) => <div className="rc-activity" key={a.id}><span>●</span><div>{a.action}<div className="rc-muted">{a.result}</div><time>{a.time}</time></div></div>)}{!activity.length && <div className="rc-section rc-muted">没有已记录的运行事件</div>}{snapshot.preconditions.map((p) => <div key={p.id} className="rc-section rc-warning">{p.text}</div>)}</section></div>
    {overlay && <div className="rc-overlay" role="dialog" aria-modal="true" aria-label={overlay === 'brainstorm' ? '研究设置与 Brainstorm' : overlay === 'papers' ? '知识与证据' : '组件裁缝铺'}><header><strong>{overlay === 'brainstorm' ? '研究设置 · Brainstorm' : overlay === 'papers' ? '知识 / Wiki / 原文证据' : '裁缝铺 · Research Components'}</strong><button className="rc-btn" autoFocus onClick={() => { setOverlay(null); goToTab('tree'); }}>关闭 ×</button></header><div className="rc-overlay-body">{overlay === 'brainstorm' ? <BrainstormPage hidden={false} /> : overlay === 'papers' ? <PaperLibraryView region={snapshot.papers} hidden={false} /> : <TailorShopView region={snapshot.tailor} hidden={false} />}</div></div>}
  </div>;
}
