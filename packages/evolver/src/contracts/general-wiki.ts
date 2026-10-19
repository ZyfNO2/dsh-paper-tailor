import { validateGeneralEvidenceLocator, type GeneralEvidenceLocator } from './general-evidence.ts';
import { object, str, num, list, one, hash } from './general-data.ts';

export interface WikiCard { instanceId: string; entryId: string; x: number; y: number; width: number; height: number; group: string }
export interface WikiBoard { boardId: string; title: string; cards: WikiCard[]; links: { from: string; to: string; label: string }[]; view: { x: number; y: number; scale: number } }
export interface WikiTask {
  citations?: GeneralEvidenceLocator[]; taskId: string; kind: 'ingest' | 'query'; goal: string; status: 'pending' | 'completed' | 'failed';
  sources: { sourceId: string; sha256: string }[]; knowledgeHash: string; result: string; error: string; createdAt: string;
}
export interface WikiWorkspace { boards: WikiBoard[]; tasks: WikiTask[]; events: { at: string; kind: string; text: string }[] }
export const emptyWikiWorkspace = (): WikiWorkspace => ({ boards: [], tasks: [], events: [] });
export function validateWikiWorkspace(raw: unknown): WikiWorkspace {
  const w = object(raw, ['boards', 'tasks', 'events'], 'wiki workspace');
  const coordinate = (v: unknown) => { if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 100000) throw new Error('Invalid wiki coordinate'); return v; };
  const boards = list(w.boards, 'wiki boards', 50).map(value => {
    const b = object(value, ['boardId', 'title', 'cards', 'links', 'view'], 'wiki board');
    const cards = list(b.cards, 'wiki cards', 500).map(value => {
      const c = object(value, ['instanceId', 'entryId', 'x', 'y', 'width', 'height', 'group'], 'wiki card');
      return { instanceId: str(c.instanceId, 'card id', 200, true), entryId: str(c.entryId, 'entry id', 200, true), x: coordinate(c.x), y: coordinate(c.y), width: num(c.width, 'card width', 220, 1600), height: num(c.height, 'card height', 180, 2000), group: str(c.group, 'card group', 100) };
    });
    if (new Set(cards.map(c => c.instanceId)).size !== cards.length) throw new Error('Duplicate wiki card instance');
    const links = list(b.links, 'board links', 1000).map(value => { const l = object(value, ['from', 'to', 'label'], 'board link'); const from = str(l.from, 'link from', 200, true), to = str(l.to, 'link to', 200, true); if (from === to || !cards.some(c => c.instanceId === from) || !cards.some(c => c.instanceId === to)) throw new Error('Board link references missing card'); return { from, to, label: str(l.label, 'link label', 200) }; });
    const v = object(b.view, ['x', 'y', 'scale'], 'board view');
    if (typeof v.scale !== 'number' || !Number.isFinite(v.scale) || v.scale < .25 || v.scale > 3) throw new Error('Invalid board scale');
    return { boardId: str(b.boardId, 'board id', 200, true), title: str(b.title, 'board title', 200, true), cards, links, view: { x: coordinate(v.x), y: coordinate(v.y), scale: v.scale } };
  });
  if (new Set(boards.map(b => b.boardId)).size !== boards.length) throw new Error('Duplicate wiki board');
  const tasks = list(w.tasks, 'wiki tasks', 100).map(value => {
    const t = object(value, ['taskId', 'kind', 'goal', 'status', 'sources', 'knowledgeHash', 'result', 'error', 'createdAt', 'citations'], 'wiki task', ['citations']);
    const sources = list(t.sources, 'task sources', 10).map(value => { const s = object(value, ['sourceId', 'sha256'], 'task source'); return { sourceId: str(s.sourceId, 'source id', 200, true), sha256: hash(s.sha256) }; });
    return { ...(t.citations === undefined ? {} : { citations: list(t.citations, 'answer citations', 20).map(validateGeneralEvidenceLocator) }), taskId: str(t.taskId, 'task id', 200, true), kind: one(t.kind, ['ingest', 'query'] as const, 'task kind'), goal: str(t.goal, 'wiki goal', 4000, true), status: one(t.status, ['pending', 'completed', 'failed'] as const, 'task status'), sources, knowledgeHash: hash(t.knowledgeHash), result: str(t.result, 'wiki result', 24000), error: str(t.error, 'wiki error', 4000), createdAt: str(t.createdAt, 'task time', 100, true) };
  });
  if (new Set(tasks.map(t => t.taskId)).size !== tasks.length) throw new Error('Duplicate wiki task');
  const events = list(w.events, 'wiki events', 2000).map(value => { const e = object(value, ['at', 'kind', 'text'], 'wiki event'); const at = str(e.at, 'event time', 100, true); if (!Number.isFinite(Date.parse(at))) throw new Error('Invalid wiki event timestamp'); return { at, kind: str(e.kind, 'event kind', 100, true), text: str(e.text, 'event text', 4000, true) }; });
  return { boards, tasks, events };
}
