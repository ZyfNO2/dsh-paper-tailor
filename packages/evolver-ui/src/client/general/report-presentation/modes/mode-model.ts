/**
 * W3 报告展示层 · 四模式纯逻辑（无 React、无 DOM，node --test 可直接导入）。
 *
 * 硬性约定：
 * - 同一份报告、同一组事实、一个入口；模式只改变布局、解释层次与展开状态，
 *   绝不改变数值、版本、来源性质、判断与不确定性（reportFacts 是模式无关的事实切片）；
 * - 全部纯函数返回新对象，绝不修改传入 state 或输入报告；
 * - 演示模式自动播放是可暂停的有限步骤导航（纯函数不接定时器；定时由薄壳驱动）。
 */
import type { GeneralFactPackRead } from '../../../../../../evolver/src/contracts/general-report.ts';
import type { RpModeId } from '../content/index.ts';

export type RpMode = RpModeId;

/** 演示步骤标签（仅导航用语，不生成任何实验结果或结论）。 */
export const DEMO_STEPS: readonly string[] = ['概览', '方法与口径', '结果与差值', '证据与审查', '未知与限制'];
export const DEMO_STEP_COUNT = DEMO_STEPS.length;

export interface RpModeState {
  readonly mode: RpMode;
  /** 演示步骤（0-based，仅 demo 模式使用）。 */
  readonly stepIndex: number;
  /** 自动播放标记；离开 demo 或到末步自动置 false（可暂停）。 */
  readonly autoPlaying: boolean;
}

export function initModeState(mode: RpMode = 'academic'): RpModeState {
  return { mode, stepIndex: 0, autoPlaying: false };
}

/** 切换模式：步进与自动播放重置；同一模式原样返回。 */
export function selectMode(state: RpModeState, mode: RpMode): RpModeState {
  if (mode === state.mode) return state;
  return { mode, stepIndex: 0, autoPlaying: false };
}

export function nextStep(state: RpModeState): RpModeState {
  if (state.stepIndex >= DEMO_STEP_COUNT - 1) {
    return state.autoPlaying ? { ...state, autoPlaying: false } : state;
  }
  return { ...state, stepIndex: state.stepIndex + 1 };
}

export function prevStep(state: RpModeState): RpModeState {
  if (state.stepIndex <= 0) return state;
  return { ...state, stepIndex: state.stepIndex - 1 };
}

/** 仅演示模式可开自动播放；到末步由 nextStep 自动暂停。 */
export function startAutoPlay(state: RpModeState): RpModeState {
  if (state.mode !== 'demo' || state.autoPlaying) return state;
  return { ...state, autoPlaying: true };
}

export function pauseAutoPlay(state: RpModeState): RpModeState {
  if (!state.autoPlaying) return state;
  return { ...state, autoPlaying: false };
}

/** 重置当前模式的演示状态（不改变模式选择）。 */
export function resetMode(state: RpModeState): RpModeState {
  return initModeState(state.mode);
}

/**
 * 模式无关的事实切片：任何模式都用同一函数取同一份事实，
 * 保证"切换模式不改变数据"由构造保证而非约定。
 */
export interface ReportFactSlice {
  readonly rows: GeneralFactPackRead['pack']['metrics']['rows'];
  readonly protocols: GeneralFactPackRead['pack']['metrics']['protocols'];
  readonly calculations: GeneralFactPackRead['pack']['calculations'];
  readonly knowledge: GeneralFactPackRead['pack']['knowledge'];
  readonly reviews: GeneralFactPackRead['pack']['reviews'];
  readonly unknowns: readonly string[];
  readonly boundary: string;
}

export function reportFacts(read: GeneralFactPackRead): ReportFactSlice {
  return Object.freeze({
    rows: read.pack.metrics.rows,
    protocols: read.pack.metrics.protocols,
    calculations: read.pack.calculations,
    knowledge: read.pack.knowledge,
    reviews: read.pack.reviews,
    unknowns: read.pack.unknowns,
    boundary: read.pack.boundary,
  });
}
