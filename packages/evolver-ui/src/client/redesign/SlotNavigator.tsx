/**
 * SlotNavigator — positions of the current node, their candidates and the
 * loading action.
 *
 * FE-02 §5: a Slot is a POSITION, a candidate is a component or design idea.
 * Clicking a slot scopes the middle column to its candidates; the right side
 * explains the reason, evidence and the still-unknown interface facts. Loading
 * updates the node's PLAN SNAPSHOT only — it never installs code, never claims
 * integration success and never adds a trial (shared spec §5).
 */
import { useState } from 'react';
import { Icon } from './icons.tsx';
import { Chip, ObjectLinkButton, useAsyncAction } from './controls.tsx';
import { useWorkbench } from './WorkbenchView.tsx';
import { RevisionValue } from './Inspector.tsx';
import {
  CANDIDATE_ASSESSMENT_META,
  SLOT_SCOPE_LABEL,
  SLOT_STATUS_META,
  candidateLoadability,
  slotCaption,
} from './view-utils.ts';
import type { SlotCandidateView, SlotView } from './view-model.ts';

export function SlotNavigator(props: {
  slots: SlotView[];
  /** The current node these slots belong to; null when nothing is selected. */
  nodeId: string | null;
  onLoad: (slot: SlotView, candidate: SlotCandidateView) => Promise<{ ok: boolean; message: string }>;
  onToggleLock: (slot: SlotView, locked: boolean) => Promise<{ ok: boolean; message: string }>;
}): JSX.Element {
  const { unavailableActions } = useWorkbench();
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null);

  if (props.slots.length === 0) {
    return (
      <div className="rd-emptyHint">
        当前节点没有插槽草稿。未确定 Baseline 时仍会保留通用位置草稿与骨架。
      </div>
    );
  }

  const active = props.slots.find((s) => s.slotId === activeSlotId) ?? null;

  return (
    <div className="rd-slotNav">
      <div className="rd-slotList">
        {props.slots.map((s) => (
          <button key={s.slotId} className={`rd-slotItem${s.slotId === activeSlotId ? ' rd-selected' : ''}`}
            aria-pressed={s.slotId === activeSlotId} onClick={() => setActiveSlotId(s.slotId === activeSlotId ? null : s.slotId)}>
            <span className="rd-row" style={{ gap: 6 }}>
              <Icon name={s.locked ? 'blocked' : 'cube'} size={14} />
              <span className="rd-slotName">{s.name}</span>
              {s.locked && <Chip tone="yellow">已锁定</Chip>}
            </span>
            <span className="rd-dim" style={{ fontSize: 12 }}>{slotCaption(s)}</span>
          </button>
        ))}
      </div>

      {active !== null && (
        <SlotDetail
          slot={active}
          nodeId={props.nodeId}
          onLoad={props.onLoad}
          onToggleLock={props.onToggleLock}
          lockDisabled={unavailableActions.set_slot_locked}
        />
      )}
    </div>
  );
}

function SlotDetail(props: {
  slot: SlotView;
  nodeId: string | null;
  onLoad: (slot: SlotView, candidate: SlotCandidateView) => Promise<{ ok: boolean; message: string }>;
  onToggleLock: (slot: SlotView, locked: boolean) => Promise<{ ok: boolean; message: string }>;
  lockDisabled: string | undefined;
}): JSX.Element {
  const { slot } = props;
  const load = useAsyncAction();
  const lock = useAsyncAction();

  return (
    <div className="rd-slotDetail">
      <div className="rd-row">
        <b style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{slot.name}</b>
        <span className="rd-spacer" />
        <Chip cls={SLOT_STATUS_META[slot.status].cls}>{SLOT_STATUS_META[slot.status].label}</Chip>
        <Chip tone="gray">{SLOT_SCOPE_LABEL[slot.scope]}</Chip>
      </div>
      {/* A draft universal position and a confirmed domain slot look different
          on purpose (FE-02 §5). */}
      {slot.kind === 'draft' ? (
        <div className="rd-hint">通用位置草稿：不是已确认的领域结构，未识别位置保持未知。</div>
      ) : (
        <div className="rd-dim" style={{ fontSize: 12.5 }}>领域位置：{slot.basis ?? '依据未记录'}</div>
      )}
      <div className="rd-dim" style={{ fontSize: 12.5 }}>{slot.role ?? '角色未记录'}</div>
      <div className="rd-dim" style={{ fontSize: 12.5 }}>
        输入 {slot.inputs === null ? '未知' : slot.inputs.join('、') || '未知'} ·
        输出 {slot.outputs === null ? '未知' : slot.outputs.join('、') || '未知'}
      </div>
      {slot.constraints.length > 0 && (
        <div className="rd-row" style={{ flexWrap: 'wrap' }}>
          {slot.constraints.map((c, i) => <Chip key={`${i}-${c}`} tone="gray">{c}</Chip>)}
        </div>
      )}
      <div className="rd-dim" style={{ fontSize: 12 }}>
        当前绑定：{slot.boundRef === null ? '未装入' : slot.boundRef.label}
        {slot.snapshotRef !== null && ` · 方案快照 ${slot.snapshotRef.snapshotId} 第 ${slot.snapshotRef.revision} 版`}
      </div>

      <div className="rd-row">
        <span className="rd-dim" style={{ fontSize: 12.5 }}>候选 {slot.candidates.length} 项（候选是组件或设计稿，不是插槽本身）</span>
        <span className="rd-spacer" />
        <button className="rd-btn" disabled={lock.pending} title={props.lockDisabled}
          onClick={async () => { await lock.run(() => props.onToggleLock(slot, !slot.locked)); }}>
          <Icon name={slot.locked ? 'blocked' : 'link'} size={13} />
          {slot.locked ? '解除锁定' : '锁定此位置'}
        </button>
      </div>
      {slot.locked && slot.lockedBy !== null && (
        <div className="rd-hint">由 {slot.lockedBy} 锁定；锁定后不会被自动替换。</div>
      )}
      {lock.error !== null && <div className="rd-reject">{lock.error}</div>}

      <div className="rd-candList">
        {slot.candidates.length === 0 ? (
          <div className="rd-dim">暂无候选组件。</div>
        ) : slot.candidates.map((c) => {
          const loadable = candidateLoadability(c, slot);
          return (
            <div key={`${c.ref.kind}:${c.ref.key}`} className="rd-candItem" data-assessment={c.assessment}>
              <div className="rd-row">
                {c.kind === 'design_idea' ? (
                  // A generated design is labelled as an idea/design — never as
                  // an extracted paper source (FE-02 §5).
                  <Chip tone="purple">设计稿</Chip>
                ) : (
                  <Chip tone="blue">论文组件</Chip>
                )}
                <ObjectLinkButton link={c.ref} />
                <span className="rd-spacer" />
                <Chip cls={CANDIDATE_ASSESSMENT_META[c.assessment].cls}>{CANDIDATE_ASSESSMENT_META[c.assessment].label}</Chip>
              </div>
              <div className="rd-dim rd-candReason">{c.reason ?? '未记录推荐理由'}</div>
              {c.missingInterfaceInfo.length > 0 && (
                <div className="rd-hint">接口未知项：{c.missingInterfaceInfo.join('；')}</div>
              )}
              {c.evidenceRefs.length > 0 && (
                <div className="rd-row" style={{ flexWrap: 'wrap' }}>
                  {c.evidenceRefs.map((e, i) => (
                    <span key={`${e.key}-${i}`} className="rd-row" style={{ gap: 4 }}>
                      <Icon name="quote" size={11} color="#6f7681" />
                      <ObjectLinkButton link={e} />
                    </span>
                  ))}
                </div>
              )}
              <div className="rd-row">
                <span className="rd-dim" style={{ fontSize: 11.5 }}>{c.ref.revision ?? '版本未知'}</span>
                <span className="rd-spacer" />
                {/* Loading is a plan-snapshot update; incompatible and locked
                    never load, needs_review loads only as 待验证 (FE-R06). */}
                <button className="rd-btn" disabled={!loadable.loadable || load.pending}
                  title={loadable.reason ?? props.nodeId === null ? loadable.reason ?? '未选中节点' : undefined}
                  onClick={async () => { await load.run(() => props.onLoad(slot, c)); }}>
                  {loadable.label}
                </button>
              </div>
              {loadable.reason !== null && loadable.loadable && (
                <div className="rd-dim" style={{ fontSize: 11.5 }}>{loadable.reason}</div>
              )}
            </div>
          );
        })}
      </div>
      {load.error !== null && <div className="rd-reject">{load.error}</div>}
      {slot.snapshotRef !== null && (
        <div className="rd-dim" style={{ fontSize: 11.5 }}>
          装入只更新本节点方案快照（<RevisionValue value={slot.snapshotRef.snapshotId} keep={10} />），
          不改动代码、不产生实验记录。
        </div>
      )}
    </div>
  );
}
