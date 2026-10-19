/**
 * 拼接理由面板：显示选中候选的任务问题、机制与互补、位置/顺序、风险与验证。
 *
 * W3b。三个不可让步的规则，全部来自"诚实显示"而不是样式偏好：
 *
 *  1. **状态词永远显示。** 一句没有状态标签的话，和作者主张长得一模一样。
 *  2. **未知就显示来源给的原因**，不用占位符或泛化文案填满。
 *  3. **理由缺失时显示 Host 给的 unresolved 原因**，不隐藏整个面板——空面板
 *     会让用户以为"没有问题"，而不是"还没有关联"。
 */

import type { CandidateDesign, ChineseClaim, MethodTag } from '../wire.ts';
import { claimView, methodNameZh, methodRelationLabel } from './format.ts';
import { s } from './styles.ts';

export interface DesignRationaleProps {
  design: CandidateDesign | null;
  /** The candidate this panel is about, for the heading. */
  candidateKey: string | null;
  /** Clicking a module tag navigates to that entity. */
  onOpenModule?: (cardId: string) => void;
  onOpenPaper?: (paperId: string) => void;
}

/** One claim row: the sentence plus its status word and any reason. */
function ClaimRow(props: { claim: ChineseClaim; cardOnly?: boolean }): JSX.Element {
  const view = claimView(props.claim, { cardOnly: props.cardOnly === true });
  if (view.text === null) {
    return (
      <p className={s.claimUnknown} data-claim-status="unknown">
        <span className={s.claimStatus} data-status="unknown">未知</span>
        {view.reason}
      </p>
    );
  }
  return (
    <p className={s.claim} data-claim-status={view.statusLabel === null ? 'unknown' : props.claim.status}>
      <span className={s.claimStatus} data-status={props.claim.status} title={view.statusTitle}>
        {view.statusLabel}
      </span>
      {view.text}
    </p>
  );
}

function ClaimList(props: { title: string; claims: ChineseClaim[]; emptyZh: string }): JSX.Element {
  return (
    <section className={s.rationaleSection}>
      <h4 className={s.rationaleHeading}>{props.title}</h4>
      {props.claims.length === 0
        ? <p className={s.rationaleEmpty}>{props.emptyZh}</p>
        : props.claims.map((c, i) => <ClaimRow key={i} claim={c} />)}
    </section>
  );
}

function MethodTagRow(props: { tag: MethodTag; onOpenModule?: (id: string) => void; onOpenPaper?: (id: string) => void }): JSX.Element {
  const label = methodNameZh(props.tag);
  const relation = methodRelationLabel(props.tag.relation);
  const clickable = props.tag.cardRef !== null && props.onOpenModule !== undefined;
  return (
    <li className={s.tagRow} data-relation={props.tag.relation} data-kind={props.tag.kind}>
      <button
        type="button"
        className={s.tagButton}
        disabled={!clickable}
        onClick={() => {
          if (clickable) props.onOpenModule?.(props.tag.cardRef?.id ?? '');
        }}
        title={clickable ? '跳转到该模块' : `${relation}：没有对应卡片，仅作为来源标识`}
      >
        <span className={s.tagRelation}>{relation}</span>
        <span className={s.tagName}>{label}</span>
      </button>
    </li>
  );
}

export function DesignRationale(props: DesignRationaleProps): JSX.Element {
  const { design } = props;

  if (design === null) {
    return (
      <div className={s.rationale} data-testid="design-rationale" data-state="no-selection">
        <h3 className={s.rationaleTitle}>拼接理由</h3>
        <p className={s.rationaleEmpty}>请先选择一个候选，查看它为什么这样组合。</p>
      </div>
    );
  }

  // An unresolved design shows WHY. Hiding the panel would read as "nothing to
  // report" rather than "the rationale is not linked yet".
  if (design.rationale === null) {
    return (
      <div className={s.rationale} data-testid="design-rationale" data-state="unresolved">
        <h3 className={s.rationaleTitle}>拼接理由</h3>
        <p className={s.rationaleUnknown}>
          {design.unresolved[0]?.reasonZh ?? '拼接理由未关联。'}
        </p>
        {design.unresolved.length > 1 && (
          <ul className={s.rationaleUnresolvedList}>
            {design.unresolved.slice(1).map((u, i) => <li key={i}>{u.reasonZh}</li>)}
          </ul>
        )}
      </div>
    );
  }

  const r = design.rationale;
  return (
    <div className={s.rationale} data-testid="design-rationale" data-state="resolved">
      <h3 className={s.rationaleTitle}>拼接理由</h3>

      <p className={s.rationaleMeta}>
        候选 <code>{design.binding.candidateId}</code>
        {design.decision !== null && <> · 决策 {design.decision}</>}
        {design.performanceStatus !== null && <> · 性能状态 {design.performanceStatus}</>}
      </p>

      <section className={s.rationaleSection}>
        <h4 className={s.rationaleHeading}>任务问题</h4>
        <ClaimRow claim={r.taskProblem} />
      </section>

      <section className={s.rationaleSection}>
        <h4 className={s.rationaleHeading}>机制与互补</h4>
        <ClaimRow claim={r.mechanismHypothesis} />
        <ClaimRow claim={r.complementarity} />
      </section>

      <section className={s.rationaleSection}>
        <h4 className={s.rationaleHeading}>插入位置与顺序</h4>
        <ClaimRow claim={r.placementReason} />
        {/* orderingReason is expected to be unknown until a recipe records it;
            showing the reason is the point, so it is rendered like any other. */}
        <ClaimRow claim={r.orderingReason} />
      </section>

      <ClaimList title="风险" claims={r.risks} emptyZh="候选未记录风险。" />
      <ClaimList title="如何验证" claims={r.validationQuestions} emptyZh="候选未记录验证问题。" />

      {design.moduleTags.length > 0 && (
        <section className={s.rationaleSection}>
          <h4 className={s.rationaleHeading}>涉及模块</h4>
          <ul className={s.tagList}>
            {design.moduleTags.map((t) => (
              <MethodTagRow
                key={t.methodKey}
                tag={t}
                {...(props.onOpenModule === undefined ? {} : { onOpenModule: props.onOpenModule })}
                {...(props.onOpenPaper === undefined ? {} : { onOpenPaper: props.onOpenPaper })}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}