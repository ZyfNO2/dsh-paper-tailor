import { BootstrapError } from '../contracts/research-bootstrap.ts';
import { createGeneralResearch, validateGeneralResearch, type GeneralMethod, type GeneralResearch } from '../contracts/general-research.ts';
import { ResearchBootstrapStore, createResearch, requireResearch, type MutationResult } from './research-bootstrap-store.ts';
import { GeneralMaterialStore } from './general-material-store.ts';

import { recordGeneralEdit } from './general-edit-history.ts';
interface WriteContext { operationId: string; baseRevision: number }
/** User-authored generic planning, using the existing cross-process CAS/receipt store. */
export class GeneralResearchService {
  readonly store: ResearchBootstrapStore;
  constructor(store: ResearchBootstrapStore) { this.store = store; }

  create(input: WriteContext & { title: string; question: string; domains: string[]; methods: GeneralMethod[]; entryMode: GeneralResearch['entryMode'] }): MutationResult<{ researchId: string }> {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 300 || typeof input.question !== 'string' || !input.question.trim()) throw new BootstrapError('INVALID_INPUT', '研究名称和 Idea / 研究问题不能为空。');
    return this.store.mutate({
      operationId: input.operationId, baseRevision: input.baseRevision, kind: 'create_general_research', researchId: null,
      requestPayload: { title: input.title, question: input.question, domains: input.domains, methods: input.methods, entryMode: input.entryMode },
      apply: context => {
        // Validate before inserting. No file/agent/code execution occurs here.
        const general = createGeneralResearch({ ...input, now: context.now(), mint: context.mint });
        const research = createResearch(context.state, { title: input.title.trim(), now: context.now(), mint: context.mint });
        research.general = general;
        research.contract.researchQuestion = input.question;
        research.contract.goal = input.question;
        context.state.activeResearchId = research.researchId;
        return { changed: true, result: { researchId: research.researchId } };
      },
    });
  }

  select(input: WriteContext & { researchId: string }): MutationResult<{ researchId: string }> {
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, kind: 'select_general_research', researchId: input.researchId, requestPayload: { researchId: input.researchId }, apply: context => {
      requireResearch(context.state, input.researchId);
      context.state.activeResearchId = input.researchId;
      return { changed: true, result: { researchId: input.researchId } };
    } });
  }

  saveIdea(input: WriteContext & { researchId: string; ideaId: string; question: string; rationale: string; verificationPlan: string; sourceRefs: string[] }): MutationResult<{ ideaId: string; ideaRevision: number }> {
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, kind: 'save_general_idea', researchId: input.researchId,
      requestPayload: { researchId: input.researchId, ideaId: input.ideaId, question: input.question, rationale: input.rationale, verificationPlan: input.verificationPlan, sourceRefs: input.sourceRefs }, apply: context => {
        const research = requireResearch(context.state, input.researchId);
        if (!research.general) throw new BootstrapError('INVALID_INPUT', '历史算法 Idea 请使用现有严格编辑入口。');
        const idea = research.general.ideas.find(i => i.ideaId === input.ideaId);
        if (!idea) throw new BootstrapError('NOT_FOUND', 'Idea 不属于当前研究。');
        if (!Array.isArray(input.sourceRefs)) throw new BootstrapError('INVALID_INPUT', 'sourceRefs 必须是已登记来源 ID 数组。');
        const materials = new GeneralMaterialStore(this.store.workspaceRoot);
        for (const ref of input.sourceRefs) {
          const source = research.general.sources.find(s => s.sourceId === ref);
          if (!source) throw new BootstrapError('SOURCE_MISSING', '资料来源不属于当前研究，不能绑定未知引用。');
          materials.readRaw(source);
        }
        research.general.ideaHistory.push(structuredClone(idea));
        Object.assign(idea, { question: input.question, rationale: input.rationale, verificationPlan: input.verificationPlan, sourceRefs: input.sourceRefs, revision: idea.revision + 1, updatedAt: context.now() });
        research.general.revision++;
        research.general = validateGeneralResearch(research.general);
        research.updatedAt = context.now();
        return { changed: true, result: { ideaId: idea.ideaId, ideaRevision: idea.revision } };
      },
    });
  }

  saveLayout(input: WriteContext & { researchId: string; positions: GeneralResearch['layout'] }): MutationResult<{ researchId: string }> {
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, kind: 'save_general_layout', researchId: input.researchId, requestPayload: { researchId: input.researchId, positions: input.positions }, apply: context => {
      const research = requireResearch(context.state, input.researchId);
      if (!research.general) throw new BootstrapError('INVALID_INPUT', '该研究没有通用规划图。');
      // Validate partial layout, preserving every other position and all execution facts.
      validateGeneralResearch({ ...research.general, layout: input.positions });
      const beforeGraph = structuredClone(research.general.graph), beforeLayout = structuredClone(research.general.layout);
      research.general.layout = { ...research.general.layout, ...input.positions };
      recordGeneralEdit(research.general, beforeGraph, beforeLayout, input.operationId, context.now());
      research.general.revision++; research.general = validateGeneralResearch(research.general);
      research.updatedAt = context.now();
      return { changed: true, result: { researchId: input.researchId } };
    } });
  }
}
