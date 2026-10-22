# Research foundations：实现与验收

本分支在 `dsh-paper-tailor` 的现有研究状态、原生 Host 路由和工作台中增加科研基础能力。

## 已实现的闭环

| 能力 | 入口及行为 | 当前边界 |
|---|---|---|
| Protocol | 研究主页 / Research Cockpit 的 Research Foundations 面板；保存版本、人工冻结、保留修订原因和 SHA-256 | 支持 experiment / systematic_review；已有研究按需初始化，不迁移旧流程 |
| Evidence | paper/report/study 身份、DOI 去重、source 绑定、带定位的 Measurement | 数值必须来自原文或已登记计算；单位匹配用显式标识，不自动换算；语义支持需人审 |
| Literature | OpenAlex、Crossref、Europe PMC、Semantic Scholar 分页适配；保存查询及响应哈希 | 测试覆盖接口契约与 429；未进行四个线上服务的全量联调，全文访问另需许可 |
| Screening | 标题摘要 / 全文两阶段、排除标准、置信度、追加决策历史、冲突失效 | 最终 include/exclude 属于人工；ASReview 只建议排序 |
| CPU runtime | frozen protocol → baseline/candidate/ablation → 独立 evaluator → metrics/manifest/checkpoint | 真实执行固定合成线性回归模板；不能执行任意论文仓库 |
| Durable jobs | token、文件心跳、取消、重建 runtime 后收集、容器身份核对 | 恢复既有 job 状态；失联标记 interrupted，不自动从任意训练 checkpoint 续训 |
| Docker / SSH | digest 镜像、受限容器、Host 允许列表、GPU UUID、并发上限、产物回收 | 适配代码已实现；Docker daemon 不可用，且未配置远端主机，未实机验收 |
| Artifacts | 文件哈希校验；figure 的数据、代码、环境、spec、provenance、SVG/PNG/PDF | 图形版本作为独立 bundle 追加保存；尚无完整版本比较 UI |
| Citation / paper | 原文位置与字面数值检查、Crossref DOI 身份查询；固定 LaTeX 模板、BibTeX、图引用、PDF | 不声称判断因果或蕴含；模板报告，未实现完整协同 LaTeX 编辑器或自动同行评审 |
| Statistics | 固定 R/metafor worker；独立效应 GEN、FE/REML、LOO、forest、funnel、Egger | 需显式 SE/variance；拒绝重复 study；publication bias 要求至少 10 项独立研究；没有自动推导 effect size、多层模型或 subgroup UI |
| Review export | 决策 CSV/JSON、records/reports/studies 计数、PRISMA 模板、ROB2/ROBINS-I 表 | 内置 SVG 是计数摘要；正式 PRISMA2020 / robvis 需 R 依赖，不能据此宣称完整 PRISMA 合规 |
| Optional parsing / QA | GROBID TEI 和 PaperQA worker，均只读获准材料 | 需 Host 显式启用；未实机联调，不自动将解析或回答变成已验证证据 |

所有写入复用 `ResearchBootstrapStore` 的锁、revision CAS 和幂等 receipt。冻结、授权执行、最终筛选及 bias 判定从受信任的人类入口进入，Agent 不能在 payload 中伪造身份。材料被撤销后，依赖它的数值和已发布报告不再通过 API 返回；历史审计记录保留。

## 本地快速验收

要求 Node 24+、Python 3；图表需要 matplotlib；PDF 需要 XeLaTeX、latexmk。Windows 默认使用 `python`，其他平台使用 `python3`，Host 可通过 `runtime.python` 显式覆盖。不要将测试 workspace 指向正在使用的真实项目。

```bash
npm ci --ignore-scripts
npm run install:tools
npm run research:doctor -- --workspace /absolute/path/to/test-workspace
npm run research:demo -- --workspace /absolute/path/to/test-workspace
npm test
npm run typecheck
npm run build
npm run verify:licenses
```

`research:demo` 由操作者明确授权，创建一个独立研究，冻结固定协议，真实运行三种模型并生成图和报告；不联网训练、不伪造论文复现结果。全部产物保存于测试 workspace 的 `.dsh/research/foundation-assets`。命令返回 research/job/report 标识；可通过 `read` / `reconcile` / `cancel` 查询和管理。更多参数见 `scripts/research-foundations.mjs`。

SDK 测试依赖固定在 `tools/host-test/package-lock.json`，与仓库 SDK provenance 对齐；它们提供真实 SDK 模块用于服务测试，不等同于启动完整 DSH Host。实际 Host 安装沿用仓库原有流程。bundle patch 已登记 `evolver-research-foundations` 插件；工作台面板只显示当前注册 session 的研究。

## Host 配置

原生路由是 `/evolver/research-foundations`，动作在 `/actions`，注册产物经 `/artifacts` 下载。每次请求均校验 Host connection 和 session→workspace 映射，浏览器与 Agent 均不能提交任意磁盘路径或任意 shell 命令。

配置由 Host 操作者传给 `FoundationsHostConfig`；凭证放 Host 私有配置，勿写入研究状态或客户端。默认只启用固定 CPU 模板；外部执行必须显式选择并授权。示例结构：

```json
{
  "runtime": {
    "python": "python3",
    "docker": "docker",
    "hosts": [{
      "id": "lab-gpu",
      "target": "research@lab.example.org",
      "root": "/srv/dsh-research",
      "image": "registry.example.org/dsh-worker@sha256:<64位真实摘要>",
      "gpuDevices": ["GPU-<真实设备UUID>"],
      "maxConcurrentJobs": 1
    }]
  },
  "grobidEndpoint": "http://127.0.0.1:8070",
  "paperqaEnabled": false,
  "rscript": "Rscript",
  "latexmk": "latexmk"
}
```

示例摘要和主机是占位符，会被运行时拒绝；部署前替换为经验证的真实值。SSH 使用系统受信任 known_hosts、严格主机密钥校验；Host 提供认证，不向 Agent 透出私钥。容器镜像需要 Python 和该固定 profile 的依赖；只挂载 profile/input/output，不挂载整个研究 workspace。CPU portable backend 仅执行受信任的仓库固定脚本，不是隔离任意生成代码的 sandbox。

可选 `statisticsImage` 使用不可变 digest，包含 R/metafor；否则本地 `Rscript`。PRISMA/robvis 渲染需要本地 R 对应包。ASReview/PaperQA 的 Python 包及模型服务分别由操作者安装配置；缺失时报错，不使用替代结果。`workers/` 是适配层，不包含上游实现副本；上游具体部署版本仍需按调研提交和接口做兼容验收。

## 验收结果与外部 Gate

Windows 自动化验收覆盖三种 CPU 模型、独立评估、取消、重新实例化后的收集、产物篡改拒绝、figure bundle，以及服务、Host 权限和 JSDOM 交互。PDF 编译需要另行安装 XeLaTeX 与 latexmk；测试中的条件分支通过不表示本机执行过 PDF 编译。

真实 DSH Host 已验证插件启动、认证、路由挂载和 Foundations 的无会话/未认证拒绝。该检查不等于完整浏览器交互验收。

尚需部署环境完成：真实 DSH 页面端到端、Docker 容器、SSH/GPU 与断网恢复、R/metafor 数值参考验收、ASReview/PaperQA/GROBID 以及正式 PRISMA/robvis 联调。这些是开放验收项，不能将本分支称为完整自主科研或任意论文复现系统。
