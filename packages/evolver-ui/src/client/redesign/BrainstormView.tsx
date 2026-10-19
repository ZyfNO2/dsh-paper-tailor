/**
 * BrainstormView — the contract in force, the latest generation state, and the
 * candidate cards.
 *
 * FE-02 §4: each card carries hypothesis / rationale / sources / proposed slot /
 * atomic change / validation plan / cost-risk / open questions. grounded and
 * exploratory are marked separately, and no score is synthesised when the data
 * has none. Selection and edits are emitted as events with stable ids; the
 * rendered selection always comes from the external snapshot, so a refresh shows
 * the persisted choice instead of component state (FE-02 §4, FE-R04).
 */
import { useState } from 'react';
import { Icon } from './icons.tsx';
import { Chip, ObjectLinkButton } from './controls.tsx';
import { StaleBanner, useWorkbench } from './WorkbenchView.tsx';
import { RevisionValue } from './Inspector.tsx';
import { ResearchStartPanel, useStartForm, type StartFormValue } from './ResearchStartPanel.tsx';
import {
  BRAINSTORM_RUN_META,
  EVIDENCE_STATE_META,
  IDEA_BASIS_META,
  IDEA_STATUS_META,
  brainstormResultText,
  contractStatusText,
  ideaBasisNote,
} from './view-utils.ts';
import {
  dedupeErrors, explainIdea, explainRunResult, failedRoundOptions, viewedRound, visibleRoundOptions,
} from './brainstorm-rounds.ts';
import type {
  BootstrapData,
  BrainstormRunView,
  ResearchContractView,
  ResearchIdeaView,
} from './view-model.ts';

/**
 * The chip for a run.
 *
 * A `completed` run that produced no candidates is NOT "已生成" — it is a real
 * empty result, and the chip must not congratulate it (FE-R03).
 */
function runChip(run: BrainstormRunView): { label: string; cls: string } {
  const meta = BRAINSTORM_RUN_META[run.status];
  if (run.status === 'completed' && run.ideaIds.length === 0) {
    // Not "已生成": an empty completed run is a real empty result.
    return { label: '本轮无候选', cls: 'rd-chip-yellow' };
  }
  return { label: meta.label, cls: meta.cls };
}

export function BrainstormView(props: {
  data: BootstrapData;
  hidden: boolean;
  generating: boolean;
  saving: boolean;
  probing: boolean;
  selecting?: boolean;
  /** Real host / generation failure, shown without dropping rendered results. */
  error: string | null;
  /** The newest request's receipt, in words (queued is never 已保存). */
  receipt: string | null;
  /** The user's own note being edited, keyed by stable idea id. */
  onEditIdea: (ideaId: string, revision: number, patch: { hypothesis?: string; validationPlan?: string; reviewNotes?: string }) => void;
  onToggleSelect: (ideaId: string, selected: boolean) => void;
  onGenerate: (retainPrevious: boolean) => void;
  onInitialize: (ideaIds: string[]) => void;
  onProbe: () => void;
  onSaveContract: (confirm: boolean, form: StartFormValue) => void;
  onSelectResearch: (researchId: string) => void;
}): JSX.Element {
  const { unavailableActions } = useWorkbench();
  const active = props.data.researches.find((r) => r.researchId === props.data.activeResearchId) ?? null;
  const [showStart, setShowStart] = useState(false);
  const [runFilter, setRunFilter] = useState<string>('latest');
  // The start form lives HERE, not inside the panel: collapsing the panel
  // unmounts it, and the spec requires the user's in-progress typing (and the
  // last saved version) to survive that (FE-02 §3).
  const { form: startForm, setForm: setStartForm } = useStartForm(active?.contract ?? null);

  const saveContract = (confirm: boolean, form: StartFormValue): void => {
    props.onSaveContract(confirm, form);
  };

  if (active === null) {
    // No research at all: the same entry point the empty work tree offers
    // (FE-02 §2) — not a mock page and not a hidden error.
    return (
      <div className="rd-bsEmpty">
        <div className="rd-state">
          <Icon name="bulb" size={38} color="#6f7681" />
          <div className="rd-stateTitle">还没有研究</div>
          <div style={{ maxWidth: 520 }}>
            先确定研究意图后才会生成候选方向。可以只写一句话保存草稿，未知项保持未确定。
          </div>
          <ResearchStartPanel
            contract={null}
            environment={[]}
            probing={props.probing}
            saving={props.saving}
            error={props.error}
            value={startForm}
            onChange={setStartForm}
            onProbe={props.onProbe}
            onSave={(draft, confirm) => saveContract(confirm, {
              question: draft.question ?? '', objective: draft.objective ?? '',
              baselineName: draft.baselineName ?? '', dataTarget: draft.dataTarget ?? '',
              metricTarget: draft.metricTarget ?? '', computeBudget: draft.computeBudget ?? '',
              timeBudget: draft.timeBudget ?? '', guardrails: (draft.guardrails ?? []).join('\n'),
            })}
          />
        </div>
      </div>
    );
  }

  const contract: ResearchContractView = active.contract;
  const runs = active.brainstormRuns;
  // BR-FE2: the WHOLE section reads from ONE resolved round — status, model, counts,
  // itemErrors and the candidate list never mix `latest` with the selected round.
  const viewed = viewedRound(runs, runFilter);
  const selectedRun: BrainstormRunView | null = viewed.run;
  // Selection is read from persisted state, never from this component's memory.
  const selectedIds = new Set(props.data.selectedIdeaIds);
  const runIdeas = selectedRun === null
    ? active.ideas
    : active.ideas.filter((i) => selectedRun.ideaIds.includes(i.ideaId));
  // Only a queued/running receipt needs the "not yet persisted" suffix; a final
  // one already says what happened.
  const receiptPending = props.receipt !== null
    && (props.receipt.startsWith('已提交') || props.receipt.startsWith('执行中'));

  return (
    <div className="rd-bsBody">
      <StaleBanner state={{ status: 'ready', reason: null }} />

      <section className="rd-panel rd-pad rd-bsHead">
        <div className="rd-row">
          <h2 style={{ margin: 0, fontSize: 17 }}>Brainstorm</h2>
          <span className="rd-dim">{active.title}</span>
          <span className="rd-spacer" />
          {props.data.researches.length > 1 && (
            <select className="rd-select" style={{ width: 200 }} value={active.researchId}
              onChange={(e) => props.onSelectResearch(e.target.value)} aria-label="切换研究">
              {props.data.researches.map((r) => (
                <option key={r.researchId} value={r.researchId}>{r.title}</option>
              ))}
            </select>
          )}
          <button className="rd-btn rd-btn-ghost" onClick={() => setShowStart(!showStart)} aria-expanded={showStart}>
            {showStart ? '收起研究意图' : '查看 / 编辑研究意图'}
          </button>
        </div>
        <div className="rd-dim" style={{ fontSize: 12.5 }}>{contractStatusText(contract)}</div>
        <div className="rd-dim" style={{ fontSize: 12.5 }}>
          知识范围：本工程论文库与已抽取组件（{props.data.slots.length} 个位置参与展示）
        </div>
        {showStart && (
          <ResearchStartPanel
            contract={contract}
            environment={active.environment}
            probing={props.probing}
            saving={props.saving}
            error={props.error}
            value={startForm}
            onChange={setStartForm}
            onProbe={props.onProbe}
            onSave={(draft, confirm) => saveContract(confirm, {
              question: draft.question ?? '', objective: draft.objective ?? '',
              baselineName: draft.baselineName ?? '', dataTarget: draft.dataTarget ?? '',
              metricTarget: draft.metricTarget ?? '', computeBudget: draft.computeBudget ?? '',
              timeBudget: draft.timeBudget ?? '', guardrails: (draft.guardrails ?? []).join('\n'),
            })}
          />
        )}
      </section>

      <section className="rd-panel rd-pad rd-bsRuns" aria-label="生成状态">
        <div className="rd-row">
          {/* BR-FE2: the header names the VIEWED round; everything below reads from it. */}
          <div className="rd-sectionTitle" style={{ minWidth: 0 }}>
            {viewed.kind === 'none' ? '生成状态' : `生成状态 · ${viewed.label}`}
          </div>
          <span className="rd-spacer" />
          {/* A queued run is never shown as "已生成" (FE-R04), and a completed
              run that produced NOTHING is not called 已生成 either: the chip
              follows the result, not just the status. */}
          {selectedRun !== null && (
            <Chip cls={runChip(selectedRun).cls}>{runChip(selectedRun).label}</Chip>
          )}
          <button className="rd-btn" disabled={props.generating}
            title={unavailableActions.generate_brainstorm}
            onClick={() => props.onGenerate(true)}>
            <Icon name="bulb" size={14} />
            {props.generating ? '生成中…' : '生成新一轮候选'}
          </button>
        </div>
        {/* The fallback notice: the newest round failed/empty, so an older round with
            candidates is shown instead — stated, never silent. */}
        {viewed.notice !== null && (
          <div className="rd-hint" style={{ fontSize: 12.5 }}>{viewed.notice}</div>
        )}
        {selectedRun !== null && (
          <div className="rd-dim" style={{ fontSize: 12.5 }}>
            {brainstormResultText(selectedRun, runIdeas)}
            {selectedRun.modelIdentity !== null && ` · 模型 ${selectedRun.modelIdentity}`}
          </div>
        )}
        {/* Plain-language result line (§8): what was saved, what failed, what next. */}
        {selectedRun !== null && (
          <div className="rd-dim" style={{ fontSize: 12.5 }}>{explainRunResult(selectedRun)}</div>
        )}
        {selectedRun !== null && selectedRun.itemErrors.length > 0 && (
          <div className="rd-reject">
            {dedupeErrors(selectedRun.itemErrors).slice(0, 3).map((e, i) => (
              <div key={`${e.code}-${e.ideaId ?? ''}-${i}`}>{e.code}：{e.message}</div>
            ))}
          </div>
        )}
        {/* A generation failure keeps the previously rendered candidates on
            screen and states the real reason (FE-R03/FE-R04). */}
        {props.error !== null && (
          <div className="rd-reject" role="alert">{props.error}</div>
        )}
        {/*
          The receipt for the newest request, rendered where it stays visible.
          A `queued` receipt is explicitly NOT 已保存: the page waits for the
          re-read before claiming persistence (FE-R04).
        */}
        {props.receipt !== null && (
          <div className={receiptPending ? 'rd-hint' : 'rd-receipt'} role="status">
            {props.receipt}
            {receiptPending ? '　结果以重新读取到的持久数据为准。' : ''}
          </div>
        )}
        {runs.length > 1 && (
          <div className="rd-row" style={{ flexWrap: 'wrap' }}>
            <span className="rd-dim" style={{ fontSize: 12.5 }}>历史轮次：</span>
            <button className="rd-fchip" aria-pressed={runFilter === 'latest'} onClick={() => setRunFilter('latest')}>最新</button>
            {visibleRoundOptions(runs).map((option) => (
              <button key={option.runId} className="rd-fchip" aria-pressed={runFilter === option.runId}
                onClick={() => setRunFilter(option.runId)} title={option.runId}>
                {option.label}
              </button>
            ))}
          </div>
        )}
        {/* Failed zero-candidate rounds collapse here — queryable, never crowding. */}
        {failedRoundOptions(runs).length > 0 && (
          <details className="rd-collapse">
            <summary>失败记录（{failedRoundOptions(runs).length}）</summary>
            <div className="rd-row" style={{ flexWrap: 'wrap' }}>
              {failedRoundOptions(runs).map((option) => (
                <button key={option.runId} className="rd-fchip" aria-pressed={runFilter === option.runId}
                  onClick={() => setRunFilter(option.runId)} title={`runId ${option.runId}`}>
                  {option.label}
                </button>
              ))}
            </div>
          </details>
        )}
      </section>

      {/* Zero candidates is a real result with a reason — never padded to five
          placeholder cards (FE-R03). */}
      {runIdeas.length === 0 ? (
        <div className="rd-state">
          <Icon name="bulb" size={34} color="#6f7681" />
          <div className="rd-stateTitle">本轮没有候选</div>
          <div style={{ maxWidth: 520 }}>
            {selectedRun?.emptyResultReason ?? '还没有生成记录。可点击“生成新一轮候选”开始。'}
          </div>
        </div>
      ) : (
        <div className="rd-bsCards">
          {runIdeas.map((i) => (
            <IdeaCard
              key={`${i.ideaId}@${i.revision}`}
              idea={i}
              selected={selectedIds.has(i.ideaId)}
              selecting={props.selecting}
              onToggle={(on) => props.onToggleSelect(i.ideaId, on)}
              onEdit={(patch) => props.onEditIdea(i.ideaId, i.revision, patch)}
            />
          ))}
        </div>
      )}

      <div className="rd-row rd-bsFoot">
        <span className="rd-dim" style={{ fontSize: 12.5 }}>
          {props.selecting ? `正在同步 ${props.data.selectedIdeaIds.length} 条选择…` : `已选择 ${props.data.selectedIdeaIds.length} 条（已保存）`}
        </span>
        <span className="rd-spacer" />
        <button className="rd-btn rd-btn-primary" disabled={props.selecting || props.data.selectedIdeaIds.length === 0}
          title={unavailableActions.initialize_research_graph}
          onClick={() => props.onInitialize(props.data.selectedIdeaIds)}>
          用所选方向初始化研究图
        </button>
      </div>
    </div>
  );
}

function IdeaCard(props: {
  idea: ResearchIdeaView;
  selected: boolean;
  selecting?: boolean;
  onToggle: (on: boolean) => void;
  onEdit: (patch: { hypothesis?: string; validationPlan?: string; reviewNotes?: string }) => void;
}): JSX.Element {
  const { idea } = props;
  const [editing, setEditing] = useState(false);
  const [hypothesis, setHypothesis] = useState(idea.hypothesis ?? '');
  const [validationPlan, setValidationPlan] = useState(idea.validationPlan ?? '');
  const [reviewNotes, setReviewNotes] = useState(idea.reviewNotes ?? '');
  const note = ideaBasisNote(idea);

  return (
    <article className={`rd-ideaCard${props.selected ? ' rd-selected' : ''}`} data-basis={idea.basis} data-status={idea.status}>
      <div className="rd-ideaHead">
        <input type="checkbox" checked={props.selected} disabled={props.selecting} aria-label={`选择 ${idea.title}`}
          onChange={(e) => props.onToggle(e.target.checked)} />
        <b className="rd-ideaTitle">{idea.title}</b>
        <span className="rd-spacer" />
        <Chip cls={IDEA_BASIS_META[idea.basis].cls} title={IDEA_BASIS_META[idea.basis].note}>
          {IDEA_BASIS_META[idea.basis].label}
        </Chip>
        <Chip cls={IDEA_STATUS_META[idea.status].cls}>{IDEA_STATUS_META[idea.status].label}</Chip>
      </div>

      <div className="rd-ideaBody">
        {/* BR-FE2 §8: the plain explanation first — what, why, what changes, how to verify.
            Technical rows stay below in the same card; ids/hashes stay in the foot. */}
        <div className="rd-ideaPlain">
          {explainIdea(idea).map((line, i) => (
            <p key={i} style={{ margin: '0 0 6px' }}>{line}</p>
          ))}
        </div>
        <details className="rd-collapse">
          <summary>技术详情</summary>
          <IdeaRow label="假设">{idea.hypothesis ?? <span className="rd-dim">未提供</span>}</IdeaRow>
          <IdeaRow label="理由">{idea.rationale ?? <span className="rd-dim">未提供</span>}</IdeaRow>
          <IdeaRow label="拟改位置">{idea.proposedSlot ?? <span className="rd-dim">未指定</span>}</IdeaRow>
          <IdeaRow label="原子改动">{idea.atomicChange ?? <span className="rd-dim">未指定</span>}</IdeaRow>
          <IdeaRow label="验证方式">{idea.validationPlan ?? <span className="rd-dim">待定</span>}</IdeaRow>
        </details>
        <IdeaRow label="目标指标">{idea.targetMetrics.length > 0
          ? idea.targetMetrics.join('、')
          : <span className="rd-dim">未设定，不填数值标准</span>}</IdeaRow>
        <IdeaRow label="成本 / 风险">{idea.costRisk ?? <span className="rd-dim">未评估</span>}</IdeaRow>
        {/* No score is invented when the data has none (FE-02 §4). */}
        {idea.pendingQuestions.length > 0 && (
          <IdeaRow label="待确认项">
            <ul className="rd-ideaList">
              {idea.pendingQuestions.map((q, idx) => <li key={`${idx}-${q}`}>{q}</li>)}
            </ul>
          </IdeaRow>
        )}
        <IdeaRow label="来源">
          {idea.evidenceRefs.length === 0 ? (
            <span className="rd-dim">无论文依据</span>
          ) : (
            <div className="rd-evidRefs">
              {idea.evidenceRefs.map((e, idx) => (
                <div key={`${e.contentHash ?? idx}-${idx}`} className="rd-evidRef">
                  <Chip cls={EVIDENCE_STATE_META[e.state].cls} title={e.stateReason ?? undefined}>
                    {EVIDENCE_STATE_META[e.state].label}
                  </Chip>
                  {e.link !== null && e.state === 'current' ? (
                    <ObjectLinkButton link={e.link} />
                  ) : (
                    // A stale/missing ref states its reason IN TEXT (a title
                    // tooltip is not a disclosure) and is never silently
                    // swapped for a same-named new component (FE-R07).
                    <span className="rd-dim">
                      {e.locator ?? '定位未知'}
                      {e.stateReason !== null && `（${e.stateReason}）`}
                    </span>
                  )}
                  {e.page !== null && <span className="rd-dim">第 {e.page} 页</span>}
                  {e.contentHash !== null && <RevisionValue value={e.contentHash} keep={8} label="内容 hash" />}
                </div>
              ))}
            </div>
          )}
        </IdeaRow>
        {note !== null && <div className="rd-hint">{note}</div>}
      </div>

      <div className="rd-row rd-ideaFoot">
        <span className="rd-dim" style={{ fontSize: 11.5 }}>
          {idea.ideaId} · 内容版本 {idea.revision}
          {/* The content hash is a long identity value: clipped here, full value
              copyable (FE-R07). */}
          {idea.contentHash !== null && <> · <RevisionValue value={idea.contentHash} keep={8} label="内容 hash" /></>}
          {idea.contractRevision !== null && ` · 依据 Contract 第 ${idea.contractRevision} 版`}
        </span>
        <span className="rd-spacer" />
        <button className="rd-linkBtn" onClick={() => setEditing(!editing)}>{editing ? '取消编辑' : '编辑我的意见'}</button>
      </div>

      {editing && (
        <div className="rd-ideaEdit">
          <div className="rd-field">
            <label>假设（你的修改）</label>
            <textarea className="rd-input" rows={2} value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} />
          </div>
          <div className="rd-field">
            <label>验证方式</label>
            <textarea className="rd-input" rows={2} value={validationPlan} onChange={(e) => setValidationPlan(e.target.value)} />
          </div>
          <div className="rd-field">
            <label>评审备注</label>
            <textarea className="rd-input" rows={2} value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} />
          </div>
          <div className="rd-row">
            <span className="rd-dim" style={{ fontSize: 12 }}>保存后内容版本递增；仅勾选不改变内容版本。</span>
            <span className="rd-spacer" />
            <button className="rd-btn" onClick={() => setEditing(false)}>取消</button>
            <button className="rd-btn rd-btn-primary" onClick={() => {
              props.onEdit({ hypothesis: hypothesis, validationPlan: validationPlan, reviewNotes: reviewNotes });
              setEditing(false);
            }}>保存修改</button>
          </div>
        </div>
      )}
    </article>
  );
}

function IdeaRow(props: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rd-ideaRow">
      <span className="rd-ideaLabel">{props.label}</span>
      <div className="rd-ideaValue">{props.children}</div>
    </div>
  );
}
