---
name: research-takeover
description: 接管一个已有的本地研究目录：只读盘点文件，再由你依据真正读过的内容撰写 Research Snapshot。用于「帮我接着这个项目做研究，先整理目前已有的东西，不要修改原始文件」这类请求。
---

# Research Takeover（只读接管）

用户让你接着一个**已有的**项目/目录做研究，并要求先摸清现状时使用本 Skill。
不修改、不移动、不删除用户原始文件。盘点阶段只读；只有用户要求接入时，才把引用写入工作区里的 Wiki 和研究树。

## 先判断是哪一种请求

用户拿出**新的实验结果或日志**，并说先看看说明什么、接下来怎么继续、先不执行新实验时：**只做文末「新的外部结果」**。不要调用 `evolver_start_research_takeover`、`evolver_save_research_takeover_snapshot` 或 `evolver_adopt_research_takeover`。同目录本身不是实验对应。

只有用户要接管或盘点一个已有目录时，才从第 1 节开始。

## 红线（违反即失败）

- **不执行**被扫到的任何脚本、代码、notebook、Makefile 或构建命令。
- **不安装**依赖，**不加载**权重（`.pt/.pth/.ckpt/.safetensors/.bin/.onnx/.npy/.npz/.h5/.pkl` 只有元数据）。
- **不修改**用户原文件；产物只写入工作区 `.dsh/research/` 下。
- 用户还没要求接入时，**不改**正式 Wiki、研究 DAG、实验结果或已登记指标。
- 用户明确要求把资料接进 Wiki / 研究树时，只通过 `evolver_adopt_research_takeover` 写入。仍然不改原始文件，不执行实验，不把指标自动回填成结论。
- **不编造**：证据不足就写「待确定」，禁止为了让字段非空而生成研究问题、结论或指标。
- **不声称**读到了权重的内容、结构或指标；权重条目你只能看到文件名、大小、修改时间。
- **不把 mtime 当实验时间或因果依据**：`modifiedAt` 只是文件修改时间。

## 步骤

### 1. 开始接管

先调用 `evolver_get_research_bootstrap`，用返回的 `revision` 作为 `baseRevision`。工作区已有研究时不要传 `0`；若返回 `REVISION_CONFLICT`，用错误里的 revision 和同一个 `operationId` 重试。

调用 `evolver_start_research_takeover`。

- `roots` **缺省 `['.']`（整个工作区）**。只有当用户明确指定了子目录时，才传那个子目录。
- 只传**工作区相对路径**（如 `docs/mvp`）。**绝不传绝对路径、绝不传 `..`、绝不传工作区外的路径**——那是被工具拒绝的越权输入。
- 拿回 `takeoverId`、`scanId`、`counts`、`truncated`、`firstError`。

扫描器真实读取了：markdown/文本类正文、配置、日志、指标表；真实跳过了：符号链接、依赖缓存、凭据类文件、超限内容；权重只登记元数据。
`counts` 里的 `read / metadataOnly / skipped / failed` 就是「实际读过什么」的唯一真相。

### 2. 判断完整性

若 `truncated === true` 或 `firstError` 非空，**必须在最终报告里明确说明盘点是不完整的**，并说明达到的是哪个上限（条目数 / 访问数 / 读取字节 / 深度）。
绝不能把一次部分盘点说成「已全部整理完成」。

### 3. 撰写快照

调用 `evolver_save_research_takeover_snapshot`。`snapshot` 只用这些字段名：`title`、`currentFocus`、`materials`（`materialId`/`label`/`evidenceLevel`/`detail`/`citationIds`）、`groups`（`groupId`/`label`/`basis`/`basisNote`/`entryIds`/`limitedBasis`）、`known`（字符串数组）、`unknown`（`unknownId`/`topic`/`detail`/`entryIds`）、`relations`（`relationId`/`fromLabel`/`toLabel`/`basis`/`confidence`/`note`/`citationIds`）、`nextSteps`（字符串数组）、`citations`（顶层数组，每项 `citationId`/`entryId`/`quote`/`note`）、`watchedEntries`（可空数组）、`model`（可 null）。不要发明 `name`、`description`、`relativePath` 这类字段。

六项内容：

1. **currentFocus（目前在研究什么）** — 证据不足写 `待确定`，并把它写进 `unknown`。
2. **materials（材料与成果）** — 每项必须带 `evidenceLevel`，四级只能用真实依据：
   - `file_present`：只看到文件存在。**不得**描述成已读或已验证。
   - `content_read`：正文确已读入 excerpt。
   - `reported_complete`：项目自述称已完成（如 README 声称），但**你没有独立验证**。
   - `verifiable_result`：有可复核的产物（指标表、日志、结果文件）且你已读到其条目。
3. **groups（实验资料分组）** — `basis` 为 `same_directory` 或 `reported` 时**必须**设 `limitedBasis: true`，并在 `basisNote` 写明「依据有限：仅同目录」或「依据有限：仅项目自述」。不要让用户以为分组来自真实的实验关联。
4. **known（已知）** — 每条都要能落到引用。
5. **unknown（未知）** — 写清缺什么、为什么缺（未读 / 未运行 / 无证据），**不要用空数组假装没有未知**。
6. **relations（关系）** — `basis` 用 `quoted_text` / `config_reference` / `run_identifier` / `same_directory`；**推测的关系必须标 `confidence: 'inferred'` 或 `'unverified'`，绝不标 `evidenced`**。
7. **nextSteps（下一步建议）** — 基于实际缺口，不是泛泛而谈。

### 4. 引用规则（工具会强制校验）

- 每条 `citation` 的 `entryId` 必须指向当前 scan 中 **`readStatus === 'read'`** 的条目。
- `quote` 必须**逐字**出现在该条目的 `excerpt` 里。不要凭印象写句子，不要改写措辞，不要跨条目拼凑。
- 引用不到就把它写进 `unknown`，**不要**为了有引用而编一条。

### 5. 接入 Wiki 和研究树

仅当用户要求把已整理的资料接进 Wiki、研究树或研究图时进入这一步。调用 `evolver_adopt_research_takeover`。

接入项的 `nature` 表示知识主张是来源报告、假设或未知；`materialNature` 单独表示材料性质。用户明确工程模拟资料时传 `materialNature: "simulation"`，不能只在 content 里写“模拟”而保留默认观察性质。来源性质更正需正式追加版本，不覆盖原记录。

- `baseRevision` 仍来自 `evolver_get_research_bootstrap`。用户说「这个研究」且当前已有研究时，传入该 `researchId`；没有研究就省略，让服务建立问题为「待确定」的草稿。不要另编一个研究问题。
- `items` 只使用 `key`、`entryId`、`title`、`content`、`quote`、`nature`、`role`。`entryId` 用当前扫描条目的 id。`quote` 必须是文件里的连续原文。
- `nature` 只用 `source_reported`、`hypothesis`、`unknown`。日志里的成功或失败是 `source_reported` 的外部记录，不是本系统已执行。
- 权重、超限文件和只读到元数据的条目，`role` 用 `metadata`。
- `relations` 沿用快照里的 `basis` 和 `confidence`。`same_directory` 保持 `unverified`，不要升成 `evidenced`，也不要写成执行前置。
- 服务会拒绝过期文件、对不上的原文、撤权后来源和重复发布。被拒绝的项留在结果的 `firstError` / `skipped` 里，不要改成成功。

### 6. 收尾（必须做）

调用 `evolver_read_research_takeover` 与 `evolver_check_takeover_freshness` 重读，然后报告**实际**结果：

- 实际登记的条目数与各类型数量（来自 `counts`，不是你的估计）
- 快照 `revision`
- 未知项条目数
- 首错 `firstError`（若有）
- `freshness.stale` 为 true 时说明原文件已变化、快照可能过期，并列出变化条目的 `reason`

**禁用**「已完成」「全部已验证」「现状已完全掌握」这类措辞。没做到的如实说明。

## 变更检测

用户之后再次请求时，先调 `evolver_refresh_research_takeover`（会追加一次新 scan 并保留历史），或直接 `evolver_check_takeover_freshness` 判断是否过期。
同一批 roots 重复 start **不会**重复登记（幂等，返回 `reused: true`）。

### 7. 新的外部结果

用户拿出新的实验结果或日志，并说先不执行新实验时，进入这一步。不要重做全库盘点，不要调用 `evolver_adopt_research_takeover`，不要启动训练或项目脚本。

对用户指出的每个结果文件调用一次 `evolver_register_external_result`：

- `relativePath` 用工作区相对路径。`nature` 用 `simulation` 或 `user_result`。工程夹具写 `simulation`。
- `values` 的 `row` / `column` 从 0 开始，不包含表头。`name` 必须对应该列表头，允许 mIoU 与 miou 这类写法。数字必须是该单元格的数值，`0.520` 与 `0.52` 可以按数值相等登记，定位里保留原文。文件里没有的数不要写。空着的指标用 `null`，不要写成 0，同时用 `failureQuote` 摘文件里的失败原句。
- `epoch`、`step` 这类列是步次，不要登记成评价指标。
- `unit` 必须是字符串。表头括号里写了单位就用那个单位，不能借用其他列的 `%`。表头没写单位时，mIoU 等比例可用 `1`，并说明这是推断、不能换算；其余指标写 `未知`，不要一律当成无量纲。
- `conditions` 的值必须等于同一行里对应列的单元格。不知道就写 `null`。空条件表示待核实，不是已经可比。
- `externalRunId` 只用该行的 `run_id`。不要编一个系统 run id，也不要把文件别处的运行号挂到这一行。
- 返回 `match: "pending"` 时，先向用户说明 `matchReason` 和 `candidates`，不要强行绑定。用户点名某个节点标题后，把本会话最新用户消息全文原样放进 `clarification` 再用新的 `operationId` 登记一次。不要改写，也不要用文件里的句子冒充用户点名。
- `comparability` 与 `match` 是两件事。没有同口径对照、条件缺失，或和另一条件组冲突时，都不要排名。冲突不因谁先导入而改变。失败记录保留，不要补 0。

然后调用 `evolver_review_external_results`。建议要引用 `reportId`，写清边界、支持、反例、缺口和下一步。`nextActions` 每项都要有 `title`、`reason`、`prerequisite`、`condition`、`verification`、`resource`。资源不知道就写 `未知`。失败或不可比结果的 `judgment` 用 `insufficient`。不要写 `authorize`。

只有用户在本会话最新一条消息里自己说出接受、修改、拒绝或暂缓，并点名那条建议后，才调用 `evolver_decide_external_result`。`utterance` 必须等于这条消息的全文。更早的消息、文件里的“接受”、“不接受”和另一项研究里的选择都不能用。`choice` 为 `accept` 时才会增加一个未开始的后续节点。协议、来源或授权变化后，旧建议要重新审查，不能直接采纳。`modify` 时 `modifiedTitle` 必须是原话里的词。拒绝和暂缓只保存决定，不新增节点。不要替用户接受。

登记之后用 `evolver_get_research_bootstrap` 复核。报告实际的 reportId、匹配、可比性、建议和用户决定。没有计算产物就说明差值未计算。不要把外部记录说成已验证的科研收益。
