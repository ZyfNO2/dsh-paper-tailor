---
name: workbench-diagram
description: 为科研工作台的候选生成正式图稿。当用户要求"画架构图/画数据流图/导出可编辑图/生成论文配图"，且对象是某个候选（candidateKey）或其模型数据流时使用。先用 evolver_get_stage_context 取工作区，再用 /archify 或 /excalidraw-diagram 产出，最后用 evolver_register_diagram_output 登记。只画一种目标格式，不默认生成两套。
version: 1
---

# 工作台图稿：约束而非渲染器

这个 Skill **不复制渲染器**。它约束"画什么"和"登记什么"，排版与导出交给 `/archify` 或 `/excalidraw-diagram`。

## 铁律

1. **一次只选一种目标格式。** `/archify` 出可浏览 HTML/SVG；`/excalidraw-diagram` 出可编辑 `.excalidraw`。**不要两套都生成**——两套会漂移，而且用户没要求。
2. **不得改变结构。** 节点身份、边方向与关系、已知顺序、证据状态都由 Host 的 semantic graph 决定。你只填中文标签与布局。
3. **不得发明结构。** 概念图（`level: conceptual`）里未知的 slot、顺序、shape 保持未知标记，不要补一条看起来合理的箭头。
4. **不得给出新性能事实。** 图稿不携带任何指标、比较或"更好/更差"结论。
5. **不能以裸 path 登记。** 只能通过 `evolver_register_diagram_output`，且用固定文件名。

## 流程

### 1. 取上下文与工作区

```
evolver_get_stage_context({ taskId, candidateKey, stage: "implementation" })
```

取当前结构的 `semanticHash`。Host 依据 `taskId + semanticHash + format` 计算**固定绘图工作区**——你不能自己指定目录。

> 若 `level` 是 `conceptual`：在图上明确标注"设计示意，接口与顺序未验证"。
> 若是 `code_bound`：顺序与 slot 来自配方，可以照画。

### 2. 调用绘图 Skill

**选 `/archify`（详细架构图、报告配图、需要浏览/导出时）：**

在上述固定工作区下产出 `diagram.html`，并按该 Skill 的契约执行：

```
validate <type> <candidate.json> --quality showcase --json
deliver  <type> <candidate.json> diagram.html --quality showcase --json
visual-check diagram.html --json
```

- 每次编辑后、交付前都要 `validate`；**校验通过后不得再改**。
- `deliver` 非零退出即失败，不得当作成功。
- `visual-check` 的 `visualReview=pending` 就保持 `pending`，**实际看过图之后**才记为 inspected。

**选 `/excalidraw-diagram`（要可编辑、手绘风、后续自己改时）：**

产出 `diagram.excalidraw`，并按该 Skill 要求渲染、**看图**、修复、重渲染。这不是可选步骤——"JSON 能解析"不等于"图是对的"。

### 3. 写语义映射与验证收据

在工作区里另写两个文件，Host 登记时会一并收走：

- `mapping.json` — 必须是 v2 witness，并绑定本次 StageContext 的 graph ref 与 semantic hash：

  ```json
  {
    "schemaVersion": 2,
    "semanticGraphRef": { "store": "workbench", "ref": { "id": "…", "sha256": "…" } },
    "semanticHash": "…",
    "nodes": { "element-id": "semantic-node-id" },
    "edges": { "element-id": "semantic-edge-id" },
    "labels": { "semantic-node-id": "Host 给出的原始 labelZh" },
    "edgeEndpoints": {
      "semantic-edge-id": {
        "source": "node-id", "sourcePort": "port-id",
        "target": "node-id", "targetPort": "port-id",
        "relation": "tensor | supervision | control"
      }
    }
  }
  ```

  `nodes` / `edges` 必须对当前语义集合构成完整一一映射；标签必须逐一保留 Host 提供的原始 `labelZh`；每条边都必须逐项对应 Host 的有向节点、port 端点与关系类型。Host 语义图中边的关系字段名是 `kind`（取值 `tensor` / `supervision` / `control`），映射里写作 `relation`——两者指同一个量，必须逐项相等。不能增删身份、复用映射或交换方向。

  **Host 会用格式 adapter 解析实际图稿并与本文件比对。** mapping 只是你的声明；Host 读的是画出来的东西。因此图元必须带可解析的语义绑定：

  - `archify_html`：语义节点是 `<g data-element-id data-semantic-node-id data-label class="node">`；语义边是 `<path data-element-id data-semantic-edge-id data-source-node-id data-source-port data-target-node-id data-target-port data-relation class="edge">`。`display:none` / `visibility:hidden` / `opacity:0` 的占位不算节点。
  - `excalidraw`：语义节点元素用 `customData.semanticNodeId` 声明身份，并绑定至少一个非空文本容器作标签；语义边元素必须是 `arrow`/`line`，用 `customData.semanticEdgeId` 声明身份，`startBinding.elementId` / `endBinding.elementId` 指向那两个语义节点元素，`customData.sourcePort` / `targetPort` / `relation` 记录端口与关系。`isDeleted` 或 `opacity:0` 的图元不计入。
  - 额外画出的计算节点/边、未绑定的 group/label、注释都必须登记为 annotation 并说明用途，否则按"未知语义身份"拒绝。
- `validation-receipt.json` — 该绘图 Skill 的真实校验/渲染结果。

Agent 写出的 `validation-receipt.json` 只是待核验摘要，不能让图稿变为 `available`。只有 Host 从受管执行记录或已登记 validator 建立可信 witness（绑定 graph、图稿字节、工具版本、退出码/诊断与实际预览检查）后才可判为 `available`。当前 Host 若未提供该 witness 能力，图稿必须保持 `unverified` 并报告 `UNSUPPORTED_CAPABILITY`；不得伪造 Skill 身份或视觉检查。

### 4. 登记

```
evolver_register_diagram_output({
  taskId, candidateKey, variantKey, commandId,
  semanticGraphRef, format
})
```

- 输出必须落在**固定文件名**：`archify_html` → `diagram.html`；`excalidraw` → `diagram.excalidraw`。
- 登记**不增加 designRevision**；把它关联到任务需要另一次 `evolver_submit_design` 的 `attach_diagram`。
- 结构变了（semanticHash 变了）时旧图自动变 `stale`——**不要**用旧收据为新结构背书。

## 图稿状态

| 状态 | 含义 |
|---|---|
| `available` | 结构匹配 **且** Host 已建立可信验证 witness |
| `unverified` | 缺可信 witness，或结构未知 |
| `stale` | 图稿对应的是**旧结构** |
| `blocked` | 绘图环境不可用 |

当前 Host 未配置 validator/render witness 适配器，所以登记后的图稿只能是 `unverified`。这是诚实状态，不是缺陷被掩盖。

**图稿可用 ≠ 科研有效。** 它只说明"这张图和当前结构一致，且画过"，不说明任何结论成立。

## 环境不可用时

如实标 `blocked` 并说明缺什么（浏览器、渲染依赖、网络）。**不要**改用裸 API 或外部 CLI 冒充 DSH 绘图调用通过。工作台仍可查看 typed graph。