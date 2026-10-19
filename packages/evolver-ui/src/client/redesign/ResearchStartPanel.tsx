/**
 * ResearchStartPanel — collect the research intent and show the real probe area.
 *
 * FE-02 §3: grouped collection (direction / baseline / data+metric / budget+
 * guardrails), one sentence is enough to save a draft, unknown fields stay
 * undecided, and the environment block shows REAL observations with their host
 * and time — never a static UI device value.
 *
 * This component owns only FORM state (what the user is typing right now). Saved
 * research data comes from the external snapshot, so a refresh shows the truth
 * rather than a stale local copy (FE-02 §4).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { Chip } from './controls.tsx';
import { useWorkbench } from './WorkbenchView.tsx';
import {
  ENVIRONMENT_STATUS_META,
  baselineStatusText,
  canSaveContract,
  contractStatusText,
  environmentSummaryText,
} from './view-utils.ts';
import type {
  EnvironmentObservationView,
  ResearchContractDraft,
  ResearchContractView,
} from './view-model.ts';

export interface StartFormValue {
  question: string;
  objective: string;
  baselineName: string;
  dataTarget: string;
  metricTarget: string;
  computeBudget: string;
  timeBudget: string;
  guardrails: string;
}

export function formFromContract(c: ResearchContractView | null): StartFormValue {
  if (c === null) {
    return { question: '', objective: '', baselineName: '', dataTarget: '', metricTarget: '', computeBudget: '', timeBudget: '', guardrails: '' };
  }
  return {
    question: c.question ?? '',
    objective: c.objective ?? '',
    baselineName: c.baseline.name ?? '',
    dataTarget: c.dataTarget ?? '',
    metricTarget: c.metricTarget ?? '',
    computeBudget: c.computeBudget ?? '',
    timeBudget: c.timeBudget ?? '',
    guardrails: c.guardrails.join('\n'),
  };
}

/** Empty text fields become null, so "未填" and "填了空串" are the same fact. */
export function draftFromForm(v: StartFormValue): ResearchContractDraft {
  const blank = (s: string): string | null => (s.trim() === '' ? null : s.trim());
  return {
    question: blank(v.question),
    objective: blank(v.objective),
    baselineName: blank(v.baselineName),
    dataTarget: blank(v.dataTarget),
    metricTarget: blank(v.metricTarget),
    computeBudget: blank(v.computeBudget),
    timeBudget: blank(v.timeBudget),
    guardrails: v.guardrails.split('\n').map((s) => s.trim()).filter((s) => s !== ''),
  };
}

/**
 * The start form, owned by the PAGE (not the panel).
 *
 * The panel is collapsible, so it unmounts; if it owned the form the user's
 * in-progress typing would be lost on every collapse — and re-seeding from the
 * saved contract on mount would silently discard a draft the user had not saved
 * yet. Seeding happens HERE, once per research, and deliberately NOT on every
 * contract revision: our own save bumps the revision, and re-seeding then would
 * wipe what was just typed (FE-02 §3: 不能每次打开清空让用户重填 / 错误时保留正在输入的表单).
 */
export function useStartForm(contract: ResearchContractView | null): {
  form: StartFormValue;
  setForm: (v: StartFormValue) => void;
} {
  const [form, setForm] = useState<StartFormValue>(() => formFromContract(contract));
  const loadedId = useRef<string | null>(contract?.researchId ?? null);

  useEffect(() => {
    const id = contract?.researchId ?? null;
    if (loadedId.current === id) return;
    loadedId.current = id;
    setForm(formFromContract(contract));
  }, [contract?.researchId, contract]);

  return { form, setForm };
}

export function ResearchStartPanel(props: {
  contract: ResearchContractView | null;
  environment: EnvironmentObservationView[];
  probing: boolean;
  saving: boolean;
  error: string | null;
  /**
   * The form is CONTROLLED: what the user is typing right now belongs to the
   * caller, so collapsing the panel (or a failed save) never discards it
   * (FE-02 §3: 错误时保留正在输入的表单和最后已保存版本).
   */
  value: StartFormValue;
  onChange: (v: StartFormValue) => void;
  onProbe: () => void;
  onSave: (draft: ResearchContractDraft, confirm: boolean) => void;
}): JSX.Element {
  const { unavailableActions } = useWorkbench();
  const saved = props.contract;
  const form = props.value;

  // Purely controlled: seeding is the owner's job (see useStartForm), so this
  // panel never overwrites the user's typing — not on mount, and not on a
  // re-mount after a collapse.
  const patch = (p: Partial<StartFormValue>): void => {
    props.onChange({ ...form, ...p });
  };

  const draft = useMemo(() => draftFromForm(form), [form]);
  const savable = canSaveContract(draft);
  const dirty = useMemo(
    () => JSON.stringify(draftFromForm(formFromContract(saved))) !== JSON.stringify(draft),
    [form, saved],
  );

  return (
    <div className="rd-startGrid">
      <section className="rd-panel rd-pad rd-startMain">
        <div className="rd-row">
          <h2 style={{ margin: 0, fontSize: 17 }}>研究启动</h2>
          <span className="rd-spacer" />
          {/* Fixed for this round: the panel offers no switch to run anything. */}
          <Chip tone="gray" title="本阶段只做规划，不执行实验">只规划，不执行实验</Chip>
        </div>

        {saved !== null && (
          <div className="rd-dim" style={{ fontSize: 12.5 }}>
            {contractStatusText(saved)}
            {dirty && <span className="rd-unsaved"> · 有未保存的本地修改</span>}
          </div>
        )}

        <div className="rd-field">
          <label>研究问题 / 方向（一句话即可保存草稿）</label>
          <textarea className="rd-input" rows={2} value={form.question}
            placeholder="例如：验证边界感知损失在轮廓分割任务中的作用"
            onChange={(e) => patch({ question: e.target.value })} />
        </div>

        <fieldset className="rd-group">
          <legend>研究目标</legend>
          <textarea className="rd-input" rows={2} value={form.objective}
            placeholder="选填：想回答什么问题"
            onChange={(e) => patch({ objective: e.target.value })} />
        </fieldset>

        <fieldset className="rd-group">
          <legend>Baseline</legend>
          <div className="rd-dim" style={{ fontSize: 12.5 }}>
            {saved === null ? 'Baseline 未确定' : baselineStatusText(saved.baseline)}
          </div>
          <input className="rd-input" value={form.baselineName} placeholder="已选 / 候选 Baseline 名称（可留空）"
            onChange={(e) => patch({ baselineName: e.target.value })} />
          <div className="rd-dim" style={{ fontSize: 12 }}>
            未确定也能保存草稿；确认后再生成领域结构。论文 Baseline 不等于你确认的 Baseline。
          </div>
        </fieldset>

        <fieldset className="rd-group">
          <legend>数据 / 目标指标</legend>
          <input className="rd-input" value={form.dataTarget} placeholder="数据目标描述（不填路径，不造数据集）"
            onChange={(e) => patch({ dataTarget: e.target.value })} />
          <input className="rd-input" value={form.metricTarget} placeholder="目标指标描述（不填具体数值标准）"
            onChange={(e) => patch({ metricTarget: e.target.value })} />
        </fieldset>

        <fieldset className="rd-group">
          <legend>预算 / 禁区</legend>
          <div className="rd-row">
            <input className="rd-input" value={form.computeBudget} placeholder="算力预算（选填）"
              onChange={(e) => patch({ computeBudget: e.target.value })} />
            <input className="rd-input" value={form.timeBudget} placeholder="时间预算（选填）"
              onChange={(e) => patch({ timeBudget: e.target.value })} />
          </div>
          <textarea className="rd-input" rows={2} value={form.guardrails} placeholder="禁区 / 约束（每行一条，选填）"
            onChange={(e) => patch({ guardrails: e.target.value })} />
          <div className="rd-dim" style={{ fontSize: 12 }}>填了预算也不会启用实验运行；本阶段没有自动运行开关。</div>
        </fieldset>

        {savable.reason !== null && <div className="rd-hint">{savable.reason}</div>}
        {props.error !== null && <div className="rd-reject">{props.error}</div>}

        <div className="rd-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="rd-btn" disabled={props.saving || !savable.ok}
            title={savable.reason ?? undefined}
            onClick={() => props.onSave(draft, false)}>
            {props.saving ? '保存中…' : '保存草稿'}
          </button>
          {/* Confirming is the USER's action: the panel emits it, it never
              infers confirmation from a filled form (shared spec §3). */}
          <button className="rd-btn rd-btn-primary" disabled={props.saving || !savable.ok}
            title={unavailableActions.save_research_contract ?? savable.reason ?? undefined}
            onClick={() => props.onSave(draft, true)}>
            保存并确认为当前研究意图
          </button>
          <span className="rd-spacer" />
          <button className="rd-btn" disabled={props.probing}
            title={unavailableActions.probe_research_environment}
            onClick={props.onProbe}>
            <Icon name="refresh" size={14} />
            {props.probing ? '探测中…' : '重新探测环境'}
          </button>
        </div>
      </section>

      <section className="rd-panel rd-pad rd-startEnv" aria-label="环境探测">
        <div className="rd-sectionTitle">环境探测（只读）</div>
        <div className="rd-dim" style={{ fontSize: 12.5 }}>{environmentSummaryText(props.environment)}</div>
        {props.environment.length === 0 ? (
          <div className="rd-emptyHint">还没有探测记录。探测只读取当前宿主信息，不会安装依赖或运行实验。</div>
        ) : (
          <div className="rd-envList">
            {props.environment.map((o) => (
              <div key={o.observationId} className="rd-envRow">
                <span className="rd-envProbe">{o.probe}</span>
                <Chip cls={ENVIRONMENT_STATUS_META[o.status].cls}>{ENVIRONMENT_STATUS_META[o.status].label}</Chip>
                <span className="rd-spacer" />
                <span className="rd-dim rd-envValue">{o.value ?? o.error ?? '—'}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
