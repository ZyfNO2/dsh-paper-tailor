/**
 * 统一详情抽屉：三个工作区共用同一个 scope 与同一套详情。
 *
 * Redesign plan §3.1: “点论文 → 关联模块 → 关联组合 → 实验节点可以往返，返回
 * 保留当前任务与选中对象”. The drawer is where the evidence the first screen
 * deliberately omits lives: per-seed raw values, deltas, first error, protocol
 * and report refs, owners, revisions and hashes.
 *
 * Cross-workspace navigation happens through the callbacks, so a paper opened
 * from a module row can jump to that module, and a module with a real trial can
 * jump to its graph node — all without leaving the drawer.
 */

import type {
  GraphNode,
  ModuleCard,
  PaperCard,
  WorkbenchSnapshot,
} from '../wire.ts';
import {
  executionLabel,
  formatImprovement,
  formatRaw,
  formatValue,
  measurementLabel,
} from './format.ts';
import { s } from './styles.ts';

export interface DetailDrawerProps {
  /** Changes when the task changes; forces the drawer to re-key and clear. */
  regionKey: string;
  node: GraphNode | null;
  module: ModuleCard | null;
  paper: PaperCard | null;
  snapshot: WorkbenchSnapshot | null;
  modules: ModuleCard[];
  onClose: () => void;
  onOpenNode: (nodeId: string) => void;
  onOpenPaper: (paperId: string) => void;
  onOpenModule: (moduleId: string) => void;
}

export function DetailDrawer(props: DetailDrawerProps): JSX.Element | null {
  if (props.node === null && props.module === null && props.paper === null) {
    return (
      <aside className={s.drawer} aria-label="详情">
        <div className={s.empty}>选中图节点、模块或论文查看详情。</div>
      </aside>
    );
  }

  return (
    <aside className={s.drawer} aria-label="详情" key={props.regionKey}>
      <div className={s.drawerHead}>
        <button type="button" className={s.closeBtn} onClick={props.onClose} aria-label="关闭详情">×</button>
        {props.node !== null && <NodeDetail {...props} node={props.node} />}
        {props.module !== null && <ModuleDetail {...props} module={props.module} />}
        {props.paper !== null && <PaperDetail {...props} paper={props.paper} />}
      </div>
    </aside>
  );
}

function NodeDetail(props: DetailDrawerProps & { node: GraphNode }): JSX.Element {
  const n = props.node;
  return (
    <div className={s.drawerBody}>
      <h2 className={s.drawerTitle}>{n.displayName}</h2>
      <div className={s.dim}>
        执行 {executionLabel(n.executionStatus)} · 测量 {measurementLabel(n.measurementStatus)} · {n.summary}
      </div>

      {n.comparisons.length > 0 && (
        <section className={s.drawerSection}>
          <h3 className={s.drawerHeading}>指标（相对 Baseline）</h3>
          <table className={s.table}>
            <thead>
              <tr>
                <th>指标</th><th>方向</th><th>值</th><th>Baseline</th><th>差值</th><th>配对</th>
              </tr>
            </thead>
            <tbody>
              {n.comparisons.map((c) => {
                const imp = formatImprovement(c);
                return (
                  <tr key={c.metricId}>
                    <td>{c.metricId}</td>
                    <td>{c.direction === 'minimize' ? '越低越好' : '越高越好'}</td>
                    <td>{formatValue(c.measuredValue, c.unit)}</td>
                    <td>{formatValue(c.referenceValue, c.unit)}</td>
                    <td className={({ good: s.toneGood, bad: s.toneBad, flat: s.toneFlat, none: s.toneNone })[imp.tone] ?? ''}>{imp.text}（{imp.verdict}）</td>
                    <td>{c.pairedSeedCount}/{c.expectedSeedCount}{c.complete ? '' : ' ⚠'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {n.comparisons.some((c) => c.limitation !== null) && (
            <ul className={s.dim}>
              {n.comparisons.filter((c) => c.limitation !== null).map((c) => (
                <li key={c.metricId}>{c.metricId}：{c.limitation}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Per-seed raw values: the evidence the first screen compresses away. */}
      {n.detail.metricRows.length > 0 && (
        <section className={s.drawerSection}>
          <h3 className={s.drawerHeading}>逐 seed 原始值</h3>
          <table className={s.table}>
            <thead>
              <tr><th>seed</th><th>指标</th><th>原值</th><th>单位</th><th>split</th><th>样本</th><th>校验</th></tr>
            </thead>
            <tbody>
              {n.detail.metricRows.map((r, i) => (
                <tr key={`${r.seed}-${r.metricId}-${i}`}>
                  <td>{r.seed}</td>
                  <td>{r.metricId}</td>
                  <td>{formatRaw(r.value)}</td>
                  <td>{r.unit}</td>
                  <td>{r.split}</td>
                  <td>{r.sampleCount}</td>
                  <td>{r.verified ? '已校验' : '未校验'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className={s.drawerSection}>
        <h3 className={s.drawerHeading}>组合与证据</h3>
        <dl className={s.kv}>
          <dt>Baseline</dt><dd>{n.baselineRef ?? '—'}</dd>
          <dt>模块</dt>
          <dd>
            {n.moduleRefs.length === 0 ? '—' : n.moduleRefs.map((id) => {
              const known = props.modules.find((m) => m.id === id);
              return (
                <button
                  key={id}
                  type="button"
                  className={s.linkBtn}
                  onClick={() => props.onOpenModule(id)}
                >
                  {known?.displayName ?? id}
                </button>
              );
            })}
          </dd>
          <dt>slot</dt><dd>{n.detail.slotId ?? '—'}</dd>
          <dt>可执行实现</dt><dd>{n.detail.executableRef ?? '—'}{n.detail.executableReadiness === null ? '' : `（${n.detail.executableReadiness}）`}</dd>
          <dt>协议</dt><dd>{n.detail.protocolRef ?? '—'}</dd>
          <dt>成本记录</dt><dd>{n.detail.costRef ?? '—'}</dd>
          <dt>操作</dt><dd>{n.operationRefs.join('、') || '—'}</dd>
          <dt>结果引用</dt><dd>{n.resultRefs.join('、') || '—'}</dd>
          <dt>校验引用</dt><dd>{n.verificationRefs.join('、') || '—'}</dd>
          <dt>报告</dt><dd>{n.detail.reportRefs.join('、') || '—'}</dd>
        </dl>
        {n.detail.firstError !== null && (
          <div className={s.opError}>首错：{n.detail.firstError}</div>
        )}
        {n.proposalRef === null && n.moduleRefs.length > 0 && (
          <div className={s.dim}>
            本节点没有 proposal/decision 引用，因此图上只画“同协议对照”，不画“已执行扩展”。
          </div>
        )}
      </section>
    </div>
  );
}

function ModuleDetail(props: DetailDrawerProps & { module: ModuleCard }): JSX.Element {
  const m = props.module;
  return (
    <div className={s.drawerBody}>
      <h2 className={s.drawerTitle}>{m.displayName}</h2>
      <div className={s.dim}>{ORIGIN_LABEL[m.origin]} · {m.status ?? '状态未知'}</div>

      <section className={s.drawerSection}>
        <h3 className={s.drawerHeading}>机制与来源</h3>
        <p>{m.mechanism ?? '来源未描述'}</p>
        {m.mechanismEvidenceRefs.length > 0 && (
          <div className={s.dim}>证据引用：{m.mechanismEvidenceRefs.join('、')}</div>
        )}
        {m.paperId !== null && (
          <div>
            来源论文：
            <button type="button" className={s.linkBtn} onClick={() => props.onOpenPaper(m.paperId as string)}>
              {m.paperTitle ?? m.paperId}
            </button>
          </div>
        )}
        {m.documentHash === null ? '' : <div className={s.dim}>documentHash {m.documentHash}</div>}
      </section>

      <section className={s.drawerSection}>
        <h3 className={s.drawerHeading}>接入状态</h3>
        <dl className={s.kv}>
          <dt>slot</dt><dd>{m.slotId ?? '未声明'}</dd>
          <dt>干预位置</dt><dd>{m.interventionAxis ?? '—'}</dd>
          <dt>修改对象</dt><dd>{m.modifies ?? '—'}</dd>
          <dt>期望输出</dt><dd>{m.expectedOutput ?? '—'}</dd>
          <dt>实现</dt><dd>{m.implementationRef ?? '缺实现'}{m.implementationReadiness === null ? '' : `（${m.implementationReadiness}）`}</dd>
          <dt>依托基线</dt><dd>{m.builtOnBaselines.join('、') || '—'}</dd>
          <dt>来源操作</dt><dd>{m.sourceOperationId ?? '—'}</dd>
        </dl>
        {m.missing.length > 0 && (
          <div className={s.opError}>具体缺项：{m.missing.join('；')}</div>
        )}
      </section>

      <section className={s.drawerSection}>
        <h3 className={s.drawerHeading}>本地效果（条件化）</h3>
        {m.conditionalResultRefs.length === 0 ? (
          <div className={s.dim}>
            该模块没有自己的 trial。组合结果属于组合节点，不作为单模块收益展示。
          </div>
        ) : (
          <ul className={s.dim}>
            {m.conditionalResultRefs.map((r) => (
              <li key={`${r.taskId}-${r.variantId}`}>
                在 {r.taskId} 的变体 {r.variantId} 下有实测：
                <button type="button" className={s.linkBtn} onClick={() => props.onOpenNode(r.nodeId)}>
                  定位到实验节点
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PaperDetail(props: DetailDrawerProps & { paper: PaperCard }): JSX.Element {
  const p = props.paper;
  const linkedModules = props.modules.filter((m) => m.paperId === p.paperId);
  return (
    <div className={s.drawerBody}>
      <h2 className={s.drawerTitle}>{p.title ?? `题目未知（${p.titleUnknownReason ?? '来源未提供'}）`}</h2>
      <div className={s.dim}>
        {p.paperId}
        {p.version === null ? '' : ` · ${p.version}`}
        {p.sourceGroup === null ? '' : ` · ${p.sourceGroup}`}
      </div>

      <section className={s.drawerSection}>
        <h3 className={s.drawerHeading}>资料范围</h3>
        <p>{p.materialScope ?? '未知'}（{p.availableSections.join('、') || '无分节信息'}）</p>
        {p.documentHash === null ? '' : (
          <div className={s.dim}>documentHash {p.documentHash}（同一 paperId 的不同版本按此区分）</div>
        )}
        {p.sourceUri === null ? null : (
          <div className={s.dim}>来源：{p.sourceUri}</div>
        )}
        <div className={s.dim}>导入运行：{p.runRef ?? '—'}</div>
      </section>

      <section className={s.drawerSection}>
        <h3 className={s.drawerHeading}>抽取的方法与基线</h3>
        {p.cardRefs.length === 0 ? (
          <div className={s.dim}>该论文没有抽取卡片记录。</div>
        ) : (
          <div className={s.dim}>卡片 {p.cardRefs.length} 个：模块 {p.moduleCardCount} · 基线 {p.baselineCardCount}</div>
        )}
        {linkedModules.length > 0 && (
          <ul className={s.chipList}>
            {linkedModules.map((m) => (
              <li key={`${m.origin}-${m.id}`}>
                <button type="button" className={s.chip} onClick={() => props.onOpenModule(m.id)}>
                  {m.displayName}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={s.drawerSection}>
        <h3 className={s.drawerHeading}>与当前任务的关系</h3>
        <div className={s.dim}>
          {props.snapshot === null
            ? '当前任务未加载。'
            : p.referencedByCurrentCandidate
              ? '本任务的候选引用了该论文的证据。'
              : '当前任务的候选未引用该论文；它仍可能包含裁缝铺里缺实现的模块。'}
        </div>
      </section>
    </div>
  );
}

const ORIGIN_LABEL: Record<string, string> = {
  p5_card: 'P5 卡片',
  phase2_pinned: '已固定实现',
  phase3_protocol: '本任务协议',
};