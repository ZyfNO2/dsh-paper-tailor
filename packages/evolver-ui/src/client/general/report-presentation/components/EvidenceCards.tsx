/**
 * W2 报告展示层 · 证据卡（只读）。
 *
 * 证据状态（当前/待复核/不可用/已撤销/未定位）与定位核验状态全部用文字标注，
 * 并原样展示输入携带的原因、来源 id 与输入性质；评审卡展示输入提供的判断、
 * 支持/反对证据与缺口。不执行核验、不生成新的证据结论。
 */
import type { GeneralReportFactPack } from '../../../../../../evolver/src/contracts/general-report.ts';
import { evidenceCheckText, evidenceStatusText, freshnessStatusText, knowledgeNatureText, reviewJudgmentText } from './formatValue.ts';

export interface EvidenceCardsProps {
  knowledge: GeneralReportFactPack['knowledge'];
  reviews: GeneralReportFactPack['reviews'];
}

function ReasonList({ title, reasons }: { title: string; reasons: string[] }): JSX.Element | null {
  if (reasons.length === 0) return null;
  return (
    <div className="rp-reasons">
      <span className="rp-reason-title">{title}</span>
      <ul className="rp-reason-list">
        {reasons.map((reason, index) => (
          <li key={`${index}-${reason}`} className="rp-reason-item">
            {reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function EvidenceCards({ knowledge, reviews }: EvidenceCardsProps): JSX.Element {
  return (
    <section className="rp-evidence" aria-label="知识与证据">
      <h3 className="rp-section-title">知识与证据</h3>
      {knowledge.length === 0 ? (
        <p className="rp-empty">暂无知识条目。</p>
      ) : (
        <ul className="rp-evidence-list">
          {knowledge.map((item) => (
            <li key={item.entry.entryId} className="rp-evidence-card">
              <div className="rp-evidence-head">
                <span className="rp-evidence-title">
                  {item.entry.title}
                  <span className="rp-evidence-version">v{item.entry.version}</span>
                </span>
                <span className="rp-evidence-badges">
                  {item.entry.kind === 'wiki' ? 'Wiki 条目' : '方法条目'} · {knowledgeNatureText(item.entry.nature)}
                  {item.entry.archived ? ' · 已归档' : ''}
                </span>
              </div>
              <p className="rp-evidence-content">{item.entry.content}</p>
              <div className="rp-evidence-status">
                <span className="rp-status-text">证据状态：{evidenceStatusText(item.evidence.status)}</span>
                <span className="rp-status-text">定位核验：{evidenceCheckText(item.evidence.check)}</span>
              </div>
              <ReasonList title="状态原因（输入提供）" reasons={item.evidence.reasons} />
              <div className="rp-evidence-refs">
                <span className="rp-refs-line">证据来源 id：{item.evidence.sourceIds.length > 0 ? item.evidence.sourceIds.join('、') : '未提供'}</span>
                <span className="rp-refs-line">证据输入性质：{item.evidence.inputNatures.length > 0 ? item.evidence.inputNatures.join('、') : '未提供'}</span>
                {item.entry.sourceRefs.length > 0 ? <span className="rp-refs-line">条目引用来源：{item.entry.sourceRefs.join('、')}</span> : null}
                {item.entry.calculationIds.length > 0 ? <span className="rp-refs-line">关联计算：{item.entry.calculationIds.join('、')}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="rp-reviews">
        <h4 className="rp-subtitle">评审记录</h4>
        {reviews.length === 0 ? (
          <p className="rp-empty">暂无评审记录。</p>
        ) : (
          <ul className="rp-review-list">
            {reviews.map((item) => (
              <li key={item.review.reviewId} className="rp-review-card">
                <div className="rp-review-head">
                  <span className="rp-review-judgment">评审判断：{reviewJudgmentText(item.review.judgment)}</span>
                  <span className="rp-review-meta">
                    {item.review.reviewId} · 评审人 {item.review.reviewer.identity} · {item.review.createdAt}
                  </span>
                </div>
                <p className="rp-review-reason">{item.review.reason}</p>
                <ReasonList title="支持证据（输入提供）" reasons={item.review.support} />
                <ReasonList title="反对证据（输入提供）" reasons={item.review.counterEvidence} />
                <ReasonList title="证据缺口（输入提供）" reasons={item.review.gaps} />
                <ReasonList title="后续动作（输入提供）" reasons={item.review.nextActions} />
                <p className="rp-review-applicability">适用性：{item.review.applicability === '' ? '未提供' : item.review.applicability}</p>
                {item.review.calculationIds.length > 0 ? <p className="rp-review-refs">关联计算：{item.review.calculationIds.join('、')}</p> : null}
                <div className="rp-review-freshness">
                  <span className="rp-status-text">评审新鲜度：{freshnessStatusText(item.freshness.status)}</span>
                  <ReasonList title="新鲜度原因（输入提供）" reasons={item.freshness.reasons} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="rp-evidence-note">本组件只展示报告输入提供的证据状态、核验状态与原因，不执行新的来源核验或证据检索。</p>
    </section>
  );
}
