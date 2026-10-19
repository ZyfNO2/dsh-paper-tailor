/**
 * W1 报告展示层 · fixtures barrel。
 *
 * 所有 fixture 都通过 RpSimulatedFixture 显式携带 simulated: true 与说明；
 * W2 组件与 W3 模式复用时用 `.data` 取数（只读），不要改写 fixture 内容。
 */
export { RP_FIXTURE_DISCLOSURE, rpSimulatedFixture, rpUnwrapFixture, type RpSimulatedFixture } from './simulation.ts';
export { SIMULATED_METRIC_PROJECTION_FIXTURE } from './metric-projection.ts';
export { SIMULATED_PACK_FIXTURE, SIMULATED_PACK_SELECTION } from './pack.ts';
export { SIMULATED_RECORD_FIXTURE, SIMULATED_READ_FIXTURE, SIMULATED_PROJECTION_FIXTURE } from './projection.ts';
