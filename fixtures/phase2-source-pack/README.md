# Phase 2 Source Pack (workstream A: 来源与数据准备)

Phase 2 的第一批工作是「来源与数据准备」（[PHASE2-RPD](../../docs/mvp/phases/PHASE2-RPD.md) "Worker 开工边界" 表第 1 行）：在具体候选确定之前，先核查代码/许可/版本，整理小数据切片、预处理和 manifest。本目录就是这项工作的产物。

契约对象是 [PHASE2-SPEC](../../docs/mvp/phases/PHASE2-SPEC.md) 第 2 节的 `SourceBundle`，冻结实现在 [contracts/experiments.ts](../../packages/evolver/src/contracts/experiments.ts)。**本包不发布 SourceBundle**——那要等候选确定之后（RPD 同表"依赖满足后再做"列）。

## 文件

| 文件 | 作用 |
|---|---|
| `manifest.json` | 来源清单：`bundle`（符合冻结 `SourceBundle` 形状）+ `pins`（每个被钉文件的 SHA-256/git blob/commit）+ 离线归档逐条目哈希 + 数据与环境引用 |
| `build-manifest.ts` | 从磁盘真实字节、真实 git 对象、真实 ZIP 中央目录**推导**出 `manifest.json`；没有任何手写哈希 |
| `environment.json` | 本机执行环境钉（解释器/包/CUDA/主机），并如实记录**没有锁文件** |
| `data/` | 小数据切片、确定性生成器/预处理器、`data-manifest.json` |
| `tools/zip-entries.ts` | 仅用 Node 内置模块读 ZIP 中央目录（含 CRC-32 校验） |
| `tools/npy-header.ts` | 读 `.npy` 头部，供校验器核对 dtype/shape 的真实来源 |
| `tools/adversarial-check.ts` | 反例自检：伪造一个**把所有哈希都重算一致**的包，证明语义检查仍然抓得住 |
| `../scripts/verify-phase2-sources.ts` | 独立校验器：重算每个哈希，不符即非零退出 |

## 钉了什么

3 个 `SourceEntry`，全部 `sourceKind: vcs`，`sourceUri` 指向本 checkout（本仓库**没有配置 git remote**）：

| id | role | commit | treeRef | entrypoint |
|---|---|---|---|---|
| `phase2-baseline-stitch-cpu-v1` | baseline | `1f0344ca3a7bdc3b7f7a0dc619abd36722869e62` | `experiments/stitch-cpu-v1` | `experiments/stitch-cpu-v1/model.py` |
| `phase2-module-aspp-v1` | module | `39e730408d4037352344e8abbf3dc0f9b095aaa6` | `fixtures/modules` | `fixtures/modules/aspp_block.py` |
| `phase2-module-se-v1` | module | `39e730408d4037352344e8abbf3dc0f9b095aaa6` | `fixtures/modules` | `fixtures/modules/se_block.py` |

另有 1 个 `offline_archive` 条目 `phase2-archive-academic-stitch-mvp`（`contentHash` = `e0fce656…4ea0`），**故意不放进 `bundle.modules`**：它的入口在归档内部，磁盘上没有可 import 的路径，登记成 module 就是声称一个并不存在的可运行来源。它作为 ASPP/SE 论文快照的来源旁证被钉住，13 个归档条目逐个记录了 sha256/CRC-32/大小。

baseline 还钉了它的权重 `artifacts/weights/baseline_seed20260929.pt`（`weightRefs`）与数据生成器 `experiments/stitch-cpu-v1/data.py`。

### 为什么 commit 是"每个文件各自的最后一次提交"

`treeRef` 是整个子目录，但 `commit` 记录的是**该文件最后一次被修改的提交**，而不是 HEAD。这样 `git cat-file -p <commit>:<path>` 一定拿得到被钉的那份字节；校验器把该 blob 与工作区字节逐字节比对（`blobMatchesWorkingTree`），所以"钉的 commit"和"盘上的文件"必须一致，不存在只钉一个方向的情况。`experiments/stitch-cpu-v1` 里 `runner.py` 后来被改过，所以 baseline 的 commit 是 `model.py`/`data.py` 的那次，不是目录最新那次。

## 怎么复验

```powershell
# 只重算哈希（不需要 Python，不需要网络）
node --experimental-strip-types scripts/verify-phase2-sources.ts

# 再加一步：重跑生成器，证明 .npy 字节可复现（需要带 numpy 的 python）
node --experimental-strip-types scripts/verify-phase2-sources.ts --data-determinism

# 从磁盘真实状态重建 manifest（改了任何被钉文件之后才需要）
node --experimental-strip-types fixtures/phase2-source-pack/build-manifest.ts

# 数据切片自检
python fixtures\phase2-source-pack\data\generate_data.py --check

# 反例自检：伪造一个哈希全部自洽的包，语义检查应当仍然拒绝
node --experimental-strip-types fixtures/phase2-source-pack/tools/adversarial-check.ts
```

`adversarial-check.ts` 会把 validation 的 `indexRange` 改成与 train 重叠的 `[10,18)`，然后把 `data-manifest.json` 的新摘要回写进 `source-manifest.json`（含 `dataRef`、`manifestSha256`、重算的 `sourceBundleHash`），使**纯哈希校验全部通过**。校验器仍然以 `SOURCE_MISMATCH: split index ranges do not tile [0,24)` 退出 1——因为划分必须无重叠、无空洞地铺满生成器样本数。脚本在 `finally` 里按原始字节还原两个文件。

校验器检查 8 类：冻结契约（`validateSourceBundle` 覆盖 bundle；`validateSourceEntry` 另外覆盖归档条目，因此 `offline_archive` 那条 `contentHash` 分支是被真正走到的）、`sourceBundleHash` 重算、每个被钉文件的 sha256/字节数/git blob/commit、tree 对象 id 与 commit 是否为 HEAD 祖先、工作区与 blob 是否一致、归档及其逐条目哈希、数据切片（含从 `.npy` 头部读出的真实 dtype/shape）、环境钉。任何一类不符都以 `SOURCE_MISMATCH`（归档损坏为 `ARTIFACT_CORRUPT`）记录并退出码 1。

**哈希规则**：文件用原始字节的普通 SHA-256（不做任何归一化，不改行尾）。本包不哈希任何 excerpt，所以**没有**使用 `module-registry.ts` 里那套 excerpt 空白归一化规则。

## 数据切片

`data/` 是一个 24 样本的合成 CPU 切片（train 16 + validation 8），生成耗时约 160 ms：

- **生成器**：`data/generate_data.py`，`numpy.random.default_rng(20261004).standard_normal(..., dtype=float32)`；标签规则 `(i * 7 + 3) % 2`（与仓内 `phase2-cpu-seg-v1/runner.py` 一致）
- **形状**：features `[N, 3, 16, 16]` float32，labels `[N]` int64
- **预处理**：按通道标准化，**只在 train 上拟合** mean/std，再应用到两个划分（避免验证集泄漏进变换）；零方差通道回退 scale=1.0 并记录
- **划分**：train = 索引 `[0,16)`，validation = `[16,24)`；**没有 test 划分**（Phase 2 不声明 test，Phase 3 的 `DataSplitManifest` 才有）
- **可复现性**：`--check` 会重新生成并逐文件比对哈希。`.npy` 头部不含时间戳，所以相同数组给出相同字节；`data-manifest.json` 本身也是逐字节可复现的（`createdAt` 是固定常量）

`dataRef` 指向 `data-manifest.json` 的 SHA-256。切片与 `stitch-cpu-v1/data.py`（seed 20260929，16 样本）**不是同一份数据**，两者不要混用。

## 没有验证什么（重要）

- **许可未解决**：本仓库（除 `node_modules` 外）**不存在任何 LICENSE/COPYING/NOTICE/COPYRIGHT 文件**。因此每个条目的 `licenseRef` 是字面值 `no-license-declared`，按 [PHASE2-DATA-REQUEST](../../docs/mvp/phases/PHASE2-DATA-REQUEST.md) §1.5 属于"默认保留全部权利"，**不得**当作可自由复用的来源。没有为凑字段编造 SPDX 标识。
- **上游未解决**：`git remote -v` 为空，所以没有可记录的公开上游 URL 或上游 commit。`sourceUri` 只指向本 checkout，commit 是本地 commit id。没有编造 GitHub 地址、commit 或 DOI。
- **不是官方实现**：`fixtures/modules/aspp_block.py`、`se_block.py` 是本仓自写的 8 通道简化实现，**不是** DeepLabv3 或 SENet 的官方代码。`arXiv:1706.05587` / `arXiv:1709.01507` 只作为机制出处被记录。
- **无依赖锁**：`pnpm-lock.yaml`、`package-lock.json`、`requirements.txt`、`environment.yml` 都不存在。PHASE2-SPEC §5 要求环境记录包锁；这里如实记录其**缺失**，而不是填一个假摘要。
- **无候选绑定**：本包钉的是可复用来源，不是某个候选的官方实现；`proposal` 是 `manual`，指向 RPD 这份工作边界。
- **无性能声明**：不声称任何模块能提升任何 baseline。那是 Phase 3 的工作，需要冻结的评测。
- **单机环境**：`environment.json` 只记录本机实测值，不构成"别的机器也能复现"的证据。
- **归档来源未证**：归档旁证只说明字节在哪，不说明作者是谁。`fixtures/mvp-source-pack/manifest.json` 记录过同一摘要，这算旁证，不算来源证明。

以上 6 项同时逐条写在 `manifest.json` 的 `bundle.unresolved[]` 里（`unresolved` 非空意味着按 SPEC §2 的语义，这不是一个干净的 pin）。校验器会**拒绝** `unresolved` 为空的包。

## 边界

- 不读评测 gold：不打开 `data/sealed/gold/**`、`fixtures/*/gold/**`、`fixtures/*/review/**`；唯一打开的归档是仓内 `work/incoming/academic_stitch_mvp.zip`。
- 无网络：不下载、不 clone、不查在线许可。
- 归档条目 `work/incoming/` 在 [readable-roots.json](../../fixtures/paper-only-v1/isolation/readable-roots.json) 的 `deniedPaths` 里，模型侧读不到；这一条是宿主侧记录，复验它的是宿主工具而非模型侧读取。
