/**
 * Model data flow: the typed semantic graph the workbench renders (W4).
 *
 * Spec: docs/mvp/WORKBENCH-RESEARCH-SPEC.md sections 4.2, 4.3, 4.4.
 *
 * What this module produces
 * -------------------------
 * A `ModelDataFlow` describing how an input actually travels through the model
 * for ONE candidate — as opposed to the exploration tree, which describes which
 * candidate relates to which experiment. The two are separate views over the
 * same research and are linked by `candidateKey`.
 *
 * The hard rule: **the graph is built from registered adapters and published
 * recipes, never inferred.**
 *
 * SPEC section 4.3 permits exactly two levels:
 *  - `conceptual` — from the P6 candidate's own bindings. Position, order and
 *    shapes stay UNKNOWN unless the source recorded them.
 *  - `code_bound` — from a published recipe / AdaptationPlan plus a registered
 *    profile adapter. Order, slot and components are code-confirmed.
 *
 * There is no Python parser and no guessing. A profile with no registered
 * adapter gets an explicit "尚无代码数据流适配" state and MAY keep its
 * conceptual graph, but it can never be promoted to `code_bound`. That is the
 * difference between "we read the code" and "we inferred something plausible".
 *
 * The `stitch-cpu-v1` baseline is registered as a real adapter (SPEC section 4.4)
 * because its structure is genuinely published:
 *   image -> conv/ReLU -> features.pre_pool (ordered modules) -> global avg pool
 *   -> flatten -> linear -> prediction
 * The classifier head belongs to THAT profile and is not generalised to every
 * model, and a foreground-ratio binary task is NOT drawn as a pixel mask.
 */

import { createHash } from 'node:crypto';

import {
  findTensorCycle,
  type BoundRef,
  type FlowEdgeKind,
  type FlowNodeKind,
  type ModelDataFlow,
  type ModelDataFlowEdge,
  type ModelDataFlowNode,
} from '../contracts/workbench.ts';
import { paperOnlyRef } from './workbench-research.ts';
import type { Json } from './workbench-research.ts';

type Record_ = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function obj(v: unknown): Record_ {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record_) : {};
}

// ----------------- registered profile adapters -----------------

/**
 * A profile adapter knows how to draw ONE registered baseline profile.
 *
 * It returns structure only. It never returns a status, a metric or a claim
 * about whether the model works — those come from reports, not from a diagram.
 */
export interface ProfileAdapter {
  profileId: string;
  version: number;
  /** The baseline skeleton, without any inserted module. */
  buildBaseline(input: {
    source: BoundRef;
    /** The task's declared output, so a classification head is not drawn as a mask. */
    outputKind: 'image_classification' | 'binary_foreground_ratio' | 'pixel_segmentation';
    /** Chinese labels; the adapter owns wording for its own architecture. */
    labels: BaselineLabels;
  }): { nodes: ModelDataFlowNode[]; edges: ModelDataFlowEdge[]; slotNodeId: string };
  /** Insert the declared modules into the skeleton, in the declared order. */
  insertModules(input: {
    skeleton: { nodes: ModelDataFlowNode[]; edges: ModelDataFlowEdge[]; slotNodeId: string };
    orderedModuleIds: string[];
    moduleLabels: Map<string, string>;
    source: BoundRef;
  }): { nodes: ModelDataFlowNode[]; edges: ModelDataFlowEdge[]; unresolved: Array<{ subjectId: string; reasonZh: string }> };
  /** The training branch, including label and loss. */
  buildTraining(input: {
    predictionNodeId: string;
    source: BoundRef;
    labels: BaselineLabels;
    metricLabelZh: string;
  }): { nodes: ModelDataFlowNode[]; edges: ModelDataFlowEdge[] };
}

export interface BaselineLabels {
  input: string;
  trunk: string;
  slot: string;
  pool: string;
  head: string;
  prediction: string;
  /** Only used by the training branch; absent means a generic label. */
  label?: string;
}

/**
 * `stitch-cpu-v1` — registered because its structure is published, not guessed.
 *
 * From experiments/stitch-cpu-v1/model.py:
 *   Conv2d(3->8, k=3, p=1) -> ReLU -> pre_pool -> AdaptiveAvgPool2d((1,1))
 *   -> flatten -> Linear(8,2)
 * and configs/phase2/profile-cpu-seg-v1.json declares the `features.pre_pool` slot.
 */
const STITCH_CPU_V1: ProfileAdapter = {
  profileId: 'phase2-cpu-seg-v1',
  version: 1,
  buildBaseline({ source, outputKind, labels }) {
    const nodes: ModelDataFlowNode[] = [
      node('in', 'input', labels.input, null, source),
      node('trunk', 'baseline_part', labels.trunk, 'baseline', source),
      node('slot', 'merge', labels.slot, 'baseline', source),
      node('pool', 'baseline_part', labels.pool, 'baseline', source),
      node('head', 'baseline_part', labels.head, 'baseline', source),
      node('prediction', 'prediction', labels.prediction, 'baseline', source),
    ];
    const edges: ModelDataFlowEdge[] = [
      edge('e1', 'in', 'trunk', 'tensor', null, source),
      edge('e2', 'trunk', 'slot', 'tensor', null, source),
      edge('e3', 'slot', 'pool', 'tensor', null, source),
      edge('e4', 'pool', 'head', 'tensor', null, source),
      edge('e5', 'head', 'prediction', 'tensor', null, source),
    ];
    // A classification head is NOT a segmentation mask. For the pilot's
    // foreground-ratio task the output is a scalar ratio per image, and drawing
    // a pixel-shaped mask would misstate what the model computes.
    if (outputKind === 'pixel_segmentation') {
      const mask = node('mask', 'output', '像素级掩码', 'baseline', source);
      nodes.push(mask);
      edges.push(edge('e6', 'prediction', 'mask', 'tensor', null, source));
    }
    return { nodes, edges, slotNodeId: 'slot' };
  },
  insertModules({ skeleton, orderedModuleIds, moduleLabels, source }) {
    const nodes = [...skeleton.nodes];
    const edges = [...skeleton.edges];
    const unresolved: Array<{ subjectId: string; reasonZh: string }> = [];
    if (orderedModuleIds.length === 0) {
      unresolved.push({ subjectId: 'slot', reasonZh: '该变体未声明任何模块，基线保持原样。' });
      return { nodes, edges, unresolved };
    }

    // The baseline's `trunk -> slot` edge is split so the modules sit INSIDE the
    // slot, in the declared order, rather than being appended after it.
    const slotIndex = edges.findIndex((e) => e.source === 'trunk' && e.target === 'slot');
    const inEdge = slotIndex >= 0 ? edges[slotIndex] : null;
    if (inEdge !== null) edges.splice(slotIndex, 1);

    let previous = 'trunk';
    orderedModuleIds.forEach((moduleId, index) => {
      const nodeId = `mod${index}`;
      const label = moduleLabels.get(moduleId);
      if (label === undefined) {
        // An unknown module is a GAP, not a blank box: naming it "模块 N" would
        // hide that the workbench could not resolve what this actually is.
        unresolved.push({ subjectId: moduleId, reasonZh: `模块 ${moduleId} 未在工作台目录中解析，无法显示其机制说明。` });
      }
      nodes.push(node(nodeId, 'module', label ?? moduleId, 'baseline', source, { methodKey: null, slotId: 'features.pre_pool' }));
      if (inEdge !== null) {
        edges.push(edge(`e${previous}-${nodeId}-in`, previous, nodeId, 'tensor', null, source));
      }
      previous = nodeId;
    });
    if (inEdge !== null) edges.push(edge(`e${previous}-slot`, previous, 'slot', 'tensor', null, source));
    return { nodes, edges, unresolved };
  },
  buildTraining({ predictionNodeId, source, labels, metricLabelZh }) {
    const nodes: ModelDataFlowNode[] = [
      node('label', 'label', labels.label ?? '标签', null, source),
      node('loss', 'loss', '损失函数', null, source),
      node('optim', 'training_control', '优化器（更新基线与模块权重）', null, source),
    ];
    const edges: ModelDataFlowEdge[] = [
      // WR-09: prediction and label BOTH feed the loss. Drawing the prediction
      // THROUGH the loss and out to an inference result is the classic wrong
      // graph, and it is prevented by the edge KINDS here: `supervision` never
      // reaches a `prediction` node.
      edge('s1', predictionNodeId, 'loss', 'supervision', metricLabelZh, source),
      edge('s2', 'label', 'loss', 'supervision', null, source),
      edge('c1', 'optim', 'loss', 'control', null, source),
    ];
    return { nodes, edges };
  },
};

/**
 * The registered adapters, by `profileRef`.
 *
 * A profile absent from this map has NO code adapter. That is a first-class
 * answer: the caller reports "尚无代码数据流适配" and may still render a
 * conceptual graph. It is never silently treated as structureless.
 */
export const PROFILE_ADAPTERS = new Map<string, ProfileAdapter>([
  [`${STITCH_CPU_V1.profileId}@${STITCH_CPU_V1.version}`, STITCH_CPU_V1],
]);

export function adapterFor(profileRef: string): ProfileAdapter | null {
  return PROFILE_ADAPTERS.get(profileRef) ?? null;
}

// ----------------- node/edge constructors -----------------

function node(
  id: string,
  kind: FlowNodeKind,
  labelZh: string,
  baselineGroup: string | null,
  source: BoundRef,
  extra: { methodKey?: string | null; slotId?: string | null } = {},
): ModelDataFlowNode {
  return {
    id,
    kind,
    labelZh,
    baselineGroup,
    methodKey: extra.methodKey ?? null,
    implementationRef: null,
    slotId: extra.slotId ?? null,
    ports: [
      { id: `${id}.in`, direction: 'in' },
      { id: `${id}.out`, direction: 'out' },
    ],
    // A tensorContract is set ONLY where the registered adapter's own template
    // declares one; nothing here is inferred from a shape nobody wrote down.
    tensorContract: null,
    sources: [{ artifact: source, locator: { kind: 'code_symbol', id, fieldPath: kind } }],
  };
}

function edge(
  id: string,
  sourceId: string,
  targetId: string,
  kind: FlowEdgeKind,
  labelZh: string | null,
  source: BoundRef,
): ModelDataFlowEdge {
  return {
    id,
    source: sourceId,
    sourcePort: `${sourceId}.out`,
    target: targetId,
    targetPort: `${targetId}.in`,
    kind,
    labelZh,
    sources: [{ artifact: source, locator: { kind: 'code_symbol', id: targetId, fieldPath: kind } }],
  };
}

// ----------------- builders -----------------

export interface BuildFlowInput {
  candidateKey: string;
  variantKey: string | null;
  /** The published AdaptationPlan binding: slot + ordered modules. */
  binding: { slotId: string | null; orderedModuleIds: string[] };
  /** `profileRef` exactly as the protocol declares it, e.g. "phase2-cpu-seg-v1@1". */
  profileRef: string | null;
  /** The recipe / adaptation-plan artifact the structure came from. */
  recipeSource: BoundRef;
  /** The P6 candidate artifact, for conceptual sources. */
  candidateSource: BoundRef;
  /** Additional immutable source pins (e.g. the frozen protocol). */
  sourceRefs?: BoundRef[];
  moduleLabels: Map<string, string>;
  outputKind: 'image_classification' | 'binary_foreground_ratio' | 'pixel_segmentation';
  labels?: Partial<BaselineLabels>;
  /** Include the training branch. Off for a purely inference-facing view. */
  includeTraining?: boolean;
  metricLabelZh?: string;
}

export const LEGACY_SEMANTIC_HASH_ALGORITHM = 'workbench-flow-sha256-v1' as const;
export const SEMANTIC_HASH_ALGORITHM_V2 = 'workbench-flow-sha256-v2' as const;

type FlowHashBody = Omit<ModelDataFlow, 'semanticHash'>;

const DEFAULT_LABELS: BaselineLabels = {
  input: '输入图片',
  trunk: '基线卷积 + ReLU',
  slot: '可插入模块位（features.pre_pool）',
  pool: '全局平均池化',
  head: '分类头',
  prediction: '预测',
};

/**
 * Build the flow for one candidate variant.
 *
 * Returns `level: 'conceptual'` when there is no registered adapter, and the
 * result then contains ONLY what the candidate itself recorded — no slot, no
 * order, no shapes. That degradation is deliberate: a conceptual graph that
 * looks like code is how a design sketch gets mistaken for an implementation.
 */
export function buildModelDataFlow(input: BuildFlowInput): ModelDataFlow {
  const labels = { ...DEFAULT_LABELS, ...(input.labels ?? {}) } as BaselineLabels;
  const adapter = input.profileRef === null ? null : adapterFor(input.profileRef);
  const unresolved: Array<{ subjectId: string; reasonZh: string }> = [];

  if (adapter === null) {
    // Conceptual: the baseline skeleton is stated as a design intent, with no
    // components claimed as code-confirmed and no slot or order asserted.
    const src = input.candidateSource;
    const nodes: ModelDataFlowNode[] = [
      node('in', 'input', labels.input, null, src),
      node('design', 'merge', '概念结构：模块作用于基线特征通路', 'baseline', src),
      node('prediction', 'prediction', labels.prediction, 'baseline', src),
    ];
    const edges: ModelDataFlowEdge[] = [
      edge('c1', 'in', 'design', 'tensor', null, src),
      edge('c2', 'design', 'prediction', 'tensor', null, src),
    ];
    for (const moduleId of input.binding.orderedModuleIds) {
      const id = `mod-${moduleId}`;
      nodes.push(node(id, 'module', input.moduleLabels.get(moduleId) ?? moduleId, 'baseline', src));
      edges.push(edge(`ce-${moduleId}`, 'design', id, 'tensor', '概念作用点', src));
    }
    unresolved.push({
      subjectId: 'profile',
      reasonZh: input.profileRef === null
        ? '该候选没有登记的 profile，无法确认代码结构；以下仅为概念示意，接口与顺序未验证。'
        : `profile ${input.profileRef} 尚无代码数据流适配，以下仅为概念示意，接口与顺序未验证。`,
    });
    if (input.binding.slotId !== null) {
      // The slot is a real recorded fact, so it is shown as such — but as a
      // claim about the DESIGN, not about the code.
      unresolved.push({ subjectId: 'slot', reasonZh: `配方声明的插入位为 ${input.binding.slotId}，但未经代码适配确认。` });
    }
    const flow = finish(input, nodes, edges, unresolved, 'conceptual');
    return flow;
  }

  const skeleton = adapter.buildBaseline({ source: input.recipeSource, outputKind: input.outputKind, labels });
  const inserted = adapter.insertModules({
    skeleton,
    orderedModuleIds: input.binding.orderedModuleIds,
    moduleLabels: input.moduleLabels,
    source: input.recipeSource,
  });
  const nodes = [...inserted.nodes];
  const edges = [...inserted.edges];
  unresolved.push(...inserted.unresolved);

  if (input.includeTraining === true) {
    const training = adapter.buildTraining({
      predictionNodeId: 'prediction',
      source: input.recipeSource,
      labels: { ...labels, label: '标签（前景占比）' },
      metricLabelZh: input.metricLabelZh ?? '对比损失',
    });
    nodes.push(...training.nodes);
    edges.push(...training.edges);
    // The optimiser feeds the WHOLE baseline, including the inserted modules.
    edges.push(edge('c2-optim-trunk', 'optim', 'trunk', 'control', '更新权重', input.recipeSource));
    for (const n of nodes) {
      if (n.kind === 'module') edges.push(edge(`c3-optim-${n.id}`, 'optim', n.id, 'control', '更新权重', input.recipeSource));
    }
  }

  return finish(input, nodes, edges, unresolved, 'code_bound');
}

/** Attach the derived semantic hash and run the structural checks. */
function finish(
  input: BuildFlowInput,
  nodes: ModelDataFlowNode[],
  edges: ModelDataFlowEdge[],
  unresolved: Array<{ subjectId: string; reasonZh: string }>,
  level: ModelDataFlow['level'],
): ModelDataFlow {
  // SPEC section 4.3: "节点/边/端口 ID 唯一且引用存在". Constructing well-formed
  // ids is not the same as CHECKING them — a future adapter that derived a
  // node id from a module name could collide, or point at a node that was never
  // emitted, and the page would render a plausible picture either way.
  for (const defect of verifyGraphIntegrity(nodes, edges)) {
    unresolved.push({ subjectId: defect.subject, reasonZh: defect.reasonZh });
  }

  const cycle = findTensorCycle({ nodes, edges });
  if (cycle !== null) {
    // A tensor cycle means the graph is wrong, not that the check is too strict.
    // It is surfaced as an unresolved defect so the caller refuses to render
    // rather than drawing a picture with an impossible edge.
    unresolved.push({ subjectId: cycle.join(' → '), reasonZh: '张量通路出现环状依赖，结构不成立，已停止渲染。' });
  }
  const subjectRefs = new Map<string, BoundRef>();
  for (const ref of [input.recipeSource, input.candidateSource, ...(input.sourceRefs ?? [])]) {
    subjectRefs.set(`${ref.store}:${ref.ref.id}:${ref.ref.sha256 ?? ''}`, ref);
  }
  const flow: ModelDataFlow = {
    schemaVersion: 1,
    candidateKey: input.candidateKey,
    variantKey: input.variantKey,
    level,
    subjectRefs: [...subjectRefs.values()],
    nodes,
    edges,
    unresolved,
    semanticHashAlgorithm: SEMANTIC_HASH_ALGORITHM_V2,
    // Placeholder; computed below from the body that excludes this field.
    semanticHash: '',
  };
  const { semanticHash, ...body } = flow;
  void semanticHash;
  return { ...body, semanticHash: computeSemanticHashV2(body) };
}

/**
 * SPEC section 4.3 structural checks: unique ids, resolvable references.
 *
 * Returns one entry per defect rather than throwing, so a caller can report
 * everything wrong with a structure at once instead of fixing one problem per
 * round-trip.
 */
export function verifyGraphIntegrity(
  nodes: ModelDataFlowNode[],
  edges: ModelDataFlowEdge[],
): Array<{ subject: string; reasonZh: string }> {
  const defects: Array<{ subject: string; reasonZh: string }> = [];
  const nodeIds = new Set<string>();
  for (const n of nodes) {
    if (nodeIds.has(n.id)) defects.push({ subject: n.id, reasonZh: `节点 id 重复：${n.id}` });
    nodeIds.add(n.id);
  }
  const edgeIds = new Set<string>();
  for (const e of edges) {
    if (edgeIds.has(e.id)) defects.push({ subject: e.id, reasonZh: `边 id 重复：${e.id}` });
    edgeIds.add(e.id);
    // Referential integrity: an edge into a node that was never emitted draws
    // as a line into empty space, which reads as a real connection.
    if (!nodeIds.has(e.source)) defects.push({ subject: e.id, reasonZh: `边的起点 ${e.source} 不存在` });
    if (!nodeIds.has(e.target)) defects.push({ subject: e.id, reasonZh: `边的终点 ${e.target} 不存在` });
  }
  // Port ids must be unique within a node, and an edge must name a real port.
  const portOf = new Map<string, Set<string>>();
  for (const n of nodes) {
    const ports = new Set<string>();
    for (const p of n.ports) {
      if (ports.has(p.id)) defects.push({ subject: `${n.id}.${p.id}`, reasonZh: `节点 ${n.id} 的端口 id 重复：${p.id}` });
      ports.add(p.id);
    }
    portOf.set(n.id, ports);
  }
  for (const e of edges) {
    if (nodeIds.has(e.source) && portOf.get(e.source)?.has(e.sourcePort) !== true) {
      defects.push({ subject: e.id, reasonZh: `边的起点端口 ${e.sourcePort} 不在节点 ${e.source} 上` });
    }
    if (nodeIds.has(e.target) && portOf.get(e.target)?.has(e.targetPort) !== true) {
      defects.push({ subject: e.id, reasonZh: `边的终点端口 ${e.targetPort} 不在节点 ${e.target} 上` });
    }
  }
  return defects;
}

/**
 * The semantic hash.
 *
 * Computed over the body EXCLUDING `semanticHash` itself and excluding render
 * layout, so re-laying-out the same structure does not make an existing diagram
 * stale, while a genuine structural change does.
 */
export function computeLegacySemanticHashV1(body: Omit<ModelDataFlow, 'semanticHash' | 'semanticHashAlgorithm'>): string {
  const canonical = JSON.stringify({
    candidateKey: body.candidateKey,
    variantKey: body.variantKey,
    level: body.level,
    nodes: body.nodes.map((n) => [n.id, n.kind, n.labelZh, n.baselineGroup, n.slotId]),
    edges: body.edges.map((e) => [e.id, e.source, e.target, e.kind]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Canonical v2 semantic hash. All semantic DTO fields are covered, including
 * endpoint ports, tensor contracts, provenance/source pins, and unresolved
 * reasons. Arrays representing graph sets are sorted by stable identifiers;
 * module order remains encoded in edge endpoints. Rendering layout is not part
 * of ModelDataFlow and is therefore deliberately absent.
 */
export function computeSemanticHashV2(body: FlowHashBody): string {
  const sources = <T>(items: T[]): T[] => [...items].sort((a, b) => compareCanonical(a, b));
  const normalized = {
    schemaVersion: body.schemaVersion,
    semanticHashAlgorithm: SEMANTIC_HASH_ALGORITHM_V2,
    candidateKey: body.candidateKey,
    variantKey: body.variantKey,
    level: body.level,
    subjectRefs: [...body.subjectRefs]
      .sort((a, b) => compareText(`${a.store}:${a.ref.id}:${a.ref.sha256}`, `${b.store}:${b.ref.id}:${b.ref.sha256}`)),
    nodes: [...body.nodes]
      .sort((a, b) => compareText(a.id, b.id))
      .map((node) => ({
        ...node,
        ports: [...node.ports].sort((a, b) => compareText(`${a.id}:${a.direction}`, `${b.id}:${b.direction}`)),
        sources: sources(node.sources),
        tensorContract: node.tensorContract === null
          ? null
          : { ...node.tensorContract, sources: sources(node.tensorContract.sources) },
      })),
    edges: [...body.edges]
      .sort((a, b) => compareText(a.id, b.id))
      .map((edge) => ({ ...edge, sources: sources(edge.sources) })),
    unresolved: [...body.unresolved]
      .sort((a, b) => compareText(`${a.subjectId}:${a.reasonZh}`, `${b.subjectId}:${b.reasonZh}`)),
  };
  return createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex');
}

function compareCanonical(a: unknown, b: unknown): number {
  return compareText(canonicalJson(a), canonicalJson(b));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('semantic graph cannot hash a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
  }
  throw new TypeError(`semantic graph cannot hash ${typeof value}`);
}

/**
 * Derive the diagram's status (SPEC section 8.2).
 *
 * `stale` is a real state, not an error: a diagram that was correct for an
 * earlier structure must not be presented as current, and must not be deleted
 * either. Availability never implies the research is validated.
 */
export function deriveDiagramStatus(input: {
  diagramSemanticHash: string | null;
  currentSemanticHash: string | null;
  validationPassed: boolean;
  validationReceiptReadable: boolean;
}): 'available' | 'unverified' | 'blocked' | 'stale' {
  if (input.diagramSemanticHash === null || input.currentSemanticHash === null) return 'unverified';
  if (input.diagramSemanticHash !== input.currentSemanticHash) return 'stale';
  if (!input.validationReceiptReadable) return 'unverified';
  return input.validationPassed ? 'available' : 'unverified';
}

// ----------------- recipe reading -----------------

/**
 * Read a published AdaptationPlan binding.
 *
 * The field names are taken from the real artifact
 * (`bindings[].slotId`, `bindings[].orderedModuleIds`), NOT guessed. A missing
 * binding returns null so the caller reports "缺 recipe" instead of inventing an
 * empty module list, which would render a baseline-only graph and imply the
 * candidate has no modules.
 */
export function readAdaptationBinding(plan: Json): { slotId: string | null; orderedModuleIds: string[] } | null {
  const bindings = arr(obj(plan).bindings);
  if (bindings.length === 0) return null;
  const first = obj(bindings[0]);
  const ordered = arr(first.orderedModuleIds).map(str).filter((v): v is string => v !== null);
  if (ordered.length === 0) return { slotId: str(first.slotId), orderedModuleIds: [] };
  return { slotId: str(first.slotId), orderedModuleIds: ordered };
}

/** Read the variants of a frozen experiment protocol, in declared order. */
export function readProtocolVariants(protocol: Json): Array<{ id: string; role: string; moduleRefs: string[] }> {
  return arr(obj(protocol).variants).map((v) => {
    const o = obj(v);
    return {
      id: str(o.id) ?? 'unknown',
      role: str(o.role) ?? 'unknown',
      moduleRefs: arr(o.moduleRefs).map(str).filter((x): x is string => x !== null),
    };
  });
}

/** A `BoundRef` for a published P6 result, for symmetry with the projections. */
export function candidateRef(id: string, sha256: string): BoundRef {
  return paperOnlyRef({ id, sha256 });
}