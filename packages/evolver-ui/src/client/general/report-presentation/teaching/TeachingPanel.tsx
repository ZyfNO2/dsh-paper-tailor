/**
 * W3 报告展示层 · 教学面板（薄壳）。
 * 状态机在 teaching-model.ts（纯逻辑，node --test 可测）；本组件只做渲染与事件接线。
 * 硬性约定：揭晓前不渲染答案文本（isRevealed 为门）；练习答对不等于科研验证；
 * 模拟参数演示只做展示性算术并持续标注"模拟结果"；全部交互仅本地状态，不保存不上传。
 */
import { useState } from 'react';
import { RP_QUIZ_CAVEAT, RP_TERM_ENTRIES, type RpTermEntry } from '../content/index.ts';
import {
  answerQuiz,
  buildQuizFromTerms,
  demoAbsoluteDifference,
  formatDemoDifference,
  DEMO_MAX,
  DEMO_MIN,
  initTeachingState,
  isQuizCorrect,
  isRevealed,
  resetTeaching,
  revealPrediction,
  setDemoParams,
  setSelfExplain,
} from './teaching-model.ts';

export interface TeachingPanelProps {
  /** 术语文案材料；默认 W1 的 RP_TERM_ENTRIES（答案只来自这里）。 */
  readonly terms?: readonly RpTermEntry[];
}

const cardStyle = { border: '1px solid var(--rp-line, #e2e7ee)', borderRadius: 10, padding: '12px 14px', background: 'var(--rp-surface, #fff)', display: 'grid', gap: 8, minWidth: 0 } as const;

export function TeachingPanel({ terms = RP_TERM_ENTRIES }: TeachingPanelProps): JSX.Element {
  const [state, setState] = useState(initTeachingState);
  const questions = buildQuizFromTerms(terms, 3);
  const predictions = terms.slice(0, 3);
  const demo = demoAbsoluteDifference(state);

  return (
    <section className="rp-teaching-panel" aria-label="教学互动" style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <p className="rp-quiz-caveat">{RP_QUIZ_CAVEAT}</p>

      <div style={cardStyle}>
        <h4>先预测，再揭晓</h4>
        <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 8 }}>
          {predictions.map((entry) => {
            const key = 'predict-' + entry.id;
            const revealed = isRevealed(state, key);
            return (
              <li key={key}>
                <p>先想一想：术语「{entry.term}」的通俗解释会是什么？</p>
                {!revealed ? (
                  <button type="button" onClick={() => setState((s) => revealPrediction(s, key))}>揭晓对照材料</button>
                ) : (
                  <div className="rp-quiz-answer">
                    <strong>材料说法：</strong>{entry.short}
                    {entry.example ? <p className="rp-small rp-muted">{entry.example}</p> : null}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      <div style={cardStyle}>
        <h4>小练习（答案只来自本页材料）</h4>
        <div className="rp-quiz">
          {questions.map((question) => {
            const chosen = state.quizAnswers[question.id];
            const answered = chosen !== undefined;
            return (
              <div key={question.id} style={{ display: 'grid', gap: 6 }}>
                <p style={{ fontWeight: 600 }}>{question.prompt}</p>
                {question.options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="rp-quiz-option"
                    aria-pressed={chosen === option.id}
                    disabled={answered}
                    onClick={() => setState((s) => answerQuiz(s, question, option.id))}
                    style={{ textAlign: 'left', justifyContent: 'flex-start' }}
                  >
                    <span className="rp-quiz-key" aria-hidden="true">{option.id === question.correctOptionId ? '✓' : '·'}</span>
                    <span>{option.text}</span>
                  </button>
                ))}
                {answered ? (
                  isQuizCorrect(question, chosen) ? (
                    <p className="rp-quiz-answer">答对了——材料中的解释就是这条。练习答对不等于科研验证。</p>
                  ) : (
                    <p className="rp-quiz-answer">再想想——材料中的解释是：「{question.options.find((option) => option.id === question.correctOptionId)?.text}」。</p>
                  )
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div style={cardStyle}>
        <h4>自我解释（仅本页本地，不保存不上传）</h4>
        <textarea
          aria-label="自我解释"
          value={state.selfExplain['report'] ?? ''}
          onChange={(event) => setState((s) => setSelfExplain(s, 'report', event.target.value))}
          rows={3}
          style={{ width: '100%', minWidth: 0, resize: 'vertical' }}
        />
      </div>

      <div style={cardStyle}>
        <h4>模拟参数演示（独立模拟状态，非科研计算）</h4>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'grid', gap: 4 }}>
            模拟均值 A
            <input
              type="number"
              min={DEMO_MIN}
              max={DEMO_MAX}
              step={0.001}
              value={state.demo.meanA}
              onChange={(event) => setState((s) => setDemoParams(s, Number(event.target.value), s.demo.meanB))}
              style={{ width: 120 }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            模拟均值 B
            <input
              type="number"
              min={DEMO_MIN}
              max={DEMO_MAX}
              step={0.001}
              value={state.demo.meanB}
              onChange={(event) => setState((s) => setDemoParams(s, s.demo.meanA, Number(event.target.value)))}
              style={{ width: 120 }}
            />
          </label>
          <button type="button" onClick={() => setState(resetTeaching)}>重置演示</button>
        </div>
        <p className="rp-quiz-answer" aria-live="polite">
          绝对差值（模拟结果）：{formatDemoDifference(demo)}
          <span className="rp-small rp-muted">（两个模拟数值直接相减，仅展示；单位无量纲，范围 {DEMO_MIN}–{DEMO_MAX}，示例 F1 尺度。不是显著性、检验或效应量结论。）</span>
        </p>
        <p className="rp-small rp-muted">参数超出范围会被钳制；非数值输入不生效。模拟结果与研究事实严格分开，不进入上方报告事实。</p>
      </div>
    </section>
  );
}
