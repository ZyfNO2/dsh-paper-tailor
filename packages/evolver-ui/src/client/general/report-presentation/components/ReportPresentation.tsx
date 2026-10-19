/**
 * W2 报告展示层 · 只读报告组合组件。
 *
 * 输入 GeneralFactPackRead（真实只读报告 DTO），内部把切片分发给子组件：
 * 指标矩阵、过程步骤、对比图（按计算切片）、证据卡、限制提示。
 * 不调用后端、不修改输入对象、不执行新的计算或证据核验。
 * 术语展开（TermDisclosure）的文案来自 W1 内容包，由 W3/集成方挂载，故不在此拼装。
 */
import type { GeneralFactPackRead } from '../../../../../../evolver/src/contracts/general-report.ts';
import { freshnessStatusText, pickSummarySlices } from './formatValue.ts';

const ESTIMAND_LABELS: Record<string, string> = { mean_minus_reference: '均值 − 参考均值', paired_mean_difference_A_minus_B: '配对均值差 (A−B)', independent_mean_difference_A_minus_B: '独立组均值差 (A−B)' };
const EFFECT_LABELS: Record<string, string> = { cohen_d: "Cohen's d（独立组）", cohen_dz: "Cohen's dz（配对）", cohen_d_pooled: "Cohen's d（合并标准差）" };
const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(7))));
import { MetricTable } from './MetricTable.tsx';
import { ProcessSteps } from './ProcessSteps.tsx';
import { ComparisonChart } from './ComparisonChart.tsx';
import { EvidenceCards } from './EvidenceCards.tsx';
import { LimitationsNotice } from './LimitationsNotice.tsx';

export interface ReportPresentationProps {
  read: GeneralFactPackRead;
}

export function ReportPresentation({ read }: ReportPresentationProps): JSX.Element {
  const { record, pack, freshness } = read;
  return (
    <article className="rp-report" aria-label="只读研究报告">
      <header className="rp-report-header">
        <h2 className="rp-report-title">{pack.title}</h2>
        <p className="rp-report-meta">
          报告包 {pack.packId} v{pack.version} · 研究 {pack.researchId} · 创建于 {pack.createdAt} · 引导修订 {pack.bootstrapRevision} · schema v
          {pack.schemaVersion}（{pack.kind}）
        </p>
        <p className="rp-report-meta rp-record-meta">
          记录 {record.packId}（产物 {record.artifact.id} · 上下文 {record.contextHash.slice(0, 8)}… · 输入 {record.inputsHash.slice(0, 8)}…）
        </p>
        <p className={freshness.status === 'needs_review' ? 'rp-freshness rp-freshness-review' : 'rp-freshness'}>
          整包新鲜度：{freshnessStatusText(freshness.status)}
          {freshness.reasons.length > 0 ? `（原因（输入提供）：${freshness.reasons.join('；')}）` : ''}
        </p>
      </header>
      <section className="rp-method-card" aria-label="研究问题与方法">
        <h3 className="rp-section-title">研究问题与方法</h3>
        {pack.questions.length === 0 ? (
          <p className="rp-empty">未记录研究问题。</p>
        ) : (
          <ul className="rp-question-list">
            {pack.questions.map((question, index) => (
              <li key={`${question.ideaId}-${index}`} className="rp-question">
                <span className="rp-question-text">{question.question}</span>
                <span className="rp-question-meta">
                  假设 · {question.ideaId} r{question.revision}
                </span>
              </li>
            ))}
          </ul>
        )}
        {pack.constraints.length > 0 ? (
          <div className="rp-constraints">
            <h4 className="rp-subtitle">约束（输入提供）</h4>
            <ul className="rp-constraint-list">
              {pack.constraints.map((constraint, index) => (
                <li key={`${index}-${constraint}`} className="rp-constraint-item">
                  {constraint}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="rp-selection-meta">
          选择：来源 {pack.selection.sourceIds.length} 项 · 计算 {pack.selection.calculationIds.length} 项 · 知识{' '}
          {pack.selection.knowledgeRefs.length} 项 · 评审 {pack.selection.reviewIds.length} 项
        </p>
      </section>
      <MetricTable rows={pack.metrics.rows} protocols={pack.metrics.protocols} />
      {pack.metrics.errors.length > 0 ? (
        <div className="rp-metric-errors">
          <h3 className="rp-section-title">指标投影错误（输入提供）</h3>
          <ul className="rp-error-list">
            {pack.metrics.errors.map((error, index) => (
              <li key={`${error.calculationId}-${index}`} className="rp-error-item">
                计算 {error.calculationId}：{error.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {pack.metrics.boundary !== '' ? <p className="rp-metric-boundary">指标投影边界：{pack.metrics.boundary}</p> : null}
      <ProcessSteps plans={pack.plans} calculations={pack.calculations} />
      {pickSummarySlices(pack.calculations).map((slice) => (
        <ComparisonChart key={slice.title} summaries={slice.summaries} title={slice.title} />
      ))}
      {pack.inferences.length > 0 ? (
        <section className="rp-inferences" aria-label="推断检验（登记运行）">
          <h3 className="rp-section-title">推断检验</h3>
          {pack.inferences.map((item) => (
            <div key={item.run.runId} style={{ display: 'grid', gap: 6, minWidth: 0, borderBottom: '1px solid var(--rp-line, #e2e7ee)', paddingBottom: 8 }}>
              <div className="flex between">
                <strong>{item.plan.title} · v{item.plan.version}</strong>
                <span className="rp-status-text">{item.run.status === 'completed' ? '已完成（数学执行）' : item.run.status === 'blocked' ? '被阻塞' : '失败'} · attempt {item.run.attempt}</span>
              </div>
              {item.check === 'provenance_checked' && item.result !== null ? (
                <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
                  <p className="small"><strong>{ESTIMAND_LABELS[item.result.estimand]}</strong> · 置信 {item.result.confidence} · 单位 {item.result.unit}</p>
                  <p className="small">估计 {fmt(item.result.estimate)} · 标准误 {fmt(item.result.standardError)} · 自由度 {fmt(item.result.degreesOfFreedom)} · t {fmt(item.result.statistic)} · 双侧 p {fmt(item.result.pValueTwoSided)} · nA {fmt(item.result.nA)}{item.result.nB !== null ? ` · nB ${fmt(item.result.nB)}` : ''}</p>
                  <p className="small">{item.result.confidence * 100}% 置信区间 [{fmt(item.result.confidenceInterval.lower)}, {fmt(item.result.confidenceInterval.upper)}] {item.result.unit}
                    <span className="rp-small rp-muted">（均值（差）的置信区间，不是效应量的置信区间。）</span>
                  </p>
                  <p className="small">{EFFECT_LABELS[item.result.standardizedEffect.name]} = {fmt(item.result.standardizedEffect.value)}
                    <span className="rp-small rp-muted">（点估计；本工具不提供效应量区间估计。）</span>
                  </p>
                  <p className="small rp-muted">排除 {item.result.excludedA.length + (item.result.excludedB?.length ?? 0)} 项（complete_cases 整例并记录身份）；抽样理由：{item.result.assumptions.samplingRationale}；正态性理由：{item.result.assumptions.normalityRationale}。填写理由本身不是假设被验证的证据。</p>
                  {item.result.warnings.map((warning, index) => <p key={index} className="small">{warning}</p>)}
                </div>
              ) : (
                <p className="small">该运行没有成功产物。首错：{item.run.firstError ? `${item.run.firstError.code}: ${item.run.firstError.message}` : item.error ?? '未记录'}</p>
              )}
              <p className="small rp-muted">新鲜度：{item.freshness.status === 'current' ? '当前' : `待复核（${item.freshness.reasons.join('；')}）`} · 工具 {item.run.tool.name} {item.run.tool.version}（{item.run.tool.runtime}）· completed 只代表数学执行完成；科学支持/判断由审查环节给出，不由 p 值自动生成。</p>
            </div>
          ))}
        </section>
      ) : null}
      <EvidenceCards knowledge={pack.knowledge} reviews={pack.reviews} />
      <LimitationsNotice
        unknowns={pack.unknowns}
        boundary={pack.boundary}
        freshnessReasons={freshness.status === 'needs_review' ? freshness.reasons : []}
      />
      <footer className="rp-report-footer">
        <p>只读报告组件：不修改研究数据，不执行新的计算或证据核验；未测值、单位不一致与比较限制均按输入原样呈现。</p>
      </footer>
    </article>
  );
}
