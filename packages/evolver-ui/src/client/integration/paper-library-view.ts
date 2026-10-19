import type { LibraryPaper } from '../../../../evolver/src/contracts/paper-library.ts';
import type { ComponentView, PaperView, WorkbenchSnapshot } from '../redesign/view-model.ts';
import { tailorEmptyReason, summariseRuns, noFindingsFor, libraryRunStatusText, noFindingsText, type PaperRunRow } from '../redesign/view-utils.ts';
import { blankSnapshot, region } from './projection-adapter.ts';
export type PaperLibraryRow = Omit<LibraryPaper, 'pages'> & { pageCount: number };
export type { PaperRunRow };

export function librarySnapshot(owner: string, papers: PaperLibraryRow[], runs: PaperRunRow[] = []): WorkbenchSnapshot {
  // No research nodes exist in this integration: the tree region keeps the
  // empty state, and its reason states the fact instead of blaming the reader
  // (COMMAND-REPAIR-PLAN §R3.5).
  const snapshot = blankSnapshot(owner, 'empty', '本工作区还没有研究节点：当前只整理论文知识，实验编排未启用。');
  snapshot.task = { taskKey: owner, displayName: '工作区科研知识库', researchGoal: '从上传论文开始', phase: 'knowledge', revision: '1', preconditions: [] };
  snapshot.preconditions = [{ id: 'paper-scope', severity: 'info', text: '知识资产保存在工作区 .dsh/research/papers 的结构化文件中，同一工作区的会话共享；页面自动读取文件。' },
    { id: 'provisional', severity: 'info', text: 'Wiki 与组件为带原文引用的抽取草稿，需人工核对；论文中的实验不代表本地验证。' }];
  const components: ComponentView[] = papers.flatMap((p) => p.components.map((c, i) => ({
    componentKey: `${p.id}:component:${i}`, revision: p.revision ?? p.sha256, kind: c.kind,
    name: c.name, description: c.description, tags: ['论文抽取草稿', `第 ${c.page} 页`], positionKeys: [], capabilities: [], missing: ['尚未实现与验证'], integrable: null,
    integrableReason: '论文抽取不等于已完成代码接入。', validatedInTask: false, validatedElsewhere: null,
    trial: { count: 0, succeededInTask: null, lastAttemptAt: null }, rankScore: null, lastUsedAt: p.updatedAt,
    source: { author: '未知', origin: `${p.title} · 第 ${c.page} 页`, version: p.revision, license: null, url: null },
    problem: c.description, recommendedPositions: [], experimentLinks: [], paperLinks: [{ kind: 'paper', key: p.id, label: p.title }], canCreateTrial: false, createTrialReason: '本轮仅验收论文知识库，不启用实验编排。',
  })));
  const views: PaperView[] = papers.map((p) => ({
    paperKey: p.id, sourceRevision: p.sha256, metadata: { title: p.title, authors: [], year: null, venue: p.name, paperType: '上传论文', doi: null,
      url: `/evolver/paper-library?sessionId=${encodeURIComponent(owner)}&paperId=${encodeURIComponent(p.id)}`, localSource: null }, relevance: null,
    // `extracted` = the paper JSON really carries components. A non-null
    // revision only proves that SOMETHING was published (Wiki-only publishes set
    // it too), so it must never be the source of this flag
    // (COMMAND-REPAIR-SPEC §4 / ST-01).
    flags: p.components.length > 0 ? ['extracted'] : [],
    // A recorded no_findings result is the only basis for saying a run completed
    // and found nothing; with no record the page says nothing about runs at all.
    // A recorded no_findings result is the only basis for saying a run completed
    // and found nothing; with no record the page says nothing about runs at all.
    note: (() => { const reason = noFindingsFor(runs, p.id); return reason === undefined ? null : noFindingsText(true, reason); })(),
    contributions: p.components.map((c, i) => ({ id: `${p.id}:${i}`, category: c.kind === 'Experiment' ? 'evidence' : 'method', title: `${c.kind} · ${c.name}`, text: c.description,
      tags: [{ label: '论文抽取草稿', tone: 'gray' }], evidences: [{ id: `${p.id}:quote:${i}`, source: 'paper', label: '原文引用', locator: `${p.name} · 第 ${c.page} 页 · SHA256 ${p.sha256}`, condition: null, value: c.quote, unit: null }],
      componentLinks: [{ kind: 'component', key: `${p.id}:component:${i}`, label: c.name }], parameters: null, datasetInfo: null, slotMapping: [] })),
    wikiLinks: p.sections.map((s, i) => ({ key: `${p.id}:wiki:${i}`, title: s.heading, version: p.revision ?? '', statement: `${s.summary}\n\n第 ${s.page} 页原文：${s.quote}`,
      dependencies: [p.sha256], updatedAt: p.updatedAt })), citations: [], similar: [],
  }));
  // Tailor shop wording depends on whether ANY paper exists and whether a Wiki
  // was saved: "Wiki 已保存；暂无研究组件" is only honest for the latter case
  // (COMMAND-REPAIR-SPEC §4).
  snapshot.tailor = region(components.length ? 'ready' : 'empty', { positions: [], components },
    components.length ? null : tailorEmptyReason({ paperCount: papers.length, wikiPaperCount: papers.filter((p) => p.sections.length > 0).length, componentCount: components.length }));
  // Asset availability and the latest run result are stated separately: a failed
  // run must not blank out stored components, and stored components must not make
  // a failed run look successful.
  const runStatus = libraryRunStatusText(summariseRuns(runs));
  if (runStatus !== null) snapshot.preconditions.push({ id: 'command-runs', severity: runStatus.includes('失败') ? 'warning' : 'info', text: runStatus });
  snapshot.papers = region(views.length ? 'ready' : 'empty', { papers: views, experiments: [] },
    views.length ? null : '工作区知识库还没有论文。在“对话”中上传 PDF / TXT / Markdown，再运行 /wiki 保存 Wiki 或 /extract 抽取研究组件。');
  return snapshot;
}
