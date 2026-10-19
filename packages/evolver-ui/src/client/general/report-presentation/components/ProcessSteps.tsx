/**
 * W2 报告展示层 · 过程步骤（只读）。
 *
 * 计划步骤展示输入提供的目标、方法与限制；计算步骤展示状态、来源核验、
 * 新鲜度（含原因）、警告与首错（失败保留首错，不吞掉）。不推断未执行的步骤，
 * 不把失败显示为成功。
 */
import type { GeneralAnalysisPlan } from '../../../../../../evolver/src/contracts/general-analysis.ts';
import type { GeneralReportFactPack } from '../../../../../../evolver/src/contracts/general-report.ts';
import { calcCheckText, calcStatusText, freshnessStatusText } from './formatValue.ts';

export interface ProcessStepsProps {
  plans: GeneralAnalysisPlan[];
  calculations: GeneralReportFactPack['calculations'];
}

function methodText(method: string): string {
  if (method === 'descriptive') return '描述统计';
  if (method === 'grouped_descriptive') return '分组描述统计';
  if (method === 'repeated_summary') return '重复测量汇总';
  return method;
}

function checksText(checks: 'calculation_completed' | 'conditions_unsatisfied' | 'calculation_failed'): string {
  switch (checks) {
    case 'calculation_completed':
      return '计算完成';
    case 'conditions_unsatisfied':
      return '条件不满足，未产出结果';
    case 'calculation_failed':
      return '计算失败';
  }
}

export function ProcessSteps({ plans, calculations }: ProcessStepsProps): JSX.Element {
  return (
    <section className="rp-steps" aria-label="方法与计算过程">
      <h3 className="rp-section-title">方法与计算过程</h3>
      <div className="rp-plan-steps">
        <h4 className="rp-subtitle">分析计划（输入提供）</h4>
        {plans.length === 0 ? (
          <p className="rp-empty">暂无分析计划。</p>
        ) : (
          <ol className="rp-step-list">
            {plans.map((plan) => (
              <li key={`${plan.planId}-v${plan.version}`} className="rp-step rp-plan-step">
                <span className="rp-step-title">
                  {plan.title}（{plan.planId} v{plan.version}）
                </span>
                <p className="rp-step-goal">目标：{plan.goal}</p>
                <div className="rp-step-facts">
                  <span className="rp-fact">方法：{methodText(plan.method)}</span>
                  <span className="rp-fact">比较范围：{plan.comparisonScope === '' ? '未提供' : plan.comparisonScope}</span>
                  <span className="rp-fact">
                    关联想法：{plan.idea === null ? '未关联' : `${plan.idea.ideaId} r${plan.idea.revision}`}
                  </span>
                  <span className="rp-fact">
                    行范围：第 {plan.rowRange.start + 1}–{plan.rowRange.end + 1} 行
                  </span>
                  {plan.requiredConditions.length > 0 ? <span className="rp-fact">必要条件：{plan.requiredConditions.join('；')}</span> : null}
                  {plan.limitations.length > 0 ? <span className="rp-fact">计划限制：{plan.limitations.join('；')}</span> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="rp-calc-steps">
        <h4 className="rp-subtitle">计算执行（状态与原因来自输入）</h4>
        {calculations.length === 0 ? (
          <p className="rp-empty">暂无计算记录。</p>
        ) : (
          <ol className="rp-step-list">
            {calculations.map((entry) => (
              <li key={`${entry.calculation.calculationId}-a${entry.calculation.attempt}`} className="rp-step rp-calc-step">
                <span className="rp-step-title">
                  计算 {entry.calculation.calculationId}（尝试 {entry.calculation.attempt}）
                </span>
                <div className="rp-step-facts">
                  <span className="rp-fact">状态：{calcStatusText(entry.calculation.status)}</span>
                  <span className="rp-fact">核验：{calcCheckText(entry.check)}</span>
                  <span className="rp-fact">检查：{checksText(entry.calculation.checks)}</span>
                  <span className="rp-fact">
                    新鲜度：{freshnessStatusText(entry.freshness.status)}
                    {entry.freshness.reasons.length > 0 ? `（${entry.freshness.reasons.join('；')}）` : ''}
                  </span>
                  <span className="rp-fact">
                    工具：{entry.calculation.tool.name} v{entry.calculation.tool.version}（{entry.calculation.tool.runtime}）
                  </span>
                  {entry.calculation.artifact !== null ? <span className="rp-fact">产物：{entry.calculation.artifact.id}</span> : null}
                  {entry.summaries.length > 0 ? (
                    <span className="rp-fact">统计行数：{entry.summaries.length}（数值见对比图与数值表）</span>
                  ) : null}
                </div>
                {entry.calculation.firstError !== null ? (
                  <p className="rp-first-error">
                    首错（输入提供）：{entry.calculation.firstError.code} — {entry.calculation.firstError.message}
                  </p>
                ) : null}
                {entry.error !== null ? <p className="rp-entry-error">错误信息（输入提供）：{entry.error}</p> : null}
                {entry.warnings.length > 0 ? (
                  <ul className="rp-warning-list">
                    {entry.warnings.map((warning, index) => (
                      <li key={`${index}-${warning}`} className="rp-warning-item">
                        警告：{warning}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
