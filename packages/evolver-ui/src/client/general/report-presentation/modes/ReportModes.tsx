/**
 * W3 报告展示层 · 四模式组合（薄壳）。
 * 同一 read: GeneralFactPackRead、同一份事实（reportFacts 模式无关切片）；
 * 模式只改变布局、解释层次与展开状态：academic=纯报告；plain=报告+术语通俗解释；
 * teaching=教学面板+报告；demo=可暂停的步骤导航+报告。顶部持续显示模拟横幅。
 * 状态机在 mode-model.ts（纯逻辑）；演示自动播放由本薄壳用定时器驱动且必须可暂停。
 */
import { useEffect, useState } from 'react';
import { ReportPresentation, TermDisclosure } from '../components/index.ts';
import { RP_BANNER_MAIN, RP_BANNER_NOTE, RP_MODE_COPIES, RP_TERM_ENTRIES, rpModeCopy } from '../content/index.ts';
import { TeachingPanel } from '../teaching/TeachingPanel.tsx';
import {
  DEMO_STEP_COUNT,
  DEMO_STEPS,
  initModeState,
  nextStep,
  pauseAutoPlay,
  prevStep,
  resetMode,
  selectMode,
  startAutoPlay,
} from './mode-model.ts';
import type { GeneralFactPackRead } from '../../../../../../evolver/src/contracts/general-report.ts';

export interface ReportModesProps {
  /** 同一份只读报告输入；任何模式都不修改它。 */
  readonly read: GeneralFactPackRead;
  readonly dataOrigin?: 'fixture' | 'workspace';
}

const AUTO_PLAY_MS = 2500;

export function ReportModes({ read, dataOrigin = 'fixture' }: ReportModesProps): JSX.Element {
  const [state, setState] = useState(() => initModeState('academic'));
  const copy = rpModeCopy(state.mode);
  const terms = RP_TERM_ENTRIES.map((entry) => ({ term: entry.term, plain: entry.short }));

  // 演示自动播放：定时步进，可随时暂停；到末步 nextStep 自动置为暂停。
  useEffect(() => {
    if (!state.autoPlaying) return undefined;
    const timer = setInterval(() => setState((s) => nextStep(s)), AUTO_PLAY_MS);
    return () => clearInterval(timer);
  }, [state.autoPlaying]);

  const stepButtonStyle = { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--rp-line, #e2e7ee)', background: 'var(--rp-surface, #fff)', color: 'inherit', cursor: 'pointer' } as const;

  return (
    <div className="rp" lang="zh-CN" style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      <p className="rp-banner">
        <span className="rp-banner-main">{dataOrigin === 'workspace' ? '工作区冻结事实报告' : RP_BANNER_MAIN}</span>
        <span className="rp-banner-note">{dataOrigin === 'workspace' ? '各项来源性质、未知与待重审状态按事实包保留。教学参数演示使用独立模拟数据，不改变报告事实；完成计算不代表科研假设成立。' : RP_BANNER_NOTE}</span>
      </p>

      <div role="navigation" aria-label="展示模式" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {RP_MODE_COPIES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            aria-current={state.mode === mode.id ? 'true' : undefined}
            onClick={() => setState((s) => selectMode(s, mode.id))}
            style={{
              ...stepButtonStyle,
              border: state.mode === mode.id ? '1px solid var(--rp-blue, #275bd8)' : stepButtonStyle.border,
              background: state.mode === mode.id ? 'var(--rp-blue-soft, #edf3ff)' : stepButtonStyle.background,
              color: state.mode === mode.id ? 'var(--rp-blue, #275bd8)' : stepButtonStyle.color,
              fontWeight: state.mode === mode.id ? 650 : 400,
            }}
          >
            {mode.label} · {mode.tagline}
          </button>
        ))}
      </div>

      <p className="rp-note">
        <span>
          <strong>{copy.label}模式：</strong>{copy.focus} {copy.neverChanges}
        </span>
      </p>

      {state.mode === 'demo' ? (
        <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          <div className="rp-demo-controls">
            <span className="rp-demo-state" data-state={state.autoPlaying ? 'playing' : 'paused'}>
              自动播放：{state.autoPlaying ? '运行中' : '已暂停'}
            </span>
            <button type="button" style={stepButtonStyle} onClick={() => setState((s) => startAutoPlay(s))}>播放</button>
            <button type="button" style={stepButtonStyle} onClick={() => setState((s) => pauseAutoPlay(s))}>暂停</button>
            <button type="button" style={stepButtonStyle} onClick={() => setState((s) => prevStep(s))}>上一步</button>
            <button type="button" style={stepButtonStyle} onClick={() => setState((s) => nextStep(s))}>下一步</button>
            <button type="button" style={stepButtonStyle} onClick={() => setState((s) => resetMode(s))}>重置演示</button>
            <span className="rp-demo-progress" aria-hidden="true">
              {DEMO_STEPS.map((step, index) => (
                <span key={step} data-done={index <= state.stepIndex ? 'true' : 'false'} />
              ))}
            </span>
          </div>
          <p className="rp-demo-hint">
            第 {state.stepIndex + 1}/{DEMO_STEP_COUNT} 步 · {DEMO_STEPS[state.stepIndex]}——按下面完整报告的对应部分讲解；失败、未知与限制在所有步骤保留。
          </p>
        </div>
      ) : null}

      {state.mode === 'teaching' ? <TeachingPanel /> : null}
      {state.mode === 'plain' ? <TermDisclosure terms={terms} /> : null}

      <ReportPresentation read={read} />
    </div>
  );
}
