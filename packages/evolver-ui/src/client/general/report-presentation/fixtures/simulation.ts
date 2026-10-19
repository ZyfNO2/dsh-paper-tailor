/**
 * W1 报告展示层 · fixture 模拟标记封装。
 *
 * 硬性约定：所有展示 fixture 必须显式携带 simulated: true 与说明文字，
 * 保证"模拟数据"标识跟随数据本身传播，不会在传递中丢失。
 * fixture 永远不是真实研究数据。
 */

/** 所有 fixture 共用的总声明（显示在示例页与交接文档中）。 */
export const RP_FIXTURE_DISCLOSURE =
  '本目录全部 fixture 为模拟展示数据（仅展示）：数值虚构，仅用于界面、样式与文案演示，不是任何真实研究的结果。';

/** 带显式模拟标记的 fixture 封装。 */
export interface RpSimulatedFixture<T> {
  readonly simulated: true;
  readonly note: string;
  readonly data: T;
}

/** 创建带模拟标记的 fixture；note 必须包含"模拟"字样。 */
export function rpSimulatedFixture<T>(data: T, note: string): RpSimulatedFixture<T> {
  if (!note.includes('模拟')) throw new Error('Fixture note must explicitly mention 模拟 (simulated).');
  return { simulated: true, note, data };
}

/** 解包 fixture 并断言其模拟标记（供展示代码取数；真实数据不走此入口）。 */
export function rpUnwrapFixture<T>(fixture: RpSimulatedFixture<T>): T {
  if (fixture.simulated !== true) throw new Error('Not a simulated fixture.');
  return fixture.data;
}
