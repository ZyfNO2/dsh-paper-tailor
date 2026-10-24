const $ = (s) => document.querySelector(s);
const state = { workspaceDir: localStorage.getItem('research.workspace') || '', projects: [], snapshot: null, view: 'sources', busy: false, readId: 0, failed: null, source: null, editing: null, readError: null };
const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const raw = (value) => ({ markup: value });
function html(strings, ...values) {
  const render = (v) => Array.isArray(v) ? v.map(render).join('') : v && typeof v === 'object' && 'markup' in v ? v.markup : escape(v);
  return raw(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]) : ''), ''));
}
const current = () => state.snapshot?.project;
const revision = () => current()?.revision ?? 0;
function say(message, error = false) { $('#status').textContent = message; $('#status').className = error ? 'status error' : 'status'; }
async function call(route, body = {}) {
  const response = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.message || `HTTP ${response.status}`);
  return payload.result;
}
function field(label, name, value = '', required = true) { return html`<label>${label}<input name="${name}" value="${value}" ${raw(required ? 'required' : '')}></label>`; }
function area(label, name, value = '', required = true) { return html`<label>${label}<textarea name="${name}" ${raw(required ? 'required' : '')}>${value}</textarea></label>`; }
function select(label, name, items, multiple = false) {
  return html`<label>${label}<select name="${name}" ${raw(multiple ? 'multiple' : '')} required>${items.map(([value, title]) => html`<option value="${value}">${title}</option>`)}</select></label>`;
}
function form(route, fields, title) { return html`<form data-route="${route}"><div class="row">${fields}<button class="action" ${raw(state.busy ? 'disabled' : '')}>${title}</button></div></form>`; }
function cards(items, render) { return items.length ? html`<div class="cards">${items.map(render)}</div>` : html`<p class="empty">暂无记录；可先导入材料，或让外部 Agent 通过 CLI / MCP 保存产物。</p>`; }
function approveButton(subjectId, subjectRevision, hash, capability, title) { return html`<button class="action" data-subject="${subjectId}" data-revision="${subjectRevision}" data-hash="${hash}" data-capability="${capability}">${title}</button>`; }
const sourceOptions = () => current().sources.map((s) => [s.sourceId, `${s.filename || s.sourceId} · ${s.mediaType}`]);

async function loadProjects() {
  const result = await call('/api/projects');
  state.projects = result.projects;
  if (state.workspaceDir && !state.projects.some((p) => p.workspaceDir === state.workspaceDir)) state.projects.push({ workspaceDir: state.workspaceDir, goal: current()?.goal || state.workspaceDir });
  $('#project').innerHTML = html`${state.projects.map((p) => html`<option value="${p.workspaceDir}">${p.error ? '读取异常 · ' + p.workspaceDir : p.goal || p.workspaceDir}</option>`)}<option value="">新建项目…</option>`.markup;
  $('#project').value = state.workspaceDir;
}
async function loadContext() {
  const id = ++state.readId;
  const workspaceDir = state.workspaceDir;
  state.snapshot = null; state.source = null; state.readError = null;
  if (!workspaceDir) { render(); say('选择项目，或在文献 Wiki 页面新建项目。'); return; }
  say('正在读取项目…');
  try {
    const snapshot = await call('/api/context', { workspaceDir });
    if (id !== state.readId) return;
    state.snapshot = snapshot;
    localStorage.setItem('research.workspace', workspaceDir);
    render();
    say(snapshot.needsMigration ? '旧版项目可只读查看；请先备份升级后再写入。' : `已读取 revision ${revision()} · ${workspaceDir}`);
  } catch (error) {
    if (id !== state.readId) return;
    state.readError = error.message;
    render();
    say(error.message, true);
  }
}
function sourcesView() {
  const p = current();
  if (!p) return html`<h2>新建研究项目</h2>${state.snapshot?.legacy?.researchCount ? html`<p class="status">发现 ${state.snapshot.legacy.researchCount} 项旧 DSH 研究。当前只提供清点，尚未导入为独立项目；创建项目不会自动迁移这些资产。</p>` : ''}${form('/api/init', [field('研究目标', 'goal'), field('已存在的工作目录（启动 roots 范围内）', 'workspaceDir', state.workspaceDir)], '建立项目')}`;
  const latest = p.knowledge.filter((c) => !p.knowledge.some((other) => other.cardId === c.cardId && other.revision > c.revision));
  return html`<h2>文献 Wiki</h2><p>${p.goal}</p>
    <p class="meta">${p.sources.length} 份资料 · ${latest.length} 条知识 · ${p.ideas.length} 个候选 · ${p.runs.length} 次运行</p>
    ${form('/api/import', field('本机文件路径（PDF / 文本 / CSV / 代码材料）', 'filePath'), '导入材料')}
    ${cards(p.sources, (s) => html`<article><h3>${s.filename || s.sourceId}</h3><p>${s.mediaType}</p><p class="meta">${s.sourceId} · ${s.bytes} bytes · sha256 ${s.sha256.slice(0, 16)}</p><button data-source="${s.sourceId}">查看原文 / 解析状态</button></article>`)}
    ${state.source ? html`<article><h3>来源 ${state.source.source.sourceId}</h3><p>${state.source.message}</p><pre>${state.source.text ?? '当前仅保存原始附件，尚未解析全文。'}</pre></article>` : ''}
    <h2>知识卡片</h2><p class="meta">保留旧 revision；引用按 UTF-8 bytes 校验。PDF 未接解析器时不能伪造原文定位。</p>
    ${state.editing ? html`<p class="status">正在修订「${state.editing.title}」，保留历史版本。<button id="cancel-edit">取消修订</button></p>` : ''}
    ${p.sources.length ? form('/api/knowledge', [select('类型', 'kind', [['brief', '研究简报'], ['method', '方法 / 机制'], ['evaluation', '评价 / 条件']]), field('标题', 'title', state.editing?.title || ''), area('正文', 'body', state.editing?.body || ''), select('引用来源', 'sourceId', sourceOptions()), area('精确原文引用（从查看原文复制）', 'quote', state.editing?.citations?.[0]?.quote || ''), state.editing ? html`<input type="hidden" name="cardId" value="${state.editing.cardId}"><input type="hidden" name="cardRevision" value="${state.editing.revision}">` : '', area('未知 / 缺口（每行一项）', 'unknowns', state.editing?.unknowns.join('\n') || '', false)], '保存知识版本') : ''}
    ${cards(latest, (c) => html`<article><h3>${c.title}</h3><p class="meta">${c.kind} · revision ${c.revision}</p><p>${c.body}</p>${(c.citations ?? []).map((ref) => html`<blockquote>${ref.quote}<p class="meta">${ref.sourceId} · bytes ${ref.startByte}–${ref.endByte}</p></blockquote>`)}<p class="meta">待查：${c.unknowns.join('；') || '未填写'}</p><button data-edit-card="${c.cardId}">修订知识</button><details><summary>历史版本</summary>${p.knowledge.filter((v) => v.cardId === c.cardId).map((v) => html`<p>v${v.revision} · ${v.updatedAt}</p><pre>${v.body}</pre>`)}</details></article>`)}
    <h2>文献检索缺口</h2><p class="meta">尚无检索 provider；这里只登记待查问题，不会执行联网检索。</p>${form('/api/search', field('待查检索词', 'query'), '登记待查')}
    ${cards(p.searches, (s) => html`<article><h3>${s.query}</h3><span class="flag bad">${s.status}</span><p>${s.reason}</p></article>`)}`;
}
function ideasView() {
  const p = current();
  return html`<h2>候选方案</h2><p class="meta">保存候选与用户选定分别记录。缺少文献查新时保留待验证状态。</p>
    ${form('/api/idea', [field('标题', 'title'), area('问题 / 假设', 'hypothesis'), area('具体改动', 'change'), area('预期机制', 'mechanism'), area('证伪实验 / 失败条件', 'falsifier'), select('引用资料（可多选）', 'sourceIds', sourceOptions(), true)], '保存候选')}
    ${cards(p.ideas, (i) => html`<article><h3>${i.title}</h3><span class="flag">${i.status}</span><p>${i.hypothesis}</p><p>改动：${i.change}</p><p>机制：${i.mechanism}</p><p>证伪：${i.falsifier}</p><p class="meta">${i.sourceIds.join(', ')}</p>${approveButton(i.ideaId, i.revision, state.snapshot.subjectHashes.ideas[i.ideaId], 'select_idea', '选定此方向')}</article>`)}`;
}
function treeView() {
  const p = current(), tree = state.snapshot.tree;
  return html`<h2>研究树与实验计划</h2><p class="meta">执行状态与科研判断分开。采纳后的下一步仍为未执行任务。</p>
    ${cards(tree.nodes, (n) => html`<article><h3>${n.title}</h3><p class="meta">${n.kind} · ${n.id}</p>${tree.edges.filter((e) => e.from === n.id).map((e) => html`<p>${e.relation} → ${tree.nodes.find((v) => v.id === e.to)?.title || e.to}</p>`)}</article>`)}
    <h2>新建计划</h2>${form('/api/plan', [select('候选方向', 'ideaId', p.ideas.map((i) => [i.ideaId, `${i.status} · ${i.title}`])), field('基线', 'baseline'), field('唯一改动变量', 'variable'), area('固定条件（每行一项）', 'fixedConditions'), field('数据划分 / split', 'split'), field('seed 策略', 'seedPolicy'), field('指标', 'metric'), field('单位', 'metricUnit'), field('预算', 'budget'), field('停止条件', 'stopCondition')], '保存草稿计划')}
    ${cards(p.plans, (plan) => html`<article><h3>${plan.baseline} → ${plan.variable}</h3><span class="flag">${plan.status}</span><p>${plan.metric} / ${plan.metricUnit} · ${plan.split}</p><p>固定条件：${plan.fixedConditions.join('；')}</p><p>预算：${plan.budget} · 停止：${plan.stopCondition}</p>${approveButton(plan.planId, plan.revision, plan.contentHash, 'export_assignment', '批准并准备交接包')}</article>`)}
    <h2>Agent 交接任务</h2><p class="meta">外部 Agent 自行运行。当前不具备原生 Team 生命周期监控；单 Agent 标为 self_review。</p>
    ${cards(p.assignments, (a) => html`<article><h3>${a.assignmentId}</h3><span class="flag">${a.reviewMode}</span><span class="flag">${a.status}</span><p>输入已固定到 plan v${a.planRevision}</p><button data-download="${a.assignmentId}">下载完整交接 JSON</button></article>`)}`;
}
function runsView() {
  const p = current();
  return html`<h2>实验记录</h2>${form('/api/record', field('workspace 内的 manifest 相对路径', 'manifestPath'), '导入结果')}
    ${cards(p.runs, (r) => html`<article><h3>${r.runId}</h3><span class="flag">${r.recordKind}</span><span class="flag">${r.execution}</span><span class="flag">${r.freshness}</span><p>${r.comparability} · ${r.comparabilityReason}</p>${r.metrics.map((m) => html`<p>${m.name} = ${m.value === null ? '缺失（null）' : m.value} ${m.unit}<span class="meta"> · row ${m.row}, column ${m.column}</span></p>`)}</article>`)}
    <h2>证据自审</h2><p class="meta">明确结论需要本次选中的至少两个同计划、同口径真实结果；不自动采纳结论。</p>
    ${form('/api/review', [select('运行（可多选）', 'runIds', p.runs.map((r) => [r.runId, `${r.runId} · ${r.recordKind}`]), true), select('判断', 'judgment', [['inconclusive', '证据不足'], ['supported', '支持'], ['contradicted', '反驳']]), area('依据与边界', 'reason'), area('后续建议', 'nextStep')], '保存自审建议')}
    ${cards(p.reviews, (r) => html`<article><h3>${r.judgment}</h3><span class="flag">${r.reviewMode}</span><p>${r.reason}</p><p>下一步：${r.nextStep}</p><p class="meta">${r.actorSource} · ${r.actorKind}</p>${approveButton(r.reviewId, 1, state.snapshot.subjectHashes.reviews[r.reviewId], 'accept_decision', '采纳后续建议到研究树')}</article>`)}`;
}
function render() {
  document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === state.view ? 'page' : 'false'));
  if (state.readError) {
    $('#view').innerHTML = html`<h2>项目读取失败</h2><p class="empty">${state.readError}。原文件已保留。可重新读取，或从上方选择其他项目；不会把损坏项目当成空项目覆盖。</p>`.markup;
    return;
  }
  const p = current();
  const views = { sources: sourcesView, ideas: ideasView, tree: treeView, runs: runsView };
  $('#view').innerHTML = (p ? views[state.view]() : state.view === 'sources' ? sourcesView() : html`<p class="empty">先选择或建立研究项目。请打开「文献 Wiki」；读取异常的项目会保留原始文件。</p>`).markup;
  if (state.snapshot?.needsMigration) $('#view').insertAdjacentHTML('afterbegin', html`<p class="status">项目来自未带 stateHash 的旧版。可只读查看；升级保留原文件备份、对象 ID 和 revision。<button id="migrate">备份并升级格式</button></p>`.markup);
  if (state.snapshot?.needsMigration) $('#view').querySelectorAll('form button, [data-subject]').forEach((b) => b.disabled = true);
  if (state.editing && state.view === 'sources') {
    const formNode = $('#view').querySelector('form[data-route="/api/knowledge"]');
    formNode.elements.kind.value = state.editing.kind;
    formNode.elements.sourceId.value = state.editing.sourceIds[0];
  }
}
async function mutate(key, action) {
  if (state.busy) return;
  state.busy = true;
  $('#view').querySelectorAll('button').forEach((b) => b.disabled = true);
  if (state.failed?.key !== key) state.failed = { key, operationId: `op-${crypto.randomUUID()}` };
  say('正在保存，等待后端回执…');
  try { await action(state.failed.operationId); state.failed = null; await loadProjects(); await loadContext(); }
  catch (error) { say(`${error.message}；未清空当前草稿。`, true); }
  finally { state.busy = false; $('#view').querySelectorAll('button').forEach((b) => b.disabled = state.snapshot?.needsMigration && b.id !== 'migrate'); }
}
$('#view').addEventListener('submit', (event) => {
  if (!(event.target instanceof HTMLFormElement)) return;
  event.preventDefault();
  const formNode = event.target, formData = new FormData(formNode);
  const body = { ...Object.fromEntries(formData), workspaceDir: state.workspaceDir || formData.get('workspaceDir'), baseRevision: revision() };
  for (const name of ['sourceIds', 'runIds']) if (formData.has(name)) body[name] = formData.getAll(name);
  if (formData.has('fixedConditions')) body.fixedConditions = body.fixedConditions.split('\n').map((x) => x.trim()).filter(Boolean);
  if (formData.has('unknowns')) body.unknowns = body.unknowns.split('\n').map((x) => x.trim()).filter(Boolean);
  void mutate(JSON.stringify([formNode.dataset.route, body]), async (operationId) => {
    if (formNode.dataset.route === '/api/knowledge') {
      const material = await call('/api/source', { workspaceDir: body.workspaceDir, sourceId: body.sourceId });
      const start = material.text?.indexOf(body.quote) ?? -1;
      if (start < 0) throw new Error('引用不在已解析原文中，无法保存');
      const startByte = new TextEncoder().encode(material.text.slice(0, start)).length;
      body.citations = [{ sourceId: body.sourceId, sha256: material.source.sha256, startByte, endByte: startByte + new TextEncoder().encode(body.quote).length, quote: body.quote }, ...(state.editing?.citations?.slice(1) ?? [])];
      body.sourceIds = [...new Set([...(state.editing?.sourceIds ?? []), ...body.citations.map((c) => c.sourceId)])];
      if (!body.cardId) { delete body.cardId; delete body.cardRevision; } else body.cardRevision = Number(body.cardRevision);
      delete body.sourceId; delete body.quote;
    }
    await call(formNode.dataset.route, { ...body, operationId });
    state.editing = null;
    if (formNode.dataset.route === '/api/init') state.workspaceDir = body.workspaceDir;
  });
});
$('#view').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button || state.busy) return;
  if (button.dataset.editCard) { state.editing = current().knowledge.filter((c) => c.cardId === button.dataset.editCard).sort((a, b) => b.revision - a.revision)[0]; render(); return; }
  if (button.id === 'cancel-edit') { state.editing = null; render(); return; }
  if (button.dataset.subject) {
    const body = { workspaceDir: state.workspaceDir, baseRevision: revision(), subjectId: button.dataset.subject, subjectRevision: Number(button.dataset.revision), subjectHash: button.dataset.hash, capability: button.dataset.capability };
    void mutate(JSON.stringify(body), async (operationId) => {
      const approved = await call('/api/approve', { ...body, operationId });
      if (body.capability === 'export_assignment') await call('/api/assignment', { workspaceDir: body.workspaceDir, baseRevision: approved.revision, planId: body.subjectId, operationId: `${operationId}:assignment` });
    });
    return;
  }
  if (button.id === 'migrate') { void mutate('migrate', () => call('/api/migrate', { workspaceDir: state.workspaceDir })); return; }
  try {
    if (button.dataset.source) { state.source = await call('/api/source', { workspaceDir: state.workspaceDir, sourceId: button.dataset.source }); render(); }
    if (button.dataset.download) {
      const bundle = await call('/api/assignment-bundle', { workspaceDir: state.workspaceDir, assignmentId: button.dataset.download });
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `${button.dataset.download}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (error) { say(error.message, true); }
});
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => { if (!state.busy) { state.view = b.dataset.view; render(); } }));
$('#project').addEventListener('change', () => { if (!state.busy) { state.workspaceDir = $('#project').value; state.failed = null; state.editing = null; void loadContext(); } });
$('#refresh').addEventListener('click', () => { if (!state.busy) void loadProjects().then(loadContext).catch((e) => say(e.message, true)); });
void loadProjects().then(() => { if (!state.workspaceDir) { state.workspaceDir = state.projects.find((p) => !p.error)?.workspaceDir || state.projects[0]?.workspaceDir || ''; $('#project').value = state.workspaceDir; } return loadContext(); }).catch((e) => say(e.message, true));
