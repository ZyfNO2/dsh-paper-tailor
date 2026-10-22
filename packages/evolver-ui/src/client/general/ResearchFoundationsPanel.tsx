import { useEffect, useState } from "react";
import type {
  FoundationState,
  ProtocolSpec,
  ArtifactFile,
} from "../../../../evolver/src/contracts/research-foundation-types.ts";

interface Snapshot {
  revision: number;
  researchId: string;
  foundations: FoundationState;
  currentProtocolHash: string | null;
  staleMeasurementIds: string[];
  availableSources: Array<{ sourceId: string; filename: string }>;
  prisma: Record<string, unknown> | null;
  capabilities: {
    python: { available: boolean };
    docker: { available: boolean };
    rscript: { available: boolean };
    remoteHosts: Array<{ id: string }>;
  };
}
interface SearchResult {
  hits: Array<{ title: string; doi: string | null; aliases: string[] }>;
  provider: string;
  query: string;
  responseHash: string;
}
const defaults: ProtocolSpec = {
  mode: "experiment",
  question: "",
  sources: [],
  inclusion: [],
  exclusion: [],
  outcomes: ["mse"],
  metric: "mse",
  unit: "squared_y",
  split: "test",
  direction: "minimize",
  maxAttempts: 3,
  timeoutSeconds: 30,
  maxOutputBytes: 1048576,
};
const css = `.rf{border:1px solid var(--rd-border,#d4dce3);border-radius:8px;margin:12px 0;background:var(--rd-panel,#fff);color:var(--rd-text,#233142);font-size:13px}.rf>summary{padding:12px;cursor:pointer;font-weight:600}.rf-content{padding:0 14px 14px}.rf-nav,.rf-actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.rf button,.rf input,.rf select,.rf textarea{font:inherit}.rf button{padding:6px 10px;border:1px solid #a9bac7;border-radius:5px;cursor:pointer;background:transparent;color:inherit}.rf button:disabled{opacity:.5;cursor:default}.rf button:focus-visible,.rf input:focus-visible,.rf textarea:focus-visible{outline:2px solid #3278ab;outline-offset:2px}.rf [aria-pressed=true]{background:#e3eef4;color:#174b6b}.rf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}.rf label{display:flex;flex-direction:column;gap:4px}.rf input,.rf select,.rf textarea{padding:7px;box-sizing:border-box;max-width:100%;border:1px solid #bbc8d2;border-radius:4px;background:var(--rd-bg,#fff);color:inherit}.rf textarea{width:100%;min-height:75px}.rf table{width:100%;border-collapse:collapse}.rf th,.rf td{padding:8px;text-align:left;border-bottom:1px solid #dce4ea;vertical-align:top}.rf-scroll{overflow:auto}.rf-error{color:#a52a2a}.rf-note{font-size:12px;opacity:.8}.rf pre{white-space:pre-wrap;word-break:break-word}.rf a{color:#286b92}`;

export function ResearchFoundationsPanel({
  sessionId,
  researchId,
}: {
  sessionId: string;
  researchId: string;
}): JSX.Element {
  const [open, setOpen] = useState(false),
    [tab, setTab] = useState("protocol"),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [draft, setDraft] = useState<ProtocolSpec>(defaults),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [variant, setVariant] = useState("baseline"),
    [backend, setBackend] = useState("portable_cpu"),
    [image, setImage] = useState(""),
    [hostId, setHostId] = useState("");
  const [provider, setProvider] = useState("crossref"),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState<SearchResult | null>(null),
    [reviewReason, setReviewReason] = useState(""),
    [criterion, setCriterion] = useState("");
  const [measurement, setMeasurement] = useState(""),
    [linkedReport, setLinkedReport] = useState(""),
    [linkedSource, setLinkedSource] = useState(""),
    [analysis, setAnalysis] = useState(""),
    [exports, setExports] = useState<
      Array<{ kind: string; key: string; files: ArtifactFile[] }>
    >([]);
  const endpoint = `/evolver/research-foundations?sessionId=${encodeURIComponent(sessionId)}&researchId=${encodeURIComponent(researchId)}`;
  const actionURL = `/evolver/research-foundations/actions?sessionId=${encodeURIComponent(sessionId)}&researchId=${encodeURIComponent(researchId)}`;
  const load = async () => {
    const r = await fetch(endpoint, { credentials: "same-origin" });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? "研究扩展读取失败");
    setSnapshot(data);
    return data as Snapshot;
  };
  useEffect(() => {
    setSnapshot(null);
    setExports([]);
    setSearch(null);
    setReason("");
    if (open)
      void load()
        .then((s) => setDraft(s.foundations.protocols.at(-1)?.spec ?? defaults))
        .catch((e) => setError(String(e)));
  }, [sessionId, researchId, open]);
  useEffect(() => {
    if (
      !open ||
      !snapshot?.foundations.jobs.some((j) => j.status === "running")
    )
      return;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void (async () => {
        for (const j of snapshot.foundations.jobs.filter(
          (j) => j.status === "running",
        ))
          await post({ action: "reconcile_job", jobId: j.jobId });
        await load();
      })()
        .catch((e) => setError(String(e)))
        .finally(() => {
          pending = false;
        });
    }, 2500);
    return () => clearInterval(timer);
  }, [
    open,
    snapshot?.foundations.jobs.map((j) => `${j.jobId}:${j.status}`).join(","),
  ]);
  const post = async (value: Record<string, unknown>) => {
    const r = await fetch(actionURL, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    const data = await r.json();
    if (!r.ok || data.ok === false)
      throw new Error(data.error ?? data.reason ?? "动作失败");
    return data.result;
  };
  const command = async (action: string, payload: unknown) => {
    const s = await load();
    return post({
      action,
      payload,
      baseRevision: s.revision,
      operationId: `foundation-ui-${crypto.randomUUID()}`,
    });
  };
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
      setNotice("已收到 Host 回执。");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const f = snapshot?.foundations,
    p = f?.protocols
      .slice()
      .reverse()
      .find((p) => p.status === "frozen");
  const link = (kind: string, key: string, file: ArtifactFile) =>
    `/evolver/research-foundations/artifacts?${new URLSearchParams({ sessionId, researchId, kind, key, name: file.name, sha256: file.sha256 })}`;
  const showFiles = (kind: string, key: string, files: ArtifactFile[]) =>
    setExports((old) => [
      ...old.filter((x) => x.key !== key),
      { kind, key, files },
    ]);
  const save = (status: "draft" | "frozen") =>
    perform(async () => {
      await command("save_protocol", {
        protocolId: "main",
        status,
        reason,
        spec: draft,
      });
      setReason("");
    });
  const run = () =>
    perform(async () => {
      if (!p) throw new Error("请先冻结实验协议");
      const receipt = await command("create_job", {
        backend,
        profile: "linear-regression-v1",
        variant,
        seed: 20261022,
        image: backend === "portable_cpu" ? null : image,
        hostId: backend === "ssh_docker" ? hostId : null,
        protocolHash: p.hash,
      });
      await post({
        action: "submit_job",
        jobId: receipt.result.jobId,
        authorize: true,
      });
    });
  const decide = (
    reportId: string,
    stage: "title_abstract" | "full_text",
    decision: string,
  ) =>
    perform(async () => {
      if (!p) throw new Error("请先冻结综述协议");
      const previous = f?.decisions
        .slice()
        .reverse()
        .find(
          (d) =>
            d.reportId === reportId &&
            d.stage === stage &&
            d.protocolHash === p.hash,
        );
      await command("screen", {
        reportId,
        protocolHash: p.hash,
        stage,
        decision,
        reason: reviewReason,
        criterion: decision === "exclude" ? criterion : "人工核查纳入条件",
        confidence: null,
        supersedes: previous?.decisionId ?? null,
      });
    });
  return (
    <details
      className="rf"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <style>{css}</style>
      <summary>研究协议 · 证据表 · 执行与综述</summary>
      <div className="rf-content">
        <div className="rf-nav">
          {[
            ["protocol", "研究协议"],
            ["execution", "实验运行"],
            ["evidence", "文献与数值"],
            ["review", "系统综述"],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
          <button disabled={busy} onClick={() => void perform(load)}>
            刷新
          </button>
        </div>
        {error && (
          <p role="alert" className="rf-error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {!snapshot ? (
          <p>打开后读取当前研究状态。</p>
        ) : (
          <>
            <p className="rf-note">
              协议 {p ? `v${p.version} · ${p.hash.slice(0, 12)}` : "尚未冻结"} ·{" "}
              {f?.measurements.length ?? 0} 条数值证据 ·{" "}
              {snapshot.staleMeasurementIds.length}{" "}
              条绑定旧协议。定位核验与科学结论复核分别记录。
            </p>
            {tab === "protocol" && (
              <>
                <div className="rf-grid">
                  <label>
                    研究模式
                    <select
                      value={draft.mode}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          mode: e.target.value as ProtocolSpec["mode"],
                        })
                      }
                    >
                      <option value="experiment">实验研究</option>
                      <option value="systematic_review">系统综述</option>
                    </select>
                  </label>
                  <label>
                    研究问题
                    <input
                      value={draft.question}
                      onChange={(e) =>
                        setDraft({ ...draft, question: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    每项结果一行
                    <textarea
                      value={draft.outcomes.join("\n")}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          outcomes: e.target.value.split("\n").filter(Boolean),
                        })
                      }
                    />
                  </label>
                </div>
                {draft.mode === "systematic_review" && (
                  <div className="rf-grid">
                    {(["sources", "inclusion", "exclusion"] as const).map(
                      (key, i) => (
                        <label key={key}>
                          {
                            [
                              "数据库 / 检索范围，每行一项",
                              "纳入标准，每行一项",
                              "排除标准，每行一项",
                            ][i]
                          }
                          <textarea
                            value={draft[key].join("\n")}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                [key]: e.target.value
                                  .split("\n")
                                  .filter(Boolean),
                              })
                            }
                          />
                        </label>
                      ),
                    )}
                  </div>
                )}
                <div className="rf-grid">
                  {(["metric", "unit", "split"] as const).map((key) => (
                    <label key={key}>
                      {key === "metric"
                        ? "主要指标"
                        : key === "unit"
                          ? "单位"
                          : "数据划分"}
                      <input
                        value={draft[key]}
                        onChange={(e) =>
                          setDraft({ ...draft, [key]: e.target.value })
                        }
                      />
                    </label>
                  ))}
                  <label>
                    方向
                    <select
                      value={draft.direction}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          direction: e.target
                            .value as ProtocolSpec["direction"],
                        })
                      }
                    >
                      <option value="minimize">越小越好</option>
                      <option value="maximize">越大越好</option>
                    </select>
                  </label>
                  <label>
                    最多运行次数
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={draft.maxAttempts}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          maxAttempts: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    每次超时（秒）
                    <input
                      type="number"
                      min="1"
                      max="86400"
                      value={draft.timeoutSeconds}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          timeoutSeconds: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>
                <label>
                  本次变更理由
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <div className="rf-actions">
                  <button
                    disabled={busy || !reason.trim()}
                    onClick={() => void save("draft")}
                  >
                    保存草案
                  </button>
                  <button
                    disabled={busy || !reason.trim()}
                    onClick={() => void save("frozen")}
                  >
                    确认并冻结新版本
                  </button>
                </div>
                <p className="rf-note">
                  冻结协议不会自动启动计算。旧运行继续保留原协议身份。
                </p>
              </>
            )}
            {tab === "execution" && (
              <>
                <p>
                  当前可运行模板：合成线性回归验收，包含
                  baseline、拟合模型与去掉截距的消融；不代表论文复现。
                </p>
                <div className="rf-grid">
                  <label>
                    运行方案
                    <select
                      value={variant}
                      onChange={(e) => setVariant(e.target.value)}
                    >
                      <option value="baseline">Baseline</option>
                      <option value="candidate">拟合模型</option>
                      <option value="ablation">消融：去掉截距</option>
                    </select>
                  </label>
                  <label>
                    执行位置
                    <select
                      value={backend}
                      onChange={(e) => setBackend(e.target.value)}
                    >
                      <option value="portable_cpu">本机受信 CPU 模板</option>
                      <option
                        value="docker"
                        disabled={!snapshot.capabilities.docker.available}
                      >
                        本机 Docker
                      </option>
                      <option
                        value="ssh_docker"
                        disabled={!snapshot.capabilities.remoteHosts.length}
                      >
                        远端 Docker
                      </option>
                    </select>
                  </label>
                  {backend !== "portable_cpu" && (
                    <label>
                      镜像 digest
                      <input
                        placeholder="python@sha256:..."
                        value={image}
                        onChange={(e) => setImage(e.target.value)}
                      />
                    </label>
                  )}
                  {backend === "ssh_docker" && (
                    <label>
                      已配置的远端
                      <select
                        value={hostId}
                        onChange={(e) => setHostId(e.target.value)}
                      >
                        <option value="">选择主机</option>
                        {snapshot.capabilities.remoteHosts.map((h) => (
                          <option key={h.id}>{h.id}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <div className="rf-actions">
                  <button
                    disabled={busy || p?.spec.mode !== "experiment"}
                    onClick={() => void run()}
                  >
                    授权并运行一次
                  </button>
                  <button
                    disabled={busy || !p}
                    onClick={() =>
                      void perform(async () => {
                        const r = await post({
                          action: "compile_report",
                          authorize: true,
                        });
                        showFiles("reports", r.reportId, r.files);
                      })
                    }
                  >
                    编译证据报告
                  </button>
                </div>
                <div className="rf-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>方案 / 状态</th>
                        <th>指标</th>
                        <th>操作与产物</th>
                      </tr>
                    </thead>
                    <tbody>
                      {f?.jobs.map((j) => (
                        <tr key={j.jobId}>
                          <td>
                            {j.spec.variant} · {j.status}
                            <br />
                            <small>{j.jobId}</small>
                            {j.error && <p className="rf-error">{j.error}</p>}
                          </td>
                          <td>
                            {j.metrics
                              ? Object.entries(j.metrics).map(([k, v]) => (
                                  <div key={k}>
                                    {k}: {v}
                                  </div>
                                ))
                              : "尚无完成指标"}
                          </td>
                          <td>
                            {["queued", "running"].includes(j.status) && (
                              <>
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    void perform(() =>
                                      post({
                                        action: "reconcile_job",
                                        jobId: j.jobId,
                                      }),
                                    )
                                  }
                                >
                                  核对运行
                                </button>
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    void perform(() =>
                                      post({
                                        action: "cancel_job",
                                        jobId: j.jobId,
                                        authorize: true,
                                      }),
                                    )
                                  }
                                >
                                  停止
                                </button>
                              </>
                            )}
                            {j.status === "succeeded" && (
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void perform(async () => {
                                    const r = await post({
                                      action: "generate_figure",
                                      jobId: j.jobId,
                                      parentId: null,
                                      authorize: true,
                                    });
                                    showFiles("figures", r.figureId, r.files);
                                  })
                                }
                              >
                                重建图表
                              </button>
                            )}
                            <details>
                              <summary>运行资产</summary>
                              {j.artifacts.map((a) => (
                                <div key={a.name}>
                                  <a download href={link("jobs", j.jobId, a)}>
                                    {a.name}
                                  </a>
                                </div>
                              ))}
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {tab === "evidence" && (
              <>
                <div className="rf-grid">
                  <label>
                    检索来源
                    <select
                      value={provider}
                      onChange={(e) => setProvider(e.target.value)}
                    >
                      {[
                        "crossref",
                        "openalex",
                        "europepmc",
                        "semantic_scholar",
                      ].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    检索式
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                </div>
                <button
                  disabled={busy || !query.trim()}
                  onClick={() =>
                    void perform(async () =>
                      setSearch(
                        await post({
                          action: "search_literature",
                          provider,
                          query,
                          page: "*",
                        }),
                      ),
                    )
                  }
                >
                  检索并保存快照
                </button>
                {search?.hits.map((h, i) => (
                  <p key={i}>
                    {h.title} {h.doi ?? "DOI 未知"}{" "}
                    <button
                      disabled={busy}
                      onClick={() =>
                        void perform(() =>
                          command("register_paper", {
                            title: h.title,
                            doi: h.doi,
                            aliases: h.aliases,
                            studyId: null,
                            provider: search.provider,
                            query: search.query,
                            responseHash: search.responseHash,
                          }),
                        )
                      }
                    >
                      加入文献表
                    </button>
                  </p>
                ))}
                <div className="rf-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>结果 / 数值</th>
                        <th>来源与条件</th>
                        <th>核验边界</th>
                      </tr>
                    </thead>
                    <tbody>
                      {f?.measurements.map((m) => (
                        <tr key={m.measurementId}>
                          <td>
                            {m.outcome}: {m.value} {m.unit}
                            <br />
                            n={m.n ?? "未知"} · {m.nMeaning}
                          </td>
                          <td>
                            {m.reportId}
                            <br />
                            {m.split} · {m.method}
                            <details>
                              <summary>原文位置</summary>
                              <pre>{JSON.stringify(m.locator, null, 2)}</pre>
                            </details>
                          </td>
                          <td>
                            {m.protocolHash === p?.hash ? "当前协议" : "旧协议"}
                            <br />
                            原文定位已核对，语义支持度待复核
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="rf-grid">
                  <label>
                    关联文献
                    <select
                      value={linkedReport}
                      onChange={(e) => setLinkedReport(e.target.value)}
                    >
                      <option value="">选择文献报告</option>
                      {f?.papers.map((p) => (
                        <option key={p.reportId} value={p.reportId}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    对应的已导入来源
                    <select
                      value={linkedSource}
                      onChange={(e) => setLinkedSource(e.target.value)}
                    >
                      <option value="">选择原始来源</option>
                      {snapshot.availableSources.map((s) => (
                        <option key={s.sourceId} value={s.sourceId}>
                          {s.filename}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button
                  disabled={busy || !linkedReport || !linkedSource}
                  onClick={() =>
                    void perform(() =>
                      command("link_report_sources", {
                        reportId: linkedReport,
                        sourceIds: [
                          ...new Set([
                            ...(f?.papers.find(
                              (p) => p.reportId === linkedReport,
                            )?.sourceIds ?? []),
                            linkedSource,
                          ]),
                        ],
                      }),
                    )
                  }
                >
                  确认文献与来源关联
                </button>
                <details>
                  <summary>登记结构化数值（高级）</summary>
                  <p className="rf-note">
                    先在资料区导入来源；提交
                    reportId、protocolHash、outcome、value、unit、n、nMeaning、uncertainty、split、method、timepoint
                    和原始 locator。Agent 可使用对应工具准备，Host
                    会核对实际原文。
                  </p>
                  <textarea
                    aria-label="Measurement JSON"
                    value={measurement}
                    onChange={(e) => setMeasurement(e.target.value)}
                  />
                  <button
                    disabled={busy || !measurement.trim()}
                    onClick={() =>
                      void perform(() =>
                        command("record_measurement", JSON.parse(measurement)),
                      )
                    }
                  >
                    核对来源并登记
                  </button>
                </details>
              </>
            )}
            {tab === "review" && (
              <>
                <p>
                  先完成标题摘要筛选，再记录全文纳入、排除或等待获取。模型排序不会自动决定纳入。
                </p>
                <div className="rf-grid">
                  <label>
                    本次人工判定理由
                    <input
                      value={reviewReason}
                      onChange={(e) => setReviewReason(e.target.value)}
                    />
                  </label>
                  <label>
                    排除时对应条款
                    <select
                      value={criterion}
                      onChange={(e) => setCriterion(e.target.value)}
                    >
                      <option value="">选择冻结协议条款</option>
                      {p?.spec.exclusion.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="rf-actions">
                  <button
                    disabled={busy || p?.spec.mode !== "systematic_review"}
                    onClick={() =>
                      void perform(async () => {
                        const r = await post({
                          action: "export_review",
                          authorize: true,
                        });
                        showFiles("reviews", r.reviewId, r.files);
                      })
                    }
                  >
                    导出筛选历史与流程计数
                  </button>
                  <button
                    disabled={busy || p?.spec.mode !== "systematic_review"}
                    onClick={() =>
                      void perform(async () =>
                        setNotice(
                          JSON.stringify(
                            await post({
                              action: "rank_screening",
                              authorize: true,
                            }),
                          ),
                        ),
                      )
                    }
                  >
                    ASReview 辅助排序
                  </button>
                </div>
                {snapshot.prisma && (
                  <pre>{JSON.stringify(snapshot.prisma, null, 2)}</pre>
                )}
                <div className="rf-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>文献</th>
                        <th>阶段与判定</th>
                        <th>人工操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {f?.papers.map((paper) => {
                        const first = f.decisions
                            .slice()
                            .reverse()
                            .find(
                              (d) =>
                                d.reportId === paper.reportId &&
                                d.stage === "title_abstract" &&
                                d.protocolHash === p?.hash,
                            ),
                          full = f.decisions
                            .slice()
                            .reverse()
                            .find(
                              (d) =>
                                d.reportId === paper.reportId &&
                                d.stage === "full_text" &&
                                d.protocolHash === p?.hash,
                            );
                        const stage =
                          first?.decision === "include"
                            ? "full_text"
                            : "title_abstract";
                        return (
                          <tr key={paper.reportId}>
                            <td>
                              {paper.title}
                              <br />
                              {paper.doi ?? paper.reportId}
                            </td>
                            <td>
                              标题摘要：{first?.decision ?? "未筛选"}
                              <br />
                              全文：{full?.decision ?? "未筛选"}
                            </td>
                            <td>
                              <button
                                disabled={busy || !reviewReason.trim()}
                                onClick={() =>
                                  void decide(paper.reportId, stage, "include")
                                }
                              >
                                {stage === "full_text"
                                  ? "全文纳入"
                                  : "进入全文筛选"}
                              </button>
                              <button
                                disabled={
                                  busy || !criterion || !reviewReason.trim()
                                }
                                onClick={() =>
                                  void decide(paper.reportId, stage, "exclude")
                                }
                              >
                                按条款排除
                              </button>
                              {stage === "full_text" && (
                                <button
                                  disabled={busy || !reviewReason.trim()}
                                  onClick={() =>
                                    void decide(
                                      paper.reportId,
                                      stage,
                                      "awaiting",
                                    )
                                  }
                                >
                                  等待全文
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <details>
                  <summary>Meta-analysis 计划（高级）</summary>
                  <p>
                    当前 worker 支持独立研究的通用逆方差 FE / REML；需要明确的
                    SE 或方差。R/metafor 可用：
                    {snapshot.capabilities.rscript.available
                      ? "是"
                      : "否，执行时会报告缺失环境"}
                    。
                  </p>
                  <textarea
                    aria-label="AnalysisSpec JSON"
                    value={analysis}
                    onChange={(e) => setAnalysis(e.target.value)}
                  />
                  <button
                    disabled={busy || !analysis.trim()}
                    onClick={() =>
                      void perform(async () => {
                        const r = await post({
                          action: "analyze",
                          spec: JSON.parse(analysis),
                          authorize: true,
                        });
                        showFiles("analyses", r.analysisId, r.files);
                      })
                    }
                  >
                    授权并执行统计
                  </button>
                </details>
              </>
            )}
            {(exports.length > 0 ||
              !!f?.figures.length ||
              !!f?.analyses.length ||
              !!f?.publications.length) && (
              <details>
                <summary>已生成的图表与报告</summary>
                {[
                  ...exports,
                  ...(f?.figures ?? [])
                    .filter((x) => !exports.some((y) => y.key === x.figureId))
                    .map((x) => ({
                      kind: "figures",
                      key: x.figureId,
                      files: x.files,
                    })),
                  ...(f?.analyses ?? [])
                    .filter((x) => !exports.some((y) => y.key === x.analysisId))
                    .map((x) => ({
                      kind: "analyses",
                      key: x.analysisId,
                      files: x.files,
                    })),
                  ...(f?.publications ?? [])
                    .filter((x) => !exports.some((y) => y.key === x.artifactId))
                    .map((x) => ({
                      kind: x.kind,
                      key: x.artifactId,
                      files: x.files,
                    })),
                ].map((bundle) => (
                  <div key={bundle.key}>
                    <strong>{bundle.key}</strong>
                    {bundle.files.map((file) => (
                      <div key={file.name}>
                        <a download href={link(bundle.kind, bundle.key, file)}>
                          {file.name}
                        </a>
                      </div>
                    ))}
                  </div>
                ))}
              </details>
            )}
          </>
        )}
      </div>
    </details>
  );
}
