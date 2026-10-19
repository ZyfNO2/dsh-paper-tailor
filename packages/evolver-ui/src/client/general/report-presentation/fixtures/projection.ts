/**
 * W1 报告展示层 · Fact Pack 记录 / 只读视图 / 投影 fixtures（只读 DTO 对齐）。
 *
 * 覆盖（全部为模拟数据）：
 * - GeneralFactPackRecord：版本 3、artifact 哈希、与 pack 一致的身份字段；
 * - GeneralFactPackRead：freshness needs_review（待重审示例）；
 * - GeneralReportProjection：allowed + revoked（已撤销）两种访问状态、current/needs_review 两种新鲜度。
 */
import type { GeneralFactPackRecord, GeneralFactPackRead, GeneralReportProjection } from '../../../../../../evolver/src/contracts/general-report.ts';
import { SIMULATED_PACK_FIXTURE, SIMULATED_PACK_SELECTION } from './pack.ts';
import { rpSimulatedFixture, type RpSimulatedFixture } from './simulation.ts';

const H_ARTIFACT = 'c0d9e8f7c0d9e8f7c0d9e8f7c0d9e8f7c0d9e8f7c0d9e8f7c0d9e8f7c0d9e8f7';
const H_CTX_OLD = 'b9c8d7e6b9c8d7e6b9c8d7e6b9c8d7e6b9c8d7e6b9c8d7e6b9c8d7e6b9c8d7e6';
const T_OLD = '2026-09-01T08:00:00.000Z';

/** 与 SIMULATED_PACK 身份字段完全一致的记录（模拟）。 */
const SIMULATED_RECORD_DATA: GeneralFactPackRecord = {
  packId: SIMULATED_PACK_FIXTURE.data.packId,
  version: SIMULATED_PACK_FIXTURE.data.version,
  title: SIMULATED_PACK_FIXTURE.data.title,
  artifact: { id: 'artifact-sim-w1', sha256: H_ARTIFACT },
  contextHash: SIMULATED_PACK_FIXTURE.data.contextHash,
  inputsHash: SIMULATED_PACK_FIXTURE.data.inputsHash,
  bootstrapRevision: SIMULATED_PACK_FIXTURE.data.bootstrapRevision,
  createdAt: SIMULATED_PACK_FIXTURE.data.createdAt,
  sourceIds: SIMULATED_PACK_SELECTION.sourceIds,
  calculationIds: SIMULATED_PACK_SELECTION.calculationIds,
  knowledgeRefs: SIMULATED_PACK_SELECTION.knowledgeRefs,
  reviewIds: SIMULATED_PACK_SELECTION.reviewIds,
  inferenceRunIds: SIMULATED_PACK_SELECTION.inferenceRunIds,
};

/** 记录 fixture（带显式模拟标记）。 */
export const SIMULATED_RECORD_FIXTURE: RpSimulatedFixture<GeneralFactPackRecord> = rpSimulatedFixture(
  SIMULATED_RECORD_DATA,
  'Fact Pack 记录 fixture（模拟）：身份字段与模拟包一致。',
);

/** 只读视图数据（模拟）：record + pack + freshness（needs_review 待重审）。 */
const SIMULATED_READ_DATA: GeneralFactPackRead = {
  record: SIMULATED_RECORD_DATA,
  pack: SIMULATED_PACK_FIXTURE.data,
  freshness: { status: 'needs_review', reasons: ['包内候选计算依赖的输入已更新，需重新审核（模拟场景）'] },
};

/** 只读视图 fixture（带显式模拟标记）。 */
export const SIMULATED_READ_FIXTURE: RpSimulatedFixture<GeneralFactPackRead> = rpSimulatedFixture(
  SIMULATED_READ_DATA,
  'Fact Pack 只读视图 fixture（模拟）：record 与 pack 身份一致，整体待重审。',
);

/** 投影数据（模拟）：当前包 allowed/needs_review，旧包 revoked/current。 */
const SIMULATED_PROJECTION_DATA: GeneralReportProjection = {
  packs: [
    {
      ...SIMULATED_RECORD_DATA,
      access: 'allowed',
      freshness: 'needs_review',
    },
    {
      packId: 'pack-sim-old',
      version: 2,
      title: '旧版模拟包（访问已撤销，虚构）',
      artifact: { id: 'artifact-sim-old', sha256: H_ARTIFACT },
      contextHash: H_CTX_OLD,
      inputsHash: H_CTX_OLD,
      bootstrapRevision: 6,
      createdAt: T_OLD,
      sourceIds: ['src-lit-002'],
      calculationIds: [],
      knowledgeRefs: [],
      reviewIds: [],
      inferenceRunIds: [],
      access: 'revoked',
      freshness: 'current',
    },
  ],
  boundary: '投影边界（模拟）：仅展示 fixture；撤销访问的包不提供内容读取。',
};

/** 投影 fixture（带显式模拟标记）。 */
export const SIMULATED_PROJECTION_FIXTURE: RpSimulatedFixture<GeneralReportProjection> = rpSimulatedFixture(
  SIMULATED_PROJECTION_DATA,
  '报告投影 fixture（模拟）：覆盖 allowed/revoked 访问状态与 current/needs_review 新鲜度。',
);
