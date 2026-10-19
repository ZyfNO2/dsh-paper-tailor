import type { GeneralMetricReport } from './general-metrics.ts';

/** Display older external locators without joining a numeric token to its unit. */
export function externalResultLocator(report: GeneralMetricReport): string {
  if (!report.note.startsWith('result-key:')) return report.locator;
  const parts = report.locator.split('; ');
  if (parts.length !== report.values.length) return report.locator;
  return parts.map((part, index) => {
    const observation = report.values[index];
    const match = /^(table-1 r\d+ c\d+=)(.+)$/.exec(part);
    if (!match || observation.value === null || !observation.unit || !match[2].endsWith(observation.unit)) return part;
    const token = match[2].slice(0, -observation.unit.length);
    // Only split the legacy suffix if the remaining original token agrees with the stored number.
    if (!token.trim() || !Number.isFinite(Number(token)) || Number(token) !== observation.value) return part;
    return `${match[1]}${token} (unit: ${observation.unit})`;
  }).join('; ');
}
