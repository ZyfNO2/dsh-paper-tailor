import type { ModuleCard, PaperCardV3, TaskSummary, QualifiedTask, WorkbenchSnapshotV3, WorkbenchStatusV3 } from '../../wire.ts';

export interface GrantResponse {
  capability: string | null; sessionId: string; tasks: string[];
  tier: 'owned' | 'workspace' | 'none'; expiresAt: string; note?: string;
}
export class ResearchReadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = 'ResearchReadError'; this.status = status; this.code = code; }
}

/** One capability per mounted session; never share it across workbench instances. */
export function createWorkbenchReadClient() {
  let capability: string | null = null;
  async function read<T>(url: string, signal: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (capability !== null) headers.authorization = `Bearer ${capability}`;
    const response = await fetch(url, { headers, signal, credentials: 'same-origin' });
    const body = await response.json();
    if (!response.ok) throw new ResearchReadError(response.status, body.error ?? 'HTTP', body.message ?? `HTTP ${response.status}`);
    return body as T;
  }
  return {
    clear: () => { capability = null; },
    async grant(sessionId: string, signal: AbortSignal): Promise<GrantResponse> {
      const grant = await read<GrantResponse>(`/evolver/api/scope-grant?sessionId=${encodeURIComponent(sessionId)}`, signal);
      if (signal.aborted) throw new DOMException('Read cancelled', 'AbortError');
      capability = grant.capability;
      return grant;
    },
    status: (signal: AbortSignal) => read<WorkbenchStatusV3>('/evolver/api/status', signal),
    async tasks(signal: AbortSignal): Promise<{ tasks: QualifiedTask[]; summaries: TaskSummary[] }> {
      const rows: QualifiedTask[] = [], summaries: TaskSummary[] = [];
      for (const version of [3, 2]) {
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
          const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
          const page: { tasks: (QualifiedTask | TaskSummary)[]; nextCursor: string | null } = await read(`/evolver/api/tasks?schemaVersion=${version}&limit=100${suffix}`, signal);
          if (version === 3) rows.push(...page.tasks as QualifiedTask[]);
          else summaries.push(...page.tasks as TaskSummary[]);
          cursor = page.nextCursor;
          if (cursor !== null) {
            if (seen.has(cursor)) throw new Error('Task pagination repeated its cursor');
            seen.add(cursor);
          }
        } while (cursor !== null);
      }
      return { tasks: rows, summaries };
    },
    snapshot: (taskId: string, signal: AbortSignal) => read<WorkbenchSnapshotV3>(`/evolver/api/tasks/${encodeURIComponent(taskId)}/workbench?schemaVersion=3`, signal),
    modules: (taskId: string, signal: AbortSignal) => read<{ modules: ModuleCard[] }>(`/evolver/api/modules?taskId=${encodeURIComponent(taskId)}`, signal),
    papers: (signal: AbortSignal) => read<{ papers: PaperCardV3[] }>('/evolver/api/papers?schemaVersion=3', signal),
  };
}
