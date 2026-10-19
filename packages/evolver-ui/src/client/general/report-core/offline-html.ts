import { validateGeneralFactPackRead, type GeneralFactPackRead } from '../../../../../evolver/src/contracts/general-report.ts';
import { renderGeneralFactPackHTML } from '../../../../../evolver/src/contracts/general-report-html.ts';
import { RP_ALL_CSS } from '../report-presentation/styles/index.ts';
import { OFFLINE_REPORT_RUNTIME, OFFLINE_REPORT_CSP_HASH, OFFLINE_REPORT_LICENSES } from './offline-runtime.generated.ts';
const escape = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
/** Only a build-pinned runtime executes. All report/LLM/user strings remain escaped JSON/text. */
export function renderInteractiveReportHTML(input: GeneralFactPackRead): string {
  const read = validateGeneralFactPackRead(input);
  const facts = JSON.stringify(read).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const native = renderGeneralFactPackHTML(read), start = native.indexOf('<body>') + 6, end = native.lastIndexOf('</body>');
  if (start < 6 || end < start || /<\/script/i.test(OFFLINE_REPORT_RUNTIME) || /<\/style/i.test(RP_ALL_CSS)) throw new Error('Offline report trusted template is invalid');
  const policy = `default-src 'none'; script-src '${OFFLINE_REPORT_CSP_HASH}'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escape(policy)}"><title>${escape(read.pack.title)}</title><style>body{margin:0;padding:24px;background:#f7f9fc;color:#172033;font-family:system-ui,sans-serif}main{max-width:1200px;margin:auto}.offline-boundary{padding:12px;border:1px solid #ad6500;background:#fff4dc}button,input,textarea{font:inherit}${RP_ALL_CSS}</style></head><body><main><p class="offline-boundary">离线冻结副本：不连接工作区，无法重新核对权限、来源或新版本。导出后的授权变化不会更新此文件；历史状态仅代表导出时核对，不是新的科研验证。教学练习及模拟参数只在本文件内运行。</p><div id="report-root"></div><details><summary>离线运行组件许可证</summary><pre>${escape(OFFLINE_REPORT_LICENSES)}</pre></details><noscript><p>JavaScript 未启用；以下静态事实仍可查看。</p>${native.slice(start, end)}</noscript><script type="application/json" id="report-facts">${facts}</script><script>${OFFLINE_REPORT_RUNTIME}</script></main></body></html>`;
  if (new TextEncoder().encode(html).length > 12 * 1024 * 1024) throw new Error('Interactive report HTML exceeds 12 MiB');
  return html;
}
