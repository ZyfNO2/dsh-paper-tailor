import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ReportModes } from '../report-presentation/modes/ReportModes.tsx';
import { validateGeneralFactPackRead } from '../../../../../evolver/src/contracts/general-report.ts';

// Trusted application code only; downloaded research text is data, never code.
const container = document.getElementById('report-root');
const data = document.getElementById('report-facts');
if (!container || !data) throw new Error('Offline report structure missing');
try {
  const read = validateGeneralFactPackRead(JSON.parse(data.textContent ?? ''));
  createRoot(container).render(createElement(ReportModes, { read, dataOrigin: 'workspace' }));
} catch (error) {
  container.textContent = `报告数据校验失败：${error instanceof Error ? error.message : String(error)}`;
  container.setAttribute('role', 'alert');
}
