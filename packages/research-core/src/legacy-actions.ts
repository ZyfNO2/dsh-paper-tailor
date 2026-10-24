import * as os from 'node:os';
import { GeneralDataService } from '../../evolver/src/application/general-data-service.ts';
import { GeneralWorkflowService } from '../../evolver/src/application/general-workflow-service.ts';
import { GeneralKnowledgeService } from '../../evolver/src/application/general-knowledge-service.ts';
import { GeneralWikiService } from '../../evolver/src/application/general-wiki-service.ts';
import { GeneralMetricService } from '../../evolver/src/application/general-metric-service.ts';
import { GeneralAnalysisService } from '../../evolver/src/application/general-analysis-service.ts';
import { GeneralInferenceService } from '../../evolver/src/application/general-inference-service.ts';
import { GeneralEvidenceService } from '../../evolver/src/application/general-evidence-service.ts';
import { GeneralReportService } from '../../evolver/src/application/general-report-service.ts';
import { GeneralFollowupService } from '../../evolver/src/application/general-followup-service.ts';
import { GeneralPackageService } from '../../evolver/src/application/general-package-service.ts';
import type { ResearchBootstrapStore, MutationResult } from '../../evolver/src/application/research-bootstrap-store.ts';
import { ResearchCoreError } from '../../research-contracts/src/index.ts';

/** Explicit allowlist: transport changes, original validators and service semantics do not. */
export function generalAction(store: ResearchBootstrapStore, body: Record<string, unknown>, actorIdentity?: string): MutationResult<Record<string, unknown>> {
  for (const field of ['actor', 'identity', 'workspaceRoot', 'workspaceDir', 'actorId', 'ownerSessionId']) {
    if (field in body) throw new ResearchCoreError('INVALID_INPUT', `${field} is supplied by the trusted transport`);
  }
  if (typeof body.researchId !== 'string' || !body.researchId.trim()) throw new ResearchCoreError('INVALID_INPUT', 'researchId required');
  const identity = actorIdentity ?? `local-user:${os.userInfo().username}`;
  const workflow = new GeneralWorkflowService(store), knowledge = new GeneralKnowledgeService(store), wiki = new GeneralWikiService(store);
  const data = new GeneralDataService(store), metric = new GeneralMetricService(store), analysis = new GeneralAnalysisService(store), inference = new GeneralInferenceService(store);
  const invoke = <I, R>(fn: (input: I) => R, extra: Record<string, unknown> = {}) => fn({ ...body, ...extra } as I);
  switch (body.type) {
    case 'adopt_general_imported_plan': {
      const packages = new GeneralPackageService(store);
      return invoke((i: Parameters<typeof packages.adoptImportedPlan>[0]) => packages.adoptImportedPlan(i, identity));
    }
    case 'import_general_material': return invoke(data.importMaterial.bind(data));
    case 'save_general_dictionary': return invoke(data.saveDictionary.bind(data));
    case 'save_general_profile': return invoke(workflow.saveProfile.bind(workflow));
    case 'save_general_node': return invoke(workflow.saveNode.bind(workflow));
    case 'save_general_edge': return invoke(workflow.saveEdge.bind(workflow));
    case 'remove_general_graph_item': return invoke(workflow.remove.bind(workflow));
    case 'undo_general_graph_edit': return invoke(workflow.edit.bind(workflow), { direction: 'undo' });
    case 'redo_general_graph_edit': return invoke(workflow.edit.bind(workflow), { direction: 'redo' });
    case 'clear_general_edit_history': return invoke(workflow.clearEditHistory.bind(workflow));
    case 'save_general_team_task': return invoke(workflow.saveTeamTaskDraft.bind(workflow));
    case 'confirm_general_manual_node': return invoke((i: Parameters<typeof workflow.confirmNode>[0]) => workflow.confirmNode(i, identity));
    case 'save_general_knowledge': return invoke(knowledge.save.bind(knowledge));
    case 'save_general_knowledge_relation': return invoke(knowledge.saveRelation.bind(knowledge));
    case 'save_general_knowledge_layout': return invoke(knowledge.saveLayout.bind(knowledge));
    case 'save_general_wiki_board': return invoke(wiki.saveBoard.bind(wiki));
    case 'import_general_wiki_okf': return invoke(wiki.importOkf.bind(wiki));
    case 'start_general_wiki_task': return invoke(wiki.prepare.bind(wiki));
    case 'publish_general_wiki_task': return invoke(wiki.publish.bind(wiki));
    case 'fail_general_wiki_task': return invoke(wiki.publish.bind(wiki), { result: '', entries: [], error: '用户结束任务；已发布内容保留，迟到产物拒绝。' });
    case 'suggest_general_metrics': return invoke(metric.suggest.bind(metric));
    case 'save_general_metric_protocol': return invoke(metric.save.bind(metric));
    case 'register_general_metric_report': return invoke(metric.report.bind(metric));
    case 'save_general_analysis_plan': return invoke(analysis.savePlan.bind(analysis));
    case 'calculate_general_descriptive': return invoke(analysis.calculate.bind(analysis));
    case 'review_general_evidence': return invoke((i: Parameters<typeof analysis.review>[0]) => analysis.review(i, identity));
    case 'save_general_inference_plan': return invoke((i: Parameters<typeof inference.savePlan>[0]) => inference.savePlan(i, identity));
    case 'execute_general_inference': return invoke(inference.execute.bind(inference));
    case 'set_general_source_access': {
      const evidence = new GeneralEvidenceService(store);
      return invoke((i: Parameters<typeof evidence.setAccess>[0]) => evidence.setAccess(i, identity));
    }
    case 'create_general_report_fact_pack': {
      const report = new GeneralReportService(store); return invoke(report.create.bind(report));
    }
    case 'adopt_general_review_action': {
      const followup = new GeneralFollowupService(store); return invoke((i: Parameters<typeof followup.adopt>[0]) => followup.adopt(i, identity));
    }
    default: throw new ResearchCoreError('INVALID_INPUT', `UNSUPPORTED_ACTION: ${String(body.type)} 尚未适配；未保存或派发。`);
  }
}
