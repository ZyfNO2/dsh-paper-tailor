/**
 * Small shared interactive controls: chips, object-link buttons, modal and a
 * reason prompt. Keeps navigation and action semantics consistent across the
 * three pages.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './icons.tsx';
import type { ObjectLink } from './view-model.ts';
import { useWorkbench } from './WorkbenchView.tsx';

/**
 * The real width of the element the host actually gave us (not the viewport).
 *
 * Breakpoints are driven by the workbench CONTAINER, because the DSH shell can
 * render this page in a panel far narrower than the window (FE-01 §4). Returns
 * `null` until measured, so callers can render the desktop layout first instead
 * of flashing a drawer.
 */
export function useContainerWidth(): [React.RefObject<HTMLDivElement>, number | null] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const measure = (w: number): void => { if (w > 0) setWidth(Math.round(w)); };
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number') measure(w);
    });
    ro.observe(el);
    measure(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** The breakpoint band for a measured container width (FE-01 §4). */
export type LayoutBand = 'wide' | 'medium' | 'narrow';

/**
 * A width of 0 means "not measured yet" (hidden tab, no layout, no
 * ResizeObserver) — that must fall back to the desktop layout, never to the
 * narrow drawer, or a page mounted in a hidden panel would open drawers.
 */
export function layoutBandOf(width: number | null): LayoutBand {
  if (width === null || width <= 0) return 'wide';
  if (width < 700) return 'narrow';
  if (width < 1100) return 'medium';
  return 'wide';
}

/**
 * A detail panel shown as an overlay drawer at narrow widths.
 *
 * Keyboard reachable and closable, with focus returned to the invoking element
 * (FE-01 §4): the caller hands back whatever it needs to focus on close.
 */
export function Drawer(props: {
  title: string;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
  children: ReactNode;
}): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);
  useEffect(() => () => { props.returnFocusTo?.focus(); }, []);
  return (
    <div className="rd-drawer" role="dialog" aria-modal="true" aria-label={props.title}>
      <div className="rd-drawerHead">
        <b style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.title}</b>
        <span className="rd-spacer" />
        <button ref={closeRef} type="button" className="rd-btn rd-btn-ghost" aria-label="关闭" onClick={props.onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="rd-drawerBody">{props.children}</div>
    </div>
  );
}

export function Chip(props: {
  tone?: 'blue' | 'green' | 'purple' | 'yellow' | 'gray' | 'red';
  /** Explicit class, for the shared status maps in view-utils.ts. */
  cls?: string;
  children: ReactNode;
  title?: string;
}): JSX.Element {
  const cls = props.cls ?? (props.tone === undefined ? 'rd-chip' : `rd-chip rd-chip-${props.tone}`);
  return <span className={cls} title={props.title}>{props.children}</span>;
}

/**
 * Renders an ObjectLink as a navigation button. Broken links (missingReason)
 * are rendered non-interactively with the reason — FE-A05.
 */
export function ObjectLinkButton(props: { link: ObjectLink; children?: ReactNode }): JSX.Element {
  const { navigate } = useWorkbench();
  if (props.link.missingReason !== null && props.link.missingReason !== undefined) {
    return (
      <span className="rd-broken" title={props.link.missingReason}>
        <Icon name="warning" size={12} />
        {props.children ?? props.link.label}
        <span>（断链：{props.link.missingReason}）</span>
      </span>
    );
  }
  return (
    <button type="button" className="rd-linkBtn" onClick={() => navigate(props.link)}>
      {props.children ?? props.link.label}
    </button>
  );
}

export function LinkList(props: { links: ObjectLink[]; emptyText?: string }): JSX.Element {
  if (props.links.length === 0) {
    return <span className="rd-dim">{props.emptyText ?? '暂无关联。'}</span>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-start' }}>
      {props.links.map((l, i) => (
        <span key={`${l.kind}:${l.key}:${l.ref ?? ''}:${i}`} className="rd-row">
          <Icon name="link" size={12} color="#6f7681" />
          <ObjectLinkButton link={l} />
          {l.revision !== null && l.revision !== undefined && <span className="rd-dim" style={{ fontSize: 11 }}>{l.revision}</span>}
        </span>
      ))}
    </div>
  );
}

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);

  return (
    <div className="rd-modalMask" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="rd-modal" style={props.width !== undefined ? { width: props.width } : undefined} role="dialog" aria-modal="true" aria-label={props.title}>
        <div className="rd-row">
          <div className="rd-modalTitle">{props.title}</div>
          <button className="rd-btn rd-btn-ghost" style={{ marginLeft: 'auto' }} aria-label="关闭" onClick={props.onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
        {props.children}
        {props.footer !== undefined && <div className="rd-row" style={{ justifyContent: 'flex-end', gap: 8 }}>{props.footer}</div>}
      </div>
    </div>
  );
}

export function ReasonPromptModal(props: {
  title: string;
  submitLabel: string;
  reasonPlaceholder?: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void> | void;
  children?: ReactNode;
}): JSX.Element {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (reason.trim().length === 0) {
      setError('请先填写原因（扩展 / 保留 / 剪枝都需要记录理由）。');
      return;
    }
    setError(null);
    setPending(true);
    try {
      await props.onSubmit(reason.trim());
      props.onClose();
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button className="rd-btn" onClick={props.onClose} disabled={pending}>取消</button>
          <button className="rd-btn rd-btn-primary" onClick={submit} disabled={pending}>
            {pending ? '提交中…' : props.submitLabel}
          </button>
        </>
      }
    >
      {props.children}
      <div className="rd-field">
        <label>原因（必填，仅发送动作事件，不替后端决定结果）</label>
        <textarea className="rd-input" rows={3} style={{ resize: 'vertical' }}
          placeholder={props.reasonPlaceholder ?? '说明这样做的依据…'}
          value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {error !== null && <div className="rd-reject">{error}</div>}
    </Modal>
  );
}

export function useAsyncAction(): {
  pending: boolean;
  error: string | null;
  run: (fn: () => Promise<{ ok: boolean; message: string; reason?: string }>) => Promise<boolean>;
  reset: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    pending,
    error,
    reset: () => setError(null),
    async run(fn) {
      setPending(true);
      setError(null);
      try {
        const out = await fn();
        if (!out.ok) setError(out.reason ?? out.message);
        return out.ok;
      } finally {
        setPending(false);
      }
    },
  };
}
