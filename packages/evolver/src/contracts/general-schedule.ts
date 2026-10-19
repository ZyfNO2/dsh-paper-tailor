import { object, str, num, list, one, hash } from './general-data.ts';
import { timestamp } from './general-evidence.ts';
export interface GeneralSchedule {
  scheduleId: string; researchId: string; ideaId: string; contextHash: string;
  status: 'pending' | 'running' | 'stopped' | 'completed'; coordinationRevision: number;
  maxTasks: number; deadline: string | null; createdAt: string; updatedAt: string;
  authorizedBy: string; error: { code: string; message: string } | null;
  stopHistory: { code: string; message: string; recordedAt: string }[];
  tasks: { taskId: string; nodeId: string; sourceIds: string[]; runId: string | null; status: 'pending' | 'starting' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled' | 'interrupted' }[];
}
export function validateGeneralSchedule(v: unknown): GeneralSchedule {
  const s = object(v, ['scheduleId', 'researchId', 'ideaId', 'contextHash', 'status', 'coordinationRevision', 'maxTasks', 'deadline', 'createdAt', 'updatedAt', 'authorizedBy', 'error', 'tasks', 'stopHistory'], 'schedule');
  const tasks = list(s.tasks, 'scheduled tasks', 10).map(v => {
    const t = object(v, ['taskId', 'nodeId', 'sourceIds', 'runId', 'status'], 'scheduled task');
    const sourceIds = list(t.sourceIds, 'schedule sources', 10).map(id => str(id, 'source ID', 200, true));
    if (new Set(sourceIds).size !== sourceIds.length) throw new Error('Duplicate scheduled source');
    return { taskId: str(t.taskId, 'taskId', 200, true), nodeId: str(t.nodeId, 'nodeId', 200, true), sourceIds, runId: t.runId === null ? null : str(t.runId, 'scheduled runId', 200, true), status: one(t.status, ['pending', 'starting', 'running', 'completed', 'blocked', 'failed', 'cancelled', 'interrupted'] as const, 'task status') };
  });
  const maxTasks = num(s.maxTasks, 'maxTasks', 1, 10);
  if (!tasks.length || tasks.length > maxTasks || new Set(tasks.map(t => t.taskId)).size !== tasks.length || new Set(tasks.map(t => t.nodeId)).size !== tasks.length) throw new Error('Invalid scheduled task count/identity');
  for (const t of tasks) if (['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(t.status) && !t.runId) throw new Error('Scheduled status requires a real run');
  const status = one(s.status, ['pending', 'running', 'stopped', 'completed'] as const, 'schedule status');
  if ((status === 'completed') !== tasks.every(t => t.status === 'completed')) throw new Error('Schedule completion differs from tasks');
  const error = s.error === null ? null : object(s.error, ['code', 'message'], 'schedule error');
  const stopHistory = list(s.stopHistory, 'schedule stop history', 100).map(v => { const h = object(v, ['code', 'message', 'recordedAt'], 'schedule stop'); return { code: str(h.code, 'stop code', 100, true), message: str(h.message, 'stop message', 4000, true), recordedAt: timestamp(h.recordedAt) }; });
  return { stopHistory, scheduleId: str(s.scheduleId, 'scheduleId', 200, true), researchId: str(s.researchId, 'researchId', 200, true), ideaId: str(s.ideaId, 'ideaId', 200, true), contextHash: hash(s.contextHash), status, coordinationRevision: num(s.coordinationRevision, 'coordinationRevision', 0, Number.MAX_SAFE_INTEGER), maxTasks, deadline: s.deadline === null ? null : timestamp(s.deadline), createdAt: timestamp(s.createdAt), updatedAt: timestamp(s.updatedAt), authorizedBy: str(s.authorizedBy, 'schedule authorizer', 200, true), error: error ? { code: str(error.code, 'schedule error code', 100, true), message: str(error.message, 'schedule error message', 4000, true) } : null, tasks };
}
