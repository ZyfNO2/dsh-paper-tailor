import { createHash } from 'node:crypto';
import { GeneralResearchService } from './general-research-service.ts';
import { GeneralDataService } from './general-data-service.ts';
import type { ResearchBootstrapStore } from './research-bootstrap-store.ts';

export const EXAMPLE_SEED = {
  version: 'example-seed-1', filename: '01_独立双组_模拟_24行.csv',
  question: '在同一测量流程下，处理组与对照组的读数均值是否存在差异？（示例问题；种子数据为明确模拟）',
  csv: [
    '试件,组别,读数',
    'S01,对照组,100.3', 'S02,对照组,99.8', 'S03,对照组,100.1', 'S04,对照组,100.6', 'S05,对照组,99.9', 'S06,对照组,100.2',
    'S07,对照组,100.0', 'S08,对照组,99.7', 'S09,对照组,100.4', 'S10,对照组,100.1', 'S11,对照组,99.8', 'S12,对照组,100.0',
    'T01,处理组,101.2', 'T02,处理组,101.8', 'T03,处理组,102.1', 'T04,处理组,100.9', 'T05,处理组,101.5', 'T06,处理组,101.1',
    'T07,处理组,101.9', 'T08,处理组,101.3', 'T09,处理组,102.0', 'T10,处理组,101.6', 'T11,处理组,101.2', 'T12,处理组,',
  ].join('\n'),
};

/** Same immutable seed and services in both hosts; replay does not depend on wall-clock minute. */
export function createGeneralExample(store: ResearchBootstrapStore, input: { operationId: string; baseRevision: number }) {
  const child = (suffix: string) => { const id = `${input.operationId}:${suffix}`; return id.length <= 180 ? id : createHash('sha256').update(id).digest('hex'); };
  const created = new GeneralResearchService(store).create({ operationId: child('create'), baseRevision: input.baseRevision,
    title: '示例研究（明确模拟）', question: EXAMPLE_SEED.question, domains: ['示例'], methods: ['observation'], entryMode: 'existing_data' });
  const imported = new GeneralDataService(store).importMaterial({ operationId: child('material'), baseRevision: created.revision,
    researchId: created.result.researchId, filename: EXAMPLE_SEED.filename, mediaType: 'text/csv', contentBase64: Buffer.from(EXAMPLE_SEED.csv).toString('base64'), nature: 'simulation',
    description: '内置示例种子（example-seed-1）；全部数值为明确模拟，不构成真实实验证据。', purpose: '体验研究流程与授权边界' });
  return { ...imported, result: { researchId: created.result.researchId, sourceId: imported.result.sourceId, seedVersion: EXAMPLE_SEED.version } };
}
