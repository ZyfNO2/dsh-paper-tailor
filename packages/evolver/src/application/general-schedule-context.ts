import type { GeneralResearch } from '../contracts/general-research.ts';
import type { GeneralSchedule } from '../contracts/general-schedule.ts';
import { cycleContentHash } from '../contracts/research-cycle.ts';
import { generalCycleBase } from './general-cycle-context.ts';
export const generalScheduleHash = (g: GeneralResearch, schedule: Pick<GeneralSchedule, 'ideaId' | 'tasks'>) => {
  const ids = new Set(schedule.tasks.flatMap(t => t.sourceIds));
  return cycleContentHash('approved-schedule-context-v1', { graph: generalCycleBase(g), limits: g.limits, idea: g.ideas.find(i => i.ideaId === schedule.ideaId), sources: g.sources.filter(s => ids.has(s.sourceId)), datasets: g.datasets.filter(d => ids.has(d.sourceId)), access: g.sourceAccess.filter(a => ids.has(a.sourceId)), tasks: schedule.tasks.map(t => ({ nodeId: t.nodeId, sourceIds: t.sourceIds })) });
};
