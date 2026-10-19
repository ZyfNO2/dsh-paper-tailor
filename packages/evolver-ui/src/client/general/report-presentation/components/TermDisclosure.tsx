/**
 * W2 报告展示层 · 术语展开（只读 + 本地展开状态）。
 *
 * 键盘可操作：使用原生 button（Enter/Space 触发）+ aria-expanded + aria-controls；
 * 展开状态同时有文字箭头（▸/▾），不只靠颜色；不修改输入 terms 数组。
 */
import { useId, useState } from 'react';

export interface TermDisclosureProps {
  terms: { term: string; plain: string }[];
}

export function TermDisclosure({ terms }: TermDisclosureProps): JSX.Element {
  const baseId = useId();
  const [openIndexes, setOpenIndexes] = useState<number[]>([]);
  const toggle = (index: number): void => {
    setOpenIndexes((prev) => (prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]));
  };
  return (
    <section className="rp-terms" aria-label="术语解释">
      <h3 className="rp-section-title">术语</h3>
      {terms.length === 0 ? (
        <p className="rp-empty">暂无术语解释。</p>
      ) : (
        <dl className="rp-term-list">
          {terms.map((item, index) => {
            const panelId = `${baseId}-panel-${index}`;
            const open = openIndexes.includes(index);
            return (
              <div key={`${item.term}-${index}`} className="rp-term">
                <dt>
                  <button
                    type="button"
                    className="rp-term-button"
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() => {
                      toggle(index);
                    }}
                  >
                    <span className="rp-term-arrow" aria-hidden="true">
                      {open ? '▾' : '▸'}
                    </span>
                    <span className="rp-term-name">{item.term}</span>
                  </button>
                </dt>
                <dd id={panelId} className="rp-term-panel" hidden={!open}>
                  {item.plain}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}
