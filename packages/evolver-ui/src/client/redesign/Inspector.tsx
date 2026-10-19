/**
 * Shared inspector (detail panel) chrome used by the work tree and tailor shop
 * right columns. Paper management keeps its wider F3 layout but reuses the
 * section/tab primitives exported here.
 */
import { useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { Icon } from './icons.tsx';
import { shortRevision } from './view-utils.ts';

export interface InspectorTab {
  id: string;
  label: string;
}

/**
 * An identity value (revision / hash) that must not widen its column.
 *
 * Long values are clipped for the first screen with a real ellipsis and the
 * full value stays reachable through 复制 — the displayed string is shortened,
 * the identity itself is never rewritten (FE-01 §4).
 */
export function RevisionValue(props: { value: string; keep?: number; label?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const { text, truncated } = shortRevision(props.value, props.keep ?? 12);
  const title = props.label === undefined ? props.value : `${props.label} ${props.value}`;
  function copy(): void {
    navigator.clipboard?.writeText(props.value).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1600); },
      () => undefined,
    );
  }
  return (
    <span className="rd-rev" title={title}>
      <code>{text}</code>
      {truncated && (
        <button type="button" className="rd-revCopy" onClick={(e) => { e.stopPropagation(); copy(); }}
          aria-label={`复制完整${props.label ?? '版本'}值`} title={props.value}>
          <Icon name="copy" size={12} />
          {copied ? '已复制' : '复制'}
        </button>
      )}
    </span>
  );
}

export function InspectorShell(props: {
  icon?: ReactNode;
  iconTone?: string;
  title: string;
  sub?: ReactNode;
  badges?: ReactNode;
  tabs?: InspectorTab[];
  activeTab?: string;
  onTab?: (id: string) => void;
  onClose?: () => void;
  children: ReactNode;
  bodyRef?: Ref<HTMLDivElement>;
}): JSX.Element {
  return (
    <div className="rd-panel rd-inspector" style={{ height: '100%' }}>
      <div className="rd-inspHead">
        {props.icon !== undefined && (
          <div className="rd-inspIcon" style={{ background: 'rgba(91,147,255,.12)', color: props.iconTone ?? '#8fb4ff' }}>
            {props.icon}
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <h2 className="rd-inspTitle">{props.title}</h2>
          {props.sub !== undefined && <div className="rd-inspSub">{props.sub}</div>}
          {props.badges !== undefined && <div className="rd-row" style={{ marginTop: 7, flexWrap: 'wrap' }}>{props.badges}</div>}
        </div>
        {props.onClose !== undefined && (
          <button className="rd-btn rd-btn-ghost rd-inspClose" aria-label="关闭详情" onClick={props.onClose}>
            <Icon name="close" size={17} />
          </button>
        )}
      </div>
      {props.tabs !== undefined && props.tabs.length > 0 && (
        <div className="rd-inspTabs" role="tablist">
          {props.tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={props.activeTab === t.id} className="rd-inspTab"
              onClick={() => props.onTab?.(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="rd-inspBody" ref={props.bodyRef}>{props.children}</div>
    </div>
  );
}

export function DetailSection(props: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="rd-section">
      <div className="rd-sectionTitle">{props.title}</div>
      <div>{props.children}</div>
    </section>
  );
}

export function KV(props: { rows: Array<[string, ReactNode]> }): JSX.Element {
  return (
    <dl className="rd-kv">
      {props.rows.map(([k, v], i) => (
        <KVRow key={`${k}-${i}`} k={k} v={v} />
      ))}
    </dl>
  );
}

function KVRow({ k, v }: { k: string; v: ReactNode }): JSX.Element {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

export function EmptyInspectorPlaceholder(): JSX.Element {
  return (
    <div className="rd-panel" style={{ height: '100%' }}>
      <div className="rd-placeholder">
        <Icon name="doc" size={40} color="#6f7681" />
        <div className="rd-big">选中图节点、模块或论文查看详情。</div>
        <div>在左侧实验编排中点击任意节点，<br />查看详细信息、相关内容和操作。</div>
      </div>
    </div>
  );
}
