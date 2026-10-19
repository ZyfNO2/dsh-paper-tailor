import { validateGeneralFactPackRead, type GeneralFactPackRead } from './general-report.ts';

const escape = (value: unknown): string => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const list = (values: readonly string[]) => `<ul>${values.map(v => `<li>${escape(v)}</li>`).join('')}</ul>`;
const json = (value: unknown) => `<pre>${escape(JSON.stringify(value, null, 2))}</pre>`;
const details = (title: string, value: unknown) => `<details><summary>${escape(title)}</summary>${json(value)}</details>`;
/** Standalone native HTML disclosures. No scripts, remote assets, arbitrary markup or Host bridge. */
export function renderGeneralFactPackHTML(input: GeneralFactPackRead): string {
  const read = validateGeneralFactPackRead(input), { pack, record, freshness } = read;
  const rows = pack.metrics.rows.map(row => `<tr><td>${escape(row.label)}</td><td>${escape(row.origin)} / ${escape(row.inputNature)}</td><td>${escape(row.check)}</td><td>${row.cells.map(c => `${escape(c.metricId)}: ${c.value === null ? '未知（null）' : escape(c.value)} ${escape(c.unit ?? '单位未知')} · ${escape(c.status)} · Δ ${c.delta === null ? '不可比较' : escape(c.delta)}`).join('<br>')}</td><td>${escape([...row.blockers, ...row.comparisonReasons].join('；'))}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'; script-src 'none'; object-src 'none'"><title>${escape(pack.title)}</title><style>body{font:16px/1.65 system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 20px;color:#202a36;background:#f7f9fb}article{background:white;border:1px solid #d8e0e8;padding:24px;border-radius:12px}aside{border:2px solid #a56c14;padding:16px;background:#fff8e8}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid #d8e0e8;padding:10px;text-align:left;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}details{padding:12px 0;border-bottom:1px solid #d8e0e8}summary{cursor:pointer;font-weight:600}.scroll{overflow-x:auto}footer{font-size:13px}</style></head><body><article>
<h1>${escape(pack.title)} · v${pack.version}</h1>
<aside><strong>离线冻结快照 · 无法实时检查来源权限或变更</strong><p>导出时核对状态：${escape(freshness.status)}。current 仅表示来源/定位核对，不代表独立科学验证。文件打开后不会读取宿主、执行模型或更新研究事实。</p>${list(freshness.reasons)}</aside>
<h2>未知项与限制</h2>${list(pack.unknowns)}${list(pack.constraints)}
<h2>研究问题（hypothesis）</h2>${list(pack.questions.map(q => q.question))}
<h2>已有指标</h2><div class="scroll"><table><thead><tr><th>记录</th><th>来源性质</th><th>检查级别</th><th>值 / 单位 / 差值</th><th>限制与比较理由</th></tr></thead><tbody>${rows || '<tr><td colspan="5">没有已选入的指标结果；不编造观察。</td></tr>'}</tbody></table></div>
${details('方法与数据字典', { plans: pack.plans, datasets: pack.datasets })}
${details('实际数学计算与原 Artifact', pack.calculations)}
${details('来源与精确证据定位', { sources: pack.sources, knowledge: pack.knowledge })}
${details('人工审查与适用边界', pack.reviews)}
${details('完整冻结事实与登记记录', { record, pack })}
<footer><p>研究：${escape(pack.researchId)} · 冻结：${escape(pack.createdAt)} · Artifact SHA-256：${escape(record.artifact.sha256)}</p><p>${escape(pack.boundary)}</p></footer>
</article></body></html>`;
}
