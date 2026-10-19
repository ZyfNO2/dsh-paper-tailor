/**
 * W2 报告展示层 · 限制与未知提示（只读）。
 *
 * 未知/未测事项原样列出（不把未知改写成结论）；适用边界只呈现输入文本；
 * 报告整体待复核时显示输入携带的原因，状态用文字呈现，不只靠颜色。
 */
export interface LimitationsNoticeProps {
  unknowns: string[];
  boundary: string;
  /** 报告整体 freshness 为 needs_review 时由调用方传入其原因 */
  freshnessReasons?: string[];
}

export function LimitationsNotice({ unknowns, boundary, freshnessReasons = [] }: LimitationsNoticeProps): JSX.Element {
  return (
    <section className="rp-limitations" aria-label="限制与未知">
      <h3 className="rp-section-title">限制与未知</h3>
      <div className="rp-boundary">
        <h4 className="rp-subtitle">适用边界</h4>
        <p className="rp-boundary-text">{boundary === '' ? '未提供边界说明。' : boundary}</p>
      </div>
      <div className="rp-unknowns">
        <h4 className="rp-subtitle">未知 / 未测事项</h4>
        {unknowns.length === 0 ? (
          <p className="rp-empty">未记录未知项。</p>
        ) : (
          <ul className="rp-unknown-list">
            {unknowns.map((item, index) => (
              <li key={`${index}-${item}`} className="rp-unknown-item">
                {item}
              </li>
            ))}
          </ul>
        )}
      </div>
      {freshnessReasons.length > 0 ? (
        <div className="rp-pack-freshness">
          <h4 className="rp-subtitle">报告整体待复核（输入提供的原因）</h4>
          <ul className="rp-reason-list">
            {freshnessReasons.map((reason, index) => (
              <li key={`${index}-${reason}`} className="rp-reason-item">
                {reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
