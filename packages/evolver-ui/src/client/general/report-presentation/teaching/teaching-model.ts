/**
 * W3 报告展示层 · 教学互动纯逻辑（无 React、无 DOM，node --test 可直接导入）。
 *
 * 硬性约定：
 * - 练习答案只来自调用方传入的材料（W1 术语文案），模型不产生任何科研结论；
 * - 预测揭晓前，调用方不得渲染答案文本（isRevealed 为门）；
 * - 练习答对不等于科研验证（文案层标注，见 RP_QUIZ_CAVEAT）；
 * - 模拟参数演示是独立模拟状态：有限范围 [0,1]、明确单位、可重置、只做展示性算术
 *   （绝对差值），不做显著性/检验/统计推断；
 * - 全部纯函数返回新对象，绝不修改传入 state 或材料数组。
 */
import type { RpTermEntry } from '../content/index.ts';

export interface TeachingQuizOption { readonly id: string; readonly text: string }
export interface TeachingQuizQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly TeachingQuizOption[];
  readonly correctOptionId: string;
}

export interface TeachingDemoState { readonly meanA: number; readonly meanB: number }

export interface TeachingState {
  /** 已揭晓的预测 key（揭晓前调用方不渲染答案）。 */
  readonly revealed: readonly string[];
  /** questionId -> 选中 optionId（仅材料内选项）。 */
  readonly quizAnswers: Readonly<Record<string, string>>;
  /** 自我解释（仅本页本地，不保存不上传）。 */
  readonly selfExplain: Readonly<Record<string, string>>;
  /** 模拟参数（钳制到 [DEMO_MIN, DEMO_MAX]，默认取材料示例 F1 0.720/0.760）。 */
  readonly demo: TeachingDemoState;
}

/** 模拟参数演示的范围（无量纲，0–1，示例 F1 尺度）。 */
export const DEMO_MIN = 0;
export const DEMO_MAX = 1;

export function initTeachingState(): TeachingState {
  return { revealed: [], quizAnswers: {}, selfExplain: {}, demo: { meanA: 0.72, meanB: 0.76 } };
}

/**
 * 用材料内术语构造选择题（确定性，不随机）：正确选项是该术语的 short 解释，
 * 干扰项取自其他术语的 short（循环取邻位）。数量不超过材料条数与 count。
 */
export function buildQuizFromTerms(terms: readonly RpTermEntry[], count = 3): TeachingQuizQuestion[] {
  const eligible = terms.filter((entry) => entry.short.trim() !== '');
  const total = eligible.length;
  const questions: TeachingQuizQuestion[] = [];
  for (let i = 0; i < Math.min(count, total); i++) {
    const target = eligible[i]!;
    const options: TeachingQuizOption[] = [{ id: target.id, text: target.short }];
    for (let k = 1; options.length < Math.min(4, total) && k < total; k++) {
      const distractor = eligible[(i + k) % total]!;
      if (distractor.id !== target.id && !options.some((option) => option.id === distractor.id)) {
        options.push({ id: distractor.id, text: distractor.short });
      }
    }
    questions.push({ id: 'quiz-' + target.id, prompt: `术语「${target.term}」的通俗解释是哪一个？`, options, correctOptionId: target.id });
  }
  return questions;
}

/** 揭晓一条预测；揭晓后调用方才允许渲染对照材料。 */
export function revealPrediction(state: TeachingState, key: string): TeachingState {
  if (state.revealed.includes(key)) return state;
  return { ...state, revealed: [...state.revealed, key] };
}

export function isRevealed(state: TeachingState, key: string): boolean {
  return state.revealed.includes(key);
}

/** 记录练习作答；optionId 不在题目选项内（材料外）时原样返回 state，不记录、不抛错。 */
export function answerQuiz(state: TeachingState, question: TeachingQuizQuestion, optionId: string): TeachingState {
  if (!question.options.some((option) => option.id === optionId)) return state;
  if (state.quizAnswers[question.id] === optionId) return state;
  return { ...state, quizAnswers: { ...state.quizAnswers, [question.id]: optionId } };
}

/** 练习判分：仅对照题目自带 correctOptionId（来自材料）。 */
export function isQuizCorrect(question: TeachingQuizQuestion, chosenOptionId: string | undefined): boolean {
  return chosenOptionId !== undefined && chosenOptionId === question.correctOptionId;
}

export function setSelfExplain(state: TeachingState, key: string, text: string): TeachingState {
  if (state.selfExplain[key] === text) return state;
  return { ...state, selfExplain: { ...state.selfExplain, [key]: text } };
}

function clamp01(value: number): number {
  return Math.min(DEMO_MAX, Math.max(DEMO_MIN, value));
}

/** 设置模拟参数；非有限数值原样拒绝，有限值钳制到 [0,1]。 */
export function setDemoParams(state: TeachingState, a: number, b: number): TeachingState {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return state;
  const meanA = clamp01(a);
  const meanB = clamp01(b);
  if (meanA === state.demo.meanA && meanB === state.demo.meanB) return state;
  return { ...state, demo: { meanA, meanB } };
}

/** 展示性算术：两个模拟数值的直接相减（绝对差值），不是显著性或检验结论。 */
export function demoAbsoluteDifference(state: TeachingState): number {
  return Math.abs(state.demo.meanA - state.demo.meanB);
}

/** 演示差值的展示格式：三位小数、绝对差值带 + 号（与 W1 文案口径一致）。 */
export function formatDemoDifference(value: number): string {
  return (value >= 0 ? '+' : '') + Math.abs(value).toFixed(3);
}

/** 重置教学状态到初值（演示参数回到材料示例值）。 */
export function resetTeaching(): TeachingState {
  return initTeachingState();
}
