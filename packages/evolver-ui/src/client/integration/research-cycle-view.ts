import type { WorkbenchSnapshot, ResearchNodeView, WorkbenchEvent, EventOutcome } from '../redesign/view-model.ts';
import type { GeneralSchedule } from '../../../../evolver/src/contracts/general-schedule.ts';

export interface ResearchCycleData {
  schedules?: GeneralSchedule[];
  research: { researchId: string; bootstrapRevision: number; cycleRevision: number; activeRunId: string | null };
  runs: Array<{ runId: string; nodeId?: string | null; concurrencyPolicy?: { maxActiveRuns: 2; authorizedBy: string }; chain?: { rootRunId: string; parentRunId: string | null; renewedFrom?: { runId: string; reason: string; authorizedBy: string } }; executionPolicy?: { maxAttempts: number; maxRounds?: number; deadline: string | null }; stopHistory?: Array<{ status: string; error: { code: string; message: string } | null; reason: string | null; recordedAt: string }>; selectedIdeaRef?: { ideaId: string }; status: string; round: number; startedAt: string; finishedAt: string | null; error: { message: string } | null }>;
  steps: Array<{ stepId: string; runId: string; nodeId: string | null; attemptId: string; assignedMemberId: string | null; nativeTask?: { teamId: string; taskId: string }; inputRefs: Array<{ kind: string; ref: { id?: string; sha256?: string } }>; outputRefs: Array<{ id: string; sha256: string }>; attemptHistory?: Array<{ attemptId: string; status: string; error: { code: string; message: string } | null; reason: string | null; recordedAt: string }>; role: string; status: string; blocking: string[]; error: { message: string } | null }>;
  runtime?: { available: boolean; reason: string | null; mode: string; members?: Array<{ id: string; name: string; status: string; model?: string; diagnostics: string[] }>; tasks?: Array<{ id: string; revision: number; status: string; ready: boolean; ownerName?: string; writeScopeWarnings: string[] }>; limits?: { maxMembers: number; maxRounds: number; maxModelStepsPerMember: number; maxToolCallsPerMember: number; deadlineMs: number; cost: string } };
  artifacts: Array<{ artifactId: string; kind: string; runId: string; ref: { id: string; sha256: string }; createdAt: string }>;
  effectiveGraph: { nodes: Array<{ nodeId: string; kind: string; title: string; origin?: string; runId?: string; summary?: string; artifactRef?: { id: string; sha256: string } | null }>; edges: Array<{ edgeId: string; from: string; to: string; relation: string }> };
  decisions: Array<{ runId?: string; decisionRef?: { id: string; sha256: string }; decision?: string; reason?: string; nextActions?: Array<{ actionId: string; kind: string; title: string; detail: string }> }>;
  nextActions: unknown[];
}

export async function readResearchCycle(owner: string, researchId: string, signal: AbortSignal): Promise<ResearchCycleData | null> {
  const response = await fetch(`/evolver/research-cycle?sessionId=${encodeURIComponent(owner)}&researchId=${encodeURIComponent(researchId)}`, { credentials: 'same-origin', signal });
  if (response.status === 404) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? body.error ?? `Research Cycle HTTP ${response.status}`);
  if (body.schemaVersion !== 1 || body.research?.researchId !== researchId || !Array.isArray(body.steps) || !Array.isArray(body.effectiveGraph?.nodes)) throw new Error('Research Cycle projection schema mismatch');
  return body;
}

export function withResearchCycle(snapshot: WorkbenchSnapshot, cycle: ResearchCycleData | null): WorkbenchSnapshot {
  const tree = snapshot.tree.data;
  if (!cycle || !tree) return { ...snapshot, cycle };
  const kinds: Record<string, ResearchNodeView['kind']> = { proposal: 'scheme', experiment_plan: 'protocol', evidence_report: 'result', decision: 'conclusion', next_iteration: 'hypothesis', next_action: 'hypothesis' };
  const increments = cycle.effectiveGraph.nodes.filter((n) => n.origin === 'cycle' && !tree.nodes.some((base) => base.id === n.nodeId));
  const nodes: ResearchNodeView[] = [...tree.nodes.map((n) => ({ ...n })), ...increments.map((n) => ({ id: n.nodeId, kind: kinds[n.kind] ?? 'scheme', title: n.title,
    status: n.kind === 'next_action' || n.kind === 'next_iteration' || !n.artifactRef ? 'planned' as const : 'done' as const, planningStatus: 'needs_validation' as const, summary: n.summary ?? '研究循环已登记的交付物；已有证据分析或模拟不等于真实训练。',
    branch: 'main' as const, childCount: 0, x: 0, y: 0, rationale: null, outcome: null, actor: null,
    links: n.artifactRef ? [{ kind: 'external' as const, key: n.artifactRef.id, label: n.kind, ref: n.artifactRef.sha256 }] : [],
    extraSections: [{ heading: '来源运行', body: n.runId ?? '未记录' }],
  }))];
  const depths = new Map<string, number>();
  const depth = (id: string, trail = new Set<string>()): number => {
    if (depths.has(id)) return depths.get(id)!;
    if (trail.has(id)) throw new Error('Effective research graph contains a cycle');
    trail.add(id);
    const parents = cycle.effectiveGraph.edges.filter((e) => e.relation === 'depends_on' ? e.from === id : e.to === id).map((e) => depth(e.relation === 'depends_on' ? e.to : e.from, trail));
    trail.delete(id);
    const value = parents.length ? Math.max(...parents) + 1 : 0;
    depths.set(id, value); return value;
  };
  const rows = new Map<number, number>();
  for (const node of nodes) { const layer = depth(node.id), row = rows.get(layer) ?? 0; rows.set(layer, row + 1); node.x = 16 + layer * 224; node.y = 24 + row * 130; }
  return { ...snapshot, cycle, tree: { ...snapshot.tree, data: { ...tree, nodes,
    edges: cycle.effectiveGraph.edges.map((e) => ({ id: e.edgeId, sourceId: e.from, targetId: e.to, relation: e.relation === 'depends_on' ? '依赖：前置节点' : '派生', planned: true, reason: null })),
    activity: [...tree.activity, ...cycle.runs.map((r) => ({ id: r.runId, time: r.finishedAt ?? r.startedAt, action: `研究循环 · 第 ${r.round} 轮`, actor: 'Agent Team', target: null, result: r.status, detail: r.error?.message ?? null }))],
  } } };
}

export async function emitResearchCycle(owner: string, event: WorkbenchEvent): Promise<EventOutcome> {
  const response = await fetch(`/evolver/research-cycle/actions?sessionId=${encodeURIComponent(owner)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? body.error ?? `Research Cycle HTTP ${response.status}`);
  return body;
}
