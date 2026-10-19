import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerResponse } from 'node:http';

/** Invalidation only. Canonical stores and their validators still own every write. */
export function streamResearchChanges(workspacePath: string, res: ServerResponse, subscribeNative?: (invalidate: () => void) => () => void): () => void {
  // Watch the closest existing parent so creating the first research directory is seen.
  const researchRoot = path.join(workspacePath, '.dsh', 'research');
  const watchRoot = [researchRoot, path.join(workspacePath, '.dsh'), workspacePath].find((p) => fs.existsSync(p))!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const send = (event: string, value: unknown) => {
    if (!closed && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const invalidate = () => {
    clearTimeout(timer);
    timer = setTimeout(() => send('research-changed', { at: new Date().toISOString() }), 80);
  };
  // Construct before committing headers: unsupported watchers fail as an HTTP error.
  const watcher = fs.watch(watchRoot, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const changed = path.resolve(watchRoot, String(filename));
    const relative = path.relative(researchRoot, changed);
    if (relative.startsWith('..') || path.isAbsolute(relative) || /(?:\.lock|\.tmp|\.temp)$/.test(relative)) return;
    invalidate();
  });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  send('research-changed', { reason: 'connected' });
  const disposeNative = subscribeNative?.(invalidate);
  const heartbeat = setInterval(() => { if (!closed) res.write(': keepalive\n\n'); }, 25000);
  const dispose = () => { if (closed) return; closed = true; clearTimeout(timer); clearInterval(heartbeat); watcher.close(); disposeNative?.(); };
  watcher.on('error', (error) => { send('sync-error', { message: error.message }); res.end(); dispose(); });
  res.on('close', dispose);
  return dispose;
}

export interface ResearchGuidanceMessage {
  id?: string;
  source?: { kind?: string };
  content?: readonly { type: string; text?: string }[];
}

/** Sharing a workspace is context, not authorization: an actionable request is still required. */
export interface ResearchGuidanceContext { hasResearchContext?: boolean }

function humanText(message: ResearchGuidanceMessage | undefined): string {
  return message?.content?.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n') ?? '';
}

function discussionOnly(text: string): boolean {
  return /(?:不要|别|无需|不用|不必|暂不|先不)(?:再|自动)?(?:保存|更新|同步|写入|触发|登记|创建|建立)|(?:只|仅)(?:做)?(?:讨论|分析|解释|设计|总结)|只写.*(?:方案|plan)|\b(?:do not|don't)\s+(?:save|persist|update|create)\b/i.test(text);
}

function explicitResearchRequest(text: string): boolean {
  if (discussionOnly(text)) return false;
  if (/(?:总结|概括|翻译|解释).*(?:论文|文献)|(?:论文|文献).*(?:总结|概括|翻译)/.test(text)
      && !/(?:改进|优化|研究|实验|验证|规划|复现)/.test(text)) return false;
  // Keep existing product requests, but users need not know any product nouns.
  if (/(?:整理|生成|更新|同步|录入|分析|根据|基于|已有|完成|继续|补充|登记|接入|帮我).*(?:wiki|extract|brainstorm|脑暴|候选想法|工作台|研究方向|实验结果|实验数据|路线图|DAG)|(?:wiki|extract|brainstorm|脑暴|实验结果|实验数据).*(?:整理|生成|更新|同步|分析|完成|保存)/i.test(text)) return true;
  const subject = /(?:论文|文献|课题|研究|实验|假设|基线|baseline|消融|复现)/i;
  const action = /(?:改进|优化|探索|开展|建立|创建|安排|计划|规划|验证|复现|比较|对比|分析|整理|总结|继续|推进|做点|做些|完了|完成|结果|数据)/;
  return subject.test(text) && action.test(text);
}

/** Only human messages trigger guidance. Source text can neither authorize nor establish context. */
export function needsResearchWorkspaceSkill(messages: readonly ResearchGuidanceMessage[], context: ResearchGuidanceContext = {}): boolean {
  const message = [...messages].reverse().find((m) => m.source?.kind === 'user');
  const text = humanText(message);
  if (!text.trim() || discussionOnly(text)) return false;
  if (explicitResearchRequest(text)) return true;
  const priorUsers = messages.slice(0, message ? messages.indexOf(message) : 0).filter(m => m.source?.kind === 'user').slice(-6);
  const hasContext = context.hasResearchContext === true || priorUsers.some(m => explicitResearchRequest(humanText(m)));
  if (!hasContext) return false;
  // Generic follow-ups require actual research context; no topic-specific vocabulary or short-text rule.
  return /(?:看看|试试|试|做|走|用|按|选|挑)\s*[^，。！？\s]{0,12}?\s*(?:这|那)(?:条|个|种|方向|方案|思路|路|篇)(?=$|[，。！？\s]|方向|方案|思路|方法|路线|分支|做|来|进行|吧|先|试)/.test(text)
    || /(?:方向|方案|思路).*(?:适合|推荐|先试|可行)|(?:适合|推荐|先试|可行).*(?:方向|方案|思路)/.test(text)
    || /(?:结果|数据|提升).*(?:可靠|可信|代价|分析|看看|比较|对比)|(?:比较|对比|分析|看看).*(?:结果|数据|提升)/.test(text)
    || /(?:接下来|下一步).*(?:做什么|怎么做|怎么走|怎么安排|建议|合适)/.test(text)
    || /(?:补了|追加|补充).*(?:比较|对比|分析|看看)|(?:放|合)一起.*(?:比较|对比|分析)/.test(text)
    || /(?:整理|总结).*(?:我们|之前|做过|进展|下次|继续)|(?:我们|之前|做过|进展).*(?:整理|总结)/.test(text);
}

/**
 * Takeover intent: "接着这个项目做研究 / 先整理目前已有的东西". Same guard as above — only the
 * last human message is inspected, never source files. When both this and
 * needsResearchWorkspaceSkill are true, takeover wins: the host listener checks it first, because
 * "接着做 + 整理已有" must inventory the directory before any workspace sync guidance runs.
 */
export function needsResearchTakeoverSkill(messages: readonly { source?: { kind?: string }; content?: readonly { type: string; text?: string }[] }[]): boolean {
  const message = [...messages].reverse().find((m) => m.source?.kind === 'user');
  const text = message?.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n') ?? '';
  if (discussionOnly(text) || /不要(?:修改|改动)/.test(text)) {
    // 「不要修改原始文件」is the takeover's own signature phrase, not the generic negative gate.
    if (discussionOnly(text) || !/不要(?:修改|改动)(?:原始|源|用户)?(?:文件|目录|项目)/.test(text)) return false;
  }
  const subject = /(?:项目|目录|文件夹|仓库|代码|研究|工程|repo|project|dir(?:ectory)?|codebase)/i;
  const intent = /(?:接管|接手|接着(?:做|这个项目|这个研究)|继续(?:这个|该)(?:项目|研究)|整理(?:目前|现有|已有)|盘(?:点|一下)|摸清(?:现状|底)|梳理(?:现有|已有|目前)|看看(?:已有|现有|目前)(?:有什么|的东西)|take\s*over|onboard)/i;
  if (intent.test(text) && subject.test(text)) return true;
  if (/(?:接进|接入|写进|整理进).{0,80}(?:wiki|研究树|研究图)/i.test(text)) return true;
  if (/(?:实验结果|实验日志|补上的结果).{0,80}(?:说明什么|怎么继续|先不执行)/.test(text)) return true;
  return /不要(?:修改|改动)(?:原始|源|用户)?(?:文件|目录|项目)/.test(text) && /(?:整理|盘点|接(?:管|手)|继续|接着|梳理|看看)/.test(text);
}
