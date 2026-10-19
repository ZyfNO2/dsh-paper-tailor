/**
 * BrainstormPage — region wrapper + action wiring for the brainstorm tab.
 *
 * FE-02 §2/§6: the page keeps the region contract of the other three tabs
 * (loading / empty / error / stale each keep their real state) and translates
 * user intent into events carrying stable ids and the revision the user saw.
 *
 * When the snapshot has no bootstrap region at all, this is the "尚未启动" state
 * with a real entry point — not a compat error and not mock data (FE-R01).
 */
import { useEffect, useState } from 'react';
import { RegionStateView, useWorkbench } from './WorkbenchView.tsx';
import { BrainstormView } from './BrainstormView.tsx';
import { ResearchStartPanel, draftFromForm, useStartForm, type StartFormValue } from './ResearchStartPanel.tsx';
import { receiptText } from './research-actions.ts';
import { newestReceipt } from './brainstorm-rounds.ts';

export function BrainstormPage(props: { hidden: boolean }): JSX.Element {
  const { snapshot, research, unavailableActions } = useWorkbench();
  const region = snapshot.bootstrap ?? null;
  const [optimisticSelection, setOptimisticSelection] = useState<string[] | null>(null);
  useEffect(() => {
    if (optimisticSelection !== null && JSON.stringify([...optimisticSelection].sort()) === JSON.stringify([...(region?.data?.selectedIdeaIds ?? [])].sort())) setOptimisticSelection(null);
  }, [region?.data?.selectedIdeaIds, optimisticSelection]);
  // The start form is owned here (before any early return) so a failed start
  // keeps what the user typed instead of resetting the questionnaire
  // (FE-02 §3: 错误时保留正在输入的表单).
  const activeContract = region?.data?.researches
    .find((r) => r.researchId === region.data?.activeResearchId)?.contract ?? null;
  const { form: startForm, setForm: setStartForm } = useStartForm(activeContract);

  if (region === null) {
    // No bootstrap region: a legacy paper-only snapshot. The old pages render
    // normally elsewhere; here the honest state is "research not started".
    return (
      <div className="rd-state">
        <div className="rd-stateTitle">研究尚未启动</div>
        <div style={{ maxWidth: 560 }}>
          当前快照没有研究启动数据：本工程还在整理论文知识。写一句话即可开始，未知项保持未确定。
        </div>
        <div style={{ width: 'min(860px, 100%)' }}>
          <ResearchStartPanel
            contract={null}
            environment={[]}
            probing={research.isPending('probe')}
            saving={research.isPending('save') || research.isPending('start')}
            error={research.state.error}
            value={startForm}
            onChange={setStartForm}
            onProbe={() => { void research.probe(); }}
            onSave={(draft) => { void research.start(draft); }}
          />
        </div>
        {unavailableActions.start_research !== undefined && (
          <div className="rd-broken">动作不可用：{unavailableActions.start_research}</div>
        )}
      </div>
    );
  }

  return (
    <RegionStateView state={region.state}>
      {region.data !== null ? (
        <BrainstormView
          data={optimisticSelection === null ? region.data : { ...region.data, selectedIdeaIds: optimisticSelection }}
          selecting={optimisticSelection !== null}
          hidden={props.hidden}
          generating={research.isPending('generate')}
          saving={research.isPending('save')}
          probing={research.isPending('probe')}
          error={research.state.error ?? (research.outcomeOf('generate')?.ok === false
            ? receiptText(research.outcomeOf('generate')) : null)}
          // BR-FE2: the newest receipt by ACTUAL time and identity — never by a fixed
          // action-type priority, so a stale save conflict cannot outrank a fresh failure.
          receipt={(() => {
            const entries = ['save', 'start', 'generate', 'select-ideas', 'initialize', 'probe'].map((key) => ({
              key,
              text: receiptText(research.outcomeOf(key)) ?? '',
              at: research.outcomeOf(key)?.receivedAt ?? null,
            }));
            return newestReceipt(entries);
          })()}
          onEditIdea={(ideaId, revision, patch) => { void research.editIdea(ideaId, revision, patch); }}
          onToggleSelect={(ideaId, on) => {
            const current = new Set(region.data?.selectedIdeaIds ?? []);
            if (on) current.add(ideaId); else current.delete(ideaId);
            const desired = [...current];
            setOptimisticSelection(desired);
            void research.selectIdeas(desired).then((outcome) => {
              if (!outcome.ok) setOptimisticSelection(null);
            });
          }}
          onGenerate={(retainPrevious) => {
            const contract = region.data?.researches.find((r) => r.researchId === region.data?.activeResearchId)?.contract ?? null;
            void research.generate(contract?.revision ?? null, retainPrevious);
          }}
          onInitialize={(ideaIds) => {
            const contract = region.data?.researches.find((r) => r.researchId === region.data?.activeResearchId)?.contract ?? null;
            void research.initialize(ideaIds, contract?.revision ?? null);
          }}
          onProbe={() => { void research.probe(); }}
          onSaveContract={(confirm, form: StartFormValue) => {
            const contract = region.data?.researches.find((r) => r.researchId === region.data?.activeResearchId)?.contract ?? null;
            void research.saveContract(draftFromForm(form), confirm, contract?.revision ?? null);
          }}
          onSelectResearch={(researchId) => { void research.selectResearch(researchId); }}
        />
      ) : (
        <div className="rd-state">
          <div className="rd-stateTitle">还没有研究草稿</div>
          <div style={{ maxWidth: 560, marginBottom: 8 }}>
            {region.state.reason ?? '写一句话说明研究问题即可保存草稿；基线、数据、预算都可保持未确定。'}
          </div>
          <div style={{ width: 'min(860px, 100%)' }}>
            <ResearchStartPanel
              contract={null}
              environment={[]}
              probing={research.isPending('probe')}
              saving={research.isPending('save') || research.isPending('start')}
              error={research.state.error}
              value={startForm}
              onChange={setStartForm}
              onProbe={() => { void research.probe(); }}
              onSave={(draft) => { void research.start(draft); }}
            />
          </div>
          {unavailableActions.start_research !== undefined && (
            <div className="rd-broken">动作不可用：{unavailableActions.start_research}</div>
          )}
        </div>
      )}
    </RegionStateView>
  );
}
