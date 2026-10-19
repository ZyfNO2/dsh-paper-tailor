/**
 * BR-FE3 — Mermaid flowchart renderer for the work tree (Plan §7).
 *
 * Mermaid is vendored locally (tools/mermaid, pinned + lockfile) and bundled by esbuild —
 * never a runtime CDN. The diagram SOURCE always comes from `toMermaidFlowchart` over the
 * real nodes/edges; model-generated graph text is never rendered.
 *
 * Safety: `securityLevel: 'strict'` (no script/click directives, no HTML labels), labels
 * are pre-escaped by the generator, and clicks resolve through the stable idMap — never by
 * title or layout order. A stale async render (older research/graph) is discarded by token
 * and never overwrites the current view. On render failure the real node/edge list shows
 * instead of a faked success or the previous research's graph.
 */
import { useEffect, useRef, useState } from 'react';
import mermaidModule from 'mermaid';
import { graphFallbackText, toMermaidFlowchart, type MermaidGraph as MermaidGraphModel } from './worktree-mermaid.ts';
import type { ResearchEdgeView, ResearchNodeView } from './view-model.ts';

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

let api: MermaidApi | null = null;
function loadMermaid(): Promise<MermaidApi | null> {
  // STATIC import: esbuild inlines the whole library, so no dynamic `import()` executes in the
  // DSH factory-require scope (a dynamic import there has no module context and never settles —
  // the exact hang the first real-browser run hit, stuck on the loading line forever).
  if (api !== null) return Promise.resolve(api);
  // The ESM entry exports `{ …, Nm as default }`; through esbuild's cjs transform the
  // namespace shape differs between dev and bundle, so accept BOTH: `.default` first, then
  // the namespace itself (mermaid's own API object carries initialize/render directly).
  const mod = mermaidModule as unknown as { default?: MermaidApi } & MermaidApi;
  api = (mod?.default ?? mod) as MermaidApi;
  if (typeof api?.initialize !== 'function' || typeof api?.render !== 'function') {
    api = null;
  }
  return Promise.resolve(api);
}

function themeVariables(dark: boolean): Record<string, string | boolean> {
  // Node/edge-label TEXT must contrast the classDef FILLS in worktree-mermaid.ts, which are
  // light pastels in BOTH themes — so text stays dark regardless of the page theme. The
  // 2026-10-10 quick fix: dark mode previously inherited near-white text → white-on-white.
  return dark
    ? { darkMode: true, background: '#0e1116', primaryColor: '#1c2530', primaryTextColor: '#172033', lineColor: '#9aa3b2', textColor: '#172033', edgeLabelBackground: '#e8ecf2' }
    : { darkMode: false, background: '#ffffff', primaryColor: '#ffffff', primaryTextColor: '#172033', lineColor: '#8b93a1', textColor: '#172033', edgeLabelBackground: '#e8ecf2' };
}

export function MermaidGraph(props: {
  nodes: ResearchNodeView[];
  edges: ResearchEdgeView[];
  direction: 'LR' | 'TB';
  dark: boolean;
  selectedId: string | null;
  onSelectNode: (nodeId: string) => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [graph, setGraph] = useState<MermaidGraphModel | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(0);
  const graphRef = useRef<MermaidGraphModel | null>(null);
  graphRef.current = graph;

  useEffect(() => {
    const built = toMermaidFlowchart(props.nodes, props.edges, props.direction);
    setGraph(built);
    setSvg(null);
    setError(null);
    const token = (tokenRef.current += 1);
    let cancelled = false;
    void loadMermaid().then(async (loaded) => {
      if (cancelled || tokenRef.current !== token) return;
      if (loaded === null) {
        setError('图渲染器加载失败，显示真实节点列表。');
        return;
      }
      try {
        loaded.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          flowchart: { htmlLabels: false, useMaxWidth: false },
          theme: props.dark ? 'dark' : 'default',
          themeVariables: themeVariables(props.dark),
        });
        // Bounded render: if mermaid cannot render in this environment the page must fall
        // through to the real-list fallback instead of spinning the loading line forever.
        const renderPromise = loaded.render(`rd-mm-${token}`, built.text);
        const timeout = new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('render timeout 12s')), 12_000); });
        const result = await Promise.race([renderPromise, timeout]);
        if (cancelled || tokenRef.current !== token) return;
        setSvg(result.svg);
      } catch (err) {
        if (cancelled || tokenRef.current !== token) return;
        setError(`图渲染失败：${err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160)}`);
      }
    });
    return () => { cancelled = true; };
    // Re-render when the FACTS change, not on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.nodes, props.edges, props.direction, props.dark]);

  // Controlled DOM events: click/keyboard on rendered nodes map back through the idMap.
  // Mermaid emits no click directives (securityLevel strict + no click lines generated).
  useEffect(() => {
    const container = containerRef.current;
    const current = graphRef.current;
    if (container === null || svg === null || current === null) return;
    const onClick = (e: MouseEvent): void => {
      const target = (e.target as HTMLElement | null)?.closest?.('[id]') as HTMLElement | null;
      if (target === null || target === undefined) return;
      // Mermaid flowchart node elements carry the safe id (n0…) in their DOM id.
      const match = /n\d+/.exec(target.id);
      if (match === null) return;
      const realId = current.idMap.get(match[0]);
      if (realId !== undefined) props.onSelectNode(realId);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = (e.target as HTMLElement | null)?.closest?.('[id]') as HTMLElement | null;
      if (target === null || target === undefined) return;
      const match = /n\d+/.exec(target.id);
      if (match === null) return;
      const realId = current.idMap.get(match[0]);
      if (realId === undefined) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        props.onSelectNode(realId);
        return;
      }
      // Arrow keys move through the visible nodes in diagram order (Mermaid owns the layout,
      // so stored x/y no longer position anything): up/left = previous, down/right = next.
      if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const order = [...current.idMap.keys()];
      const at = order.indexOf(match[0]);
      if (at === -1) return;
      const nextSafe = (e.key === 'ArrowRight' || e.key === 'ArrowDown')
        ? order[(at + 1) % order.length]
        : order[(at - 1 + order.length) % order.length];
      const nextReal = current.idMap.get(nextSafe);
      if (nextReal !== undefined) {
        props.onSelectNode(nextReal);
        // Move DOM focus to the newly selected node.
        const element = container.querySelector(`[id*="${nextSafe}"]`) as HTMLElement | null;
        element?.focus?.();
      }
    };
    container.addEventListener('click', onClick);
    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('click', onClick);
      container.removeEventListener('keydown', onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svg]);

  // Mark the selected node: post-process the rendered SVG by safe id.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || graph === null) return;
    const selectedSafe = props.selectedId === null ? null
      : [...graph.idMap.entries()].find(([, real]) => real === props.selectedId)?.[0] ?? null;
    for (const element of container.querySelectorAll('[id]')) {
      const match = /n\d+/.exec((element as HTMLElement).id);
      if (match === null) continue;
      (element as HTMLElement).classList.toggle('rd-mmSelected', match[0] === selectedSafe);
    }
  }, [svg, graph, props.selectedId]);

  if (error !== null) {
    return (
      <div className="rd-mmFallback" role="status">
        <div className="rd-dim" style={{ marginBottom: 8 }}>{error}</div>
        <pre className="rd-dim" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{graphFallbackText(props.nodes, props.edges)}</pre>
      </div>
    );
  }
  if (svg === null) {
    return <div className="rd-dim" role="status">图生成中…（节点 {props.nodes.length} 个，关系 {props.edges.length} 条）</div>;
  }
  return (
    <div
      ref={containerRef}
      className="rd-mmContainer"
      role="group"
      aria-label={`研究图：${graph?.nodeCount ?? 0} 个节点，${graph?.edgeCount ?? 0} 条关系。Tab 可在节点间移动，回车查看详情。`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
