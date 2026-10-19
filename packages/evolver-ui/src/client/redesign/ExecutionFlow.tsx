/**
 * 「实验执行图」 rendering — the DEFAULT view of the work tree (round 2026-10-11).
 *
 * Everything displayed here is DERIVED in `execution-graph.ts` (pure, Node-tested);
 * this file only renders the derived model and maps clicks back to REAL node ids,
 * which open the existing detail panel (NodeInspector is untouched and shared with
 * the relation view).
 *
 * Layout contract (review plan §3):
 * - 纵向主流程: 准备 → 单变量验证 → 结果比较 → 组合与验证, one stage per row,
 *   with a visible ↓ connector between stages;
 * - 并行实验横向排列: experiments of one stage flow into a wrapping row of fixed
 *   minimum-width cards, so several Ideas never read as one serial chain;
 * - titles are never truncated — cards grow and text wraps (overflow-wrap:anywhere);
 * - one font size per text role, theme colors via the shared --rd-* variables only
 *   (FE-R08: no hardcoded colors), so dark and light both stay readable;
 * - missing facts render 待补充 in place — never a padded value.
 */
import type { IconName } from './icons.tsx';
import type { ReactNode } from 'react';
import { Icon } from './icons.tsx';
import { Chip, ObjectLinkButton } from './controls.tsx';
import {
  BRANCH_META,
  PENDING_LABEL,
  progressText,
  type ExecutionCard,
  type ExecutionGraphModel,
  type NextStep,
  type OutcomeCard,
  type PrepareCard,
} from './execution-graph.ts';

interface FlowProps {
  model: ExecutionGraphModel;
  selectedId: string | null;
  onSelectNode: (nodeId: string) => void;
}

const STAGE_HINT: Record<string, string> = {
  prepare: '基线与研究协议先就绪，实验才有共同对照',
  verify: '每个 Idea 独立验证；并行实验横向排列，互不阻塞',
  compare: '单变量验证之后：保留 / 淘汰 / 补验证，依据来自记录',
  combine: '有效组件的组合、消融与稳健性验证，最后收敛为结论',
};

export function ExecutionFlow(props: FlowProps): JSX.Element {
  const { model } = props;
  return (
    <div className="rd-execFlow" role="group" aria-label="实验执行图：从实验准备到结论的纵向主流程，并行实验横向排列">
      <StageRow stageId="prepare" label="实验准备" hint={STAGE_HINT.prepare} count={model.prepare.length}>
        {model.prepare.map((card) => (
          <PrepareCardView key={card.nodeId} card={card} selected={props.selectedId === card.nodeId} onSelectNode={props.onSelectNode} />
        ))}
      </StageRow>
      <StageArrow />
      <StageRow stageId="verify" label="单变量验证" hint={STAGE_HINT.verify} count={model.experiments.length}>
        {model.experiments.map((card) => (
          <ExperimentCardView key={card.nodeId} card={card} selected={props.selectedId === card.nodeId} onSelectNode={props.onSelectNode} />
        ))}
      </StageRow>
      <StageArrow />
      <StageRow stageId="compare" label="结果比较" hint={STAGE_HINT.compare} count={model.results.length}>
        {model.results.map((card) => (
          <OutcomeCardView key={card.nodeId} card={card} selected={props.selectedId === card.nodeId} onSelectNode={props.onSelectNode} />
        ))}
        {model.emptyNotes?.compare !== undefined && model.results.length === 0 && (
          <EmptyStageNote text={model.emptyNotes.compare} />
        )}
      </StageRow>
      <StageArrow />
      <StageRow stageId="combine" label="组合与验证" hint={STAGE_HINT.combine} count={model.conclusions.length}>
        {model.conclusions.map((card) => (
          <OutcomeCardView key={card.nodeId} card={card} selected={props.selectedId === card.nodeId} onSelectNode={props.onSelectNode} />
        ))}
        {model.emptyNotes?.combine !== undefined && model.conclusions.length === 0 && (
          <EmptyStageNote text={model.emptyNotes.combine} />
        )}
      </StageRow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 下一步 card — answers "打开页面先做什么" before anything else.
// ---------------------------------------------------------------------------

export function NextStepCard(props: { next: NextStep | null; model: ExecutionGraphModel; onSelectNode: (id: string) => void }): JSX.Element {
  const { next, model } = props;
  return (
    <section className="rd-nextCard" aria-label="下一步建议">
      <span className="rd-nextLabel">下一步</span>
      {next === null ? (
        <div className="rd-nextText">暂无可执行的实验计划：先在 Brainstorm 中确定研究方向并初始化实验图。</div>
      ) : (
        <div className="rd-nextBody">
          <div className="rd-nextText">
            {next.text}
            {next.nodeId !== null && (
              <button type="button" className="rd-linkBtn rd-nextJump" onClick={() => props.onSelectNode(next.nodeId ?? '')}>
                查看详情
              </button>
            )}
          </div>
          {next.detail !== null && <div className="rd-nextDetail">{next.detail}</div>}
        </div>
      )}
      <div className="rd-nextFoot">
        <span className="rd-dim">{progressText(model.counts)}</span>
        {model.prepareBlockers.map((b) => (
          <Chip key={b} tone="yellow">{b}</Chip>
        ))}
      </div>
      <div className="rd-dim rd-nextReadOnly">本页只读：规划与状态展示，实验运行在对话中发起（plan_only）。</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// stage chrome
// ---------------------------------------------------------------------------

function StageRow(props: { stageId: string; label: string; hint: string; count: number; children: ReactNode }): JSX.Element {
  return (
    <section className="rd-stage" data-stage={props.stageId} aria-label={`${props.label}（${props.count} 项）`}>
      <header className="rd-stageHead">
        <span className="rd-stageLabel">{props.label}</span>
        <span className="rd-stageHint">{props.hint}</span>
        <span className="rd-stageCount rd-dim">{props.count}</span>
      </header>
      <div className="rd-stageBody">{props.children}</div>
    </section>
  );
}

function StageArrow(): JSX.Element {
  return <div className="rd-stageArrow" aria-hidden="true">↓</div>;
}

function EmptyStageNote(props: { text: string }): JSX.Element {
  return (
    <div className="rd-stageEmpty">
      <Icon name="doc" size={14} />
      <span>{props.text}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// cards
// ---------------------------------------------------------------------------

const PREPARE_ICON: Record<string, IconName> = {
  研究目标: 'target', 问题: 'help', 基线: 'layers', 协议: 'branch',
};

function cardAria(title: string, planning: string, status: string): string {
  return `${title} 规划状态：${planning} 运行状态：${status}`;
}

function PrepareCardView(props: { card: PrepareCard; selected: boolean; onSelectNode: (id: string) => void }): JSX.Element {
  const { card } = props;
  return (
    <article
      id={`rd-exnode-${card.nodeId}`}
      className={`rd-prepCard${props.selected ? ' rd-exSelected' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={cardAria(`${card.kindLabel}｜${card.title}`, card.planningLabel ?? '未规划', '待进行')}
      onClick={() => props.onSelectNode(card.nodeId)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelectNode(card.nodeId); } }}
    >
      <div className="rd-prepHead">
        <Icon name={PREPARE_ICON[card.kindLabel] ?? 'doc'} size={14} />
        <b>{card.kindLabel}</b>
        {card.planningLabel !== null && <Chip tone={card.planningLabel.includes('待确认') || card.planningLabel.includes('草稿') ? 'yellow' : 'blue'}>{card.planningLabel}</Chip>}
      </div>
      <div className="rd-prepTitle">{card.title}</div>
      {card.note !== null && <div className="rd-prepNote">{card.note}</div>}
    </article>
  );
}

function OutcomeCardView(props: { card: OutcomeCard; selected: boolean; onSelectNode: (id: string) => void }): JSX.Element {
  const { card } = props;
  return (
    <article
      id={`rd-exnode-${card.nodeId}`}
      className={`rd-outCard${props.selected ? ' rd-exSelected' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${card.kindLabel}｜${card.title}`}
      onClick={() => props.onSelectNode(card.nodeId)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelectNode(card.nodeId); } }}
    >
      <div className="rd-prepHead">
        <Icon name={card.kindLabel === '结果' ? 'chart' : 'flag'} size={14} />
        <b>{card.kindLabel}</b>
        <Chip tone="gray">{card.statusLabel}</Chip>
      </div>
      <div className="rd-prepTitle">{card.title}</div>
      {card.summary !== '' && <div className="rd-prepNote">{card.summary}</div>}
      {card.outcome !== null && <div className="rd-execOutcome">{card.outcome}</div>}
      {card.rationale !== null && <div className="rd-execBasis">依据：{card.rationale}</div>}
    </article>
  );
}

function ExperimentCardView(props: { card: ExecutionCard; selected: boolean; onSelectNode: (id: string) => void }): JSX.Element {
  const { card } = props;
  const branch = card.branch === null ? null : BRANCH_META[card.branch];
  // join(' ') with filtered parts: join('') glued the status class onto the
  // base class (`rd-execCardrd-exec-planned`), which matched NO stylesheet rule —
  // status accents, the executable highlight and focus outlines were all dead.
  const cls = [
    'rd-execCard',
    `rd-exec-${card.status}`,
    card.executable ? 'rd-execNext' : '',
    props.selected ? 'rd-exSelected' : '',
  ].filter((part) => part !== '').join(' ');
  return (
    <article
      id={`rd-exnode-${card.nodeId}`}
      className={cls}
      role="button"
      tabIndex={0}
      aria-label={cardAria(`${card.no ?? card.action} ${card.title}`, card.planningLabel ?? '未规划', card.statusLabel)}
      onClick={() => props.onSelectNode(card.nodeId)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelectNode(card.nodeId); } }}
    >
      <header className="rd-execHead">
        {card.no !== null && <span className="rd-execNo">{card.no}</span>}
        <span className="rd-execAction">{card.action}</span>
        <span className="rd-execStatus">
          <Chip tone={chipToneOf(card.status)}>{card.statusLabel}</Chip>
          {card.planningLabel !== null && <Chip tone="gray">规划：{card.planningLabel}</Chip>}
          {branch !== null && <Chip cls={branch.cls} title={card.branchBasis ?? undefined}>{branch.label}</Chip>}
        </span>
      </header>
      <div className="rd-execTitle">{card.title}</div>
      <dl className="rd-execSlots">
        <Slot label="改什么" value={card.change} />
        <Slot label="看什么指标" value={card.metrics} />
        <Slot label="完成条件" value={card.doneWhen} />
        {card.outcome !== null && <Slot label="完成情况" value={card.outcome} always />}
      </dl>
      {card.blockedReason !== null && (
        <div className="rd-execBlocked">
          <Icon name="warning" size={13} />
          <span>阻塞：{card.blockedReason}</span>
        </div>
      )}
      {card.failureNote !== null && (
        <div className="rd-execBasis">失败说明：{card.failureNote}</div>
      )}
      {card.branch !== null && card.branchBasis !== null && (
        <div className="rd-execBasis">{BRANCH_META[card.branch].label}依据：{card.branchBasis}</div>
      )}
      <SourceLine card={card} />
      {(card.configRows !== null || card.planNotes !== null) && (
        <details className="rd-execMore" onClick={(e) => e.stopPropagation()}>
          <summary>详细配置 / 计划详情</summary>
          <div className="rd-execMoreBody">
            {card.configRows?.map((row) => (
              <div className="rd-execConfRow" key={row.name}>
                <span className="rd-execConfName">{row.name}</span>
                <span>{row.value}{row.constraint !== null && row.constraint !== '' ? <span className="rd-dim">（{row.constraint}）</span> : null}</span>
              </div>
            ))}
            {card.planNotes?.map((row) => (
              <div className="rd-execConfRow" key={row.name}>
                <span className="rd-execConfName">{row.name}</span>
                <span>{row.value}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </article>
  );
}

function chipToneOf(status: ExecutionCard['status']): 'green' | 'blue' | 'red' | 'yellow' | 'gray' {
  if (status === 'done' || status === 'retained') return 'green';
  if (status === 'in_progress') return 'blue';
  if (status === 'failed') return 'red';
  if (status === 'blocked') return 'yellow';
  return 'gray';
}

function Slot(props: { label: string; value: string | null; always?: boolean }): JSX.Element {
  if (props.value === null && props.always !== true) {
    return (
      <div className="rd-execSlot">
        <dt>{props.label}</dt>
        <dd className="rd-execPending">{PENDING_LABEL}<span className="rd-dim">（来源数据未填写）</span></dd>
      </div>
    );
  }
  return (
    <div className="rd-execSlot">
      <dt>{props.label}</dt>
      <dd>{props.value ?? PENDING_LABEL}</dd>
    </div>
  );
}

/**
 * 来源说明 — the hypothesis/idea this experiment came from lives HERE, not as a
 * separate node in the flow (review plan §1). Real nodes stay navigable buttons.
 */
function SourceLine(props: { card: ExecutionCard }): JSX.Element {
  const { sources } = props.card;
  if (sources.hypothesisNode === null && sources.schemeNode === null && sources.idea === null) return <></>;
  return (
    <div className="rd-execSrc">
      <span className="rd-dim">来源：</span>
      {sources.idea !== null && (
        <span className="rd-execSrcIdea" title={sources.idea.hypothesis ?? undefined}>
          Brainstorm Idea「{sources.idea.title}」{sources.idea.hypothesis !== null ? `—— 假设：${sources.idea.hypothesis}` : ''}
        </span>
      )}
      {sources.hypothesisNode !== null && (
        <ObjectLinkButton link={{ kind: 'node', key: sources.hypothesisNode.id, label: sources.hypothesisNode.title }}>
          {sources.hypothesisNode.title}
        </ObjectLinkButton>
      )}
      {sources.schemeNode !== null && (
        <ObjectLinkButton link={{ kind: 'node', key: sources.schemeNode.id, label: sources.schemeNode.title }}>
          {sources.schemeNode.title}
        </ObjectLinkButton>
      )}
    </div>
  );
}
