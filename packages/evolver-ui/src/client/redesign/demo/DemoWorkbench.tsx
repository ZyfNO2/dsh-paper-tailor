/**
 * DemoWorkbench — fixture-only host for the redesign preview.
 *
 * Owns: scenario switching (demo-only toolbar), a mutable copy of the
 * fixture snapshot, session-only event handling, and the on-screen action
 * log used as FE-A06 evidence. It never fetches, never authorizes, and never
 * touches /evolver/api.
 */
import { useMemo, useRef, useState } from 'react';
import { WorkbenchView } from '../WorkbenchView.tsx';
import type {
  EventOutcome,
  WorkbenchEvent,
  WorkbenchSnapshot,
} from '../view-model.ts';
import { SCENARIOS, buildScenario, type ScenarioId } from './fixtures.ts';

interface LogEntry {
  seq: number;
  time: string;
  event: WorkbenchEvent;
  outcome: EventOutcome;
}

function now(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function DemoWorkbench(): JSX.Element {
  const [scenarioId, setScenarioId] = useState<ScenarioId>('dl');
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>(() => buildScenario('dl'));
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const seqRef = useRef(0);

  function switchScenario(id: ScenarioId): void {
    setScenarioId(id);
    setSnapshot(buildScenario(id));
  }

  // Local-only event semantics (SPEC §6.2 demo column). Everything here is
  // explicitly simulated; nothing leaves the page.
  const handler = useMemo(
    () => (event: WorkbenchEvent): EventOutcome => {
      seqRef.current += 1;
      let outcome: EventOutcome;

      switch (event.type) {
        case 'select':
          outcome = { ok: true, message: `本地定位：${event.target.kind} → ${event.target.label}` };
          break;

        case 'create_trial': {
          const key = event.draft.componentRefs[0]?.key ?? '';
          const component = snapshot.tailor.data?.components.find((c) => c.componentKey === key);
          if (component !== undefined && !component.canCreateTrial) {
            outcome = {
              ok: false,
              message: '创建 Trial 被拒绝（演示）',
              reason: component.createTrialReason ?? '该组件当前不可创建 Trial。',
            };
          } else {
            outcome = { ok: true, message: '已模拟提交 Trial 草稿，未运行真实实验（演示）。' };
          }
          break;
        }

        case 'attach_citation': {
          if (snapshot.papers.data === null) {
            outcome = { ok: false, message: '引用失败（演示）', reason: '文献区域当前不可用。' };
            break;
          }
          setSnapshot((prev) => {
            if (prev.papers.data === null) return prev;
            const papers = prev.papers.data.papers.map((p) => {
              if (p.paperKey !== event.paperKey) return p;
              if (p.citations.some((c) => c.key === event.experimentKey)) return p;
              return {
                ...p,
                citations: [...p.citations, { kind: 'experiment' as const, key: event.experimentKey, label: `实验 ${event.experimentKey}（本地新增引用）` }],
                flags: p.flags.includes('cited') ? p.flags : [...p.flags, 'cited' as const],
              };
            });
            return { ...prev, papers: { ...prev.papers, data: { ...prev.papers.data, papers } } };
          });
          outcome = { ok: true, message: '已在本地新增论文→实验引用关系（演示，未持久化）。' };
          break;
        }

        case 'request_implementation':
          outcome = {
            ok: false,
            message: '补齐实现未接线（演示）',
            reason: '实现生成属于后端/接线阶段能力；事件已记录，未声称生成成功。',
          };
          break;

        case 'save_note': {
          if (event.text.length > 500) {
            outcome = { ok: false, message: '备注保存失败（演示）', reason: '备注最长 500 字。' };
            break;
          }
          setSnapshot((prev) => {
            if (prev.papers.data === null) return prev;
            const papers = prev.papers.data.papers.map((p) =>
              p.paperKey === event.paperKey ? { ...p, note: event.text } : p);
            return { ...prev, papers: { ...prev.papers, data: { ...prev.papers.data, papers } } };
          });
          outcome = { ok: true, message: '备注已在本会话保存（刷新页面会丢失，演示）。' };
          break;
        }

        case 'request_branch_action':
          outcome = {
            ok: true,
            message: `已记录 ${event.decision} 请求与原因（演示）；节点状态未被前端自行改判。`,
          };
          break;

        default:
          // Bootstrap research events need the real host bridge; the fixture
          // preview has none, so it says so instead of simulating a result.
          outcome = {
            ok: false,
            message: '该动作在演示环境未接线。',
            reason: '研究启动 / 编排类事件由真实 DSH 宿主桥接处理；演示预览不模拟其结果。',
          };
          break;
      }

      setLog((l) => [{ seq: seqRef.current, time: now(), event, outcome }, ...l].slice(0, 50));
      return outcome;
    },
    [snapshot],
  );

  const rejected = log.filter((l) => !l.outcome.ok).length;

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#0e1013', paddingTop: 48, boxSizing: 'border-box' }}>
      {/* demo-only toolbar — never rendered by WorkbenchView itself */}
      <div
        style={{
          position: 'absolute', top: 8, right: 12, zIndex: 80, display: 'flex', gap: 8, alignItems: 'center',
          background: 'rgba(22,25,30,.94)', border: '1px solid rgba(255,255,255,.14)', borderRadius: 10, padding: '6px 10px',
          fontSize: 12, color: '#cfd4dc',
        }}
      >
        <span title="该工具栏只存在于独立 demo，生产 WorkbenchView 不渲染它">🧪 演示控制台</span>
        <select
          aria-label="演示场景"
          value={scenarioId}
          onChange={(e) => switchScenario(e.target.value as ScenarioId)}
          style={{ background: '#101317', color: '#e9ebef', border: '1px solid rgba(255,255,255,.18)', borderRadius: 7, padding: '3px 6px', maxWidth: 220 }}
        >
          {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <button
          onClick={() => setLogOpen(!logOpen)}
          style={{ background: 'transparent', color: '#cfd4dc', border: '1px solid rgba(255,255,255,.2)', borderRadius: 7, padding: '3px 9px', cursor: 'pointer' }}
        >
          动作记录（{log.length}{rejected > 0 ? `，拒绝 ${rejected}` : ''}）
        </button>
      </div>

      {/* Key by task so switching demo scenarios resets search/filter/
          selection state that belonged to the previous task. */}
      <WorkbenchView
        key={snapshot.task.taskKey}
        snapshot={snapshot}
        onEvent={handler}
        demoBadge="演示数据 / 后端未接线 / 无网络请求"
      />

      {logOpen && (
        <div
          style={{
            position: 'absolute', right: 12, bottom: 12, zIndex: 85, width: 560, maxHeight: '46%',
            overflowY: 'auto', background: '#15181d', border: '1px solid rgba(255,255,255,.18)', borderRadius: 11,
            padding: 12, fontSize: 12, color: '#c8cdd6',
          }}
          aria-label="演示动作回调记录"
        >
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <b style={{ fontSize: 13 }}>动作回调记录（仅本地，无网络请求）</b>
            <span style={{ flex: 1 }} />
            <button className="rd-btn" style={{ padding: '2px 10px' }} onClick={() => setLog([])}>清空</button>
            <button className="rd-btn rd-btn-ghost" onClick={() => setLogOpen(false)}>×</button>
          </div>
          {log.length === 0 && <div style={{ color: '#6f7681' }}>尚无动作；试试创建 Trial、引用到实验、保存备注或研究决策。</div>}
          {log.map((l) => (
            <div key={l.seq} style={{ borderTop: '1px solid rgba(255,255,255,.07)', padding: '7px 0' }}>
              <div>
                <span style={{ color: '#6f7681' }}>#{l.seq} {l.time}</span>{' '}
                <b>{l.event.type}</b>{' '}
                <span style={{ color: l.outcome.ok ? '#7fe6bd' : '#f1a3a3' }}>
                  {l.outcome.ok ? 'OK' : 'REJECTED'}
                </span>
              </div>
              <div style={{ color: '#9aa1ab', marginTop: 2 }}>{l.outcome.message}</div>
              {l.outcome.reason !== undefined && <div style={{ color: '#f1a3a3' }}>原因：{l.outcome.reason}</div>}
              <div style={{ color: '#6f7681', fontFamily: 'monospace', marginTop: 2, whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(l.event, null, 0).slice(0, 260)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
