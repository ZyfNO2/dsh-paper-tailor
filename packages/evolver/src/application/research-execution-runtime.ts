import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  ResearchFoundationsService,
  currentProtocol,
} from "./research-foundations-service.ts";
import {
  digest,
  id,
  finite,
  sha,
  type ArtifactFile,
  type ResearchJob,
} from "../contracts/research-foundations.ts";

export interface RemoteResearchHost {
  id: string;
  target: string;
  root: string;
  image: string;
  gpuDevices?: string[];
  maxConcurrentJobs: number;
}
export interface RuntimeOptions {
  python?: string;
  docker?: string;
  ssh?: string;
  scp?: string;
  hosts?: RemoteResearchHost[];
  profileRoot?: string;
}
export const fileHash = (p: string) =>
  createHash("sha256").update(fs.readFileSync(p)).digest("hex");
export function writeAtomic(p: string, value: unknown): void {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { flag: "wx" });
  fs.renameSync(tmp, p);
}
export function checkedDirectory(root: string, relative: string): string {
  const base = fs.realpathSync(root),
    target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("Path escapes workspace");
  let current = base;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      if (
        fs.lstatSync(current).isSymbolicLink() ||
        !fs.statSync(current).isDirectory()
      )
        throw new Error("Asset directory cannot be a symlink/file");
    } else fs.mkdirSync(current);
  }
  return target;
}
export function filesAt(root: string, maxBytes = 1073741824): ArtifactFile[] {
  let total = 0;
  return fs
    .readdirSync(root)
    .filter((n) => !n.endsWith(".tmp") && n !== "submit.lock")
    .sort()
    .map((name) => {
      if (!/^[\w.-]+$/.test(name)) throw new Error("Unsafe artifact name");
      const p = path.join(root, name),
        s = fs.lstatSync(p);
      if (!s.isFile() || s.isSymbolicLink())
        throw new Error("Artifact must be a regular file");
      total += s.size;
      if (total > maxBytes) throw new Error("Artifact quota exceeded");
      return { name, sha256: fileHash(p), bytes: s.size };
    });
}
export function processStart(pid: number): string | null {
  try {
    return fs
      .readFileSync(`/proc/${pid}/stat`, "utf8")
      .split(") ")[1]
      .split(" ")[19];
  } catch {
    return null;
  }
}
const terminal = (j: ResearchJob) =>
  ["succeeded", "failed", "cancelled", "interrupted"].includes(j.status);
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** Trusted profile execution; commands, mounts and hosts are never accepted from Agent payloads. */
export class ResearchExecutionRuntime {
  readonly options: RuntimeOptions;
  readonly profileRoot: string;
  readonly service: ResearchFoundationsService;
  constructor(
    service: ResearchFoundationsService,
    options: RuntimeOptions = {},
  ) {
    this.service = service;
    this.options = options;
    this.profileRoot =
      options.profileRoot ??
      fileURLToPath(
        new URL(
          "../../../../fixtures/portable-regression-v1/",
          import.meta.url,
        ),
      );
  }
  private exec(command: string, args: string[], timeout = 30000): string {
    const r = spawnSync(command, args, {
      encoding: "utf8",
      timeout,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (r.error || r.status !== 0)
      throw new Error(
        `${path.basename(command)} failed: ${r.error?.message ?? r.stderr.slice(-1500)}`,
      );
    return r.stdout.trim();
  }
  doctor() {
    const probe = (command: string, args: string[]) => {
      try {
        return {
          available: true,
          detail: this.exec(command, args, 5000).slice(0, 300),
        };
      } catch (e) {
        return { available: false, detail: String(e).slice(0, 300) };
      }
    };
    return {
      python: probe(this.options.python ?? (process.platform === "win32" ? "python" : "python3"), ["--version"]),
      docker: probe(this.options.docker ?? "docker", [
        "info",
        "--format",
        "{{json .ServerVersion}}",
      ]),
      rscript: probe("Rscript", ["--version"]),
      latexmk: probe("latexmk", ["-v"]),
      ssh: probe(this.options.ssh ?? "ssh", ["-V"]),
      portableProfile: {
        available: ["data.csv", "runner.py", "evaluate.py", "worker.py"].every(
          (n) => fs.existsSync(path.join(this.profileRoot, n)),
        ),
        nature: "synthetic",
      },
      legacyProfile: {
        available: false,
        reason:
          "Historical phase2-cpu-seg-v1 needs external runner, weights and dataset; no implicit fallback",
      },
      remoteHosts: (this.options.hosts ?? []).map((h) => ({
        id: h.id,
        maxConcurrentJobs: h.maxConcurrentJobs,
        gpuDevices: h.gpuDevices ?? [],
      })),
    };
  }
  job(researchId: string, jobId: string): ResearchJob {
    const j = this.service
      .snapshot(researchId)
      .foundations.jobs.find((j) => j.jobId === id(jobId));
    if (!j) throw new Error("Unknown research job");
    return j;
  }
  jobRoot(researchId: string, jobId: string) {
    return checkedDirectory(
      this.service.store.workspaceRoot,
      path.join(
        ".dsh",
        "research",
        "foundation-assets",
        id(researchId),
        id(jobId),
      ),
    );
  }
  private host(j: ResearchJob): RemoteResearchHost {
    const h = this.options.hosts?.find((h) => h.id === j.spec.hostId);
    if (
      !h ||
      !/^[\w.-]+(?:@[\w.-]+)?$/.test(h.target) ||
      !/^\/[\w/.-]+$/.test(h.root) ||
      h.root.split("/").includes("..") ||
      h.image !== j.spec.image ||
      !Number.isInteger(h.maxConcurrentJobs) ||
      h.maxConcurrentJobs < 1
    )
      throw new Error("Unconfigured or invalid trusted SSH host/image");
    if (h.gpuDevices?.some((x) => !/^GPU-[a-fA-F0-9-]+$/.test(x)))
      throw new Error("Invalid host-owned GPU allocation");
    return h;
  }
  private remote(h: RemoteResearchHost, args: string[]): string {
    return this.exec(
      this.options.ssh ?? "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "--",
        h.target,
        args.map(quote).join(" "),
      ],
      60000,
    );
  }
  private docker(j: ResearchJob, args: string[]): string {
    return j.spec.backend === "ssh_docker"
      ? this.remote(this.host(j), ["docker", ...args])
      : this.exec(this.options.docker ?? "docker", args);
  }
  private inspect(j: ResearchJob): {
    running: boolean;
    status: string;
    exitCode: number;
    inputHash: string;
  } | null {
    try {
      const rows = JSON.parse(this.docker(j, ["inspect", `dsh-${j.token}`]));
      const c = rows[0];
      if (
        c.Config?.Labels?.["dsh.spec"] !== j.specHash ||
        c.Config?.Labels?.["dsh.token"] !== j.token
      )
        throw new Error("Container identity mismatch");
      return {
        running: c.State.Running,
        status: c.State.Status,
        exitCode: c.State.ExitCode,
        inputHash: c.Config.Labels["dsh.input"],
      };
    } catch (e) {
      if (/No such (object|container)/i.test(String(e))) return null;
      throw e;
    }
  }
  submit(researchId: string, jobId: string) {
    let j = this.job(researchId, jobId);
    if (terminal(j)) return this.reconcile(researchId, jobId);
    if (j.status === "running") return this.reconcile(researchId, jobId);
    const p = currentProtocol(this.service.snapshot(researchId).foundations);
    if (!p || p.hash !== j.spec.protocolHash)
      throw new Error(
        "Execution protocol changed; create a newly authorized job",
      );
    const root = this.jobRoot(researchId, jobId),
      lock = path.join(root, "submit.lock");
    if (fs.existsSync(lock)) return this.reconcile(researchId, jobId);
    fs.writeFileSync(lock, j.token, { flag: "wx" });
    try {
      const profileHashes = Object.fromEntries(
        ["data.csv", "runner.py", "evaluate.py", "worker.py"].map((n) => [
          n,
          fileHash(path.join(this.profileRoot, n)),
        ]),
      );
      const identity = {
        jobId: j.jobId,
        token: j.token,
        spec: j.spec,
        specHash: j.specHash,
        profileHashes,
        timeoutSeconds: p.spec.timeoutSeconds,
        maxOutputBytes: p.spec.maxOutputBytes,
      };
      const inputHash = digest(identity);
      writeAtomic(path.join(root, "input.json"), { ...identity, inputHash });
      if (j.spec.backend === "portable_cpu") {
        this.exec(this.options.python ?? (process.platform === "win32" ? "python" : "python3"), ["--version"], 5000);
        const log = fs.openSync(path.join(root, "supervisor.log"), "a");
        const child = spawn(
          this.options.python ?? (process.platform === "win32" ? "python" : "python3"),
          [
            path.join(this.profileRoot, "worker.py"),
            path.join(root, "input.json"),
          ],
          {
            // A short-lived CLI must not own the durable supervisor lifetime.
            // windowsHide keeps the detached Windows worker non-interactive.
            detached: true,
            stdio: ["ignore", log, log],
            windowsHide: true,
          },
        );
        fs.closeSync(log);
        child.once("error", (error) => {
          try {
            fs.appendFileSync(path.join(root, "supervisor.log"), `Spawn failure: ${error.stack ?? String(error)}\n`);
            if (!terminal(this.job(researchId, jobId)))
              this.service.updateJob(researchId, jobId, `spawn-error-${j.token}`, (job) => { job.status = "failed"; job.error = String(error); });
          } catch (recordError) {
            throw new AggregateError([error, recordError], "Portable worker spawn failed and failure recording failed");
          }
        });
        child.unref();
        if (!child.pid) throw new Error(`Failed to launch portable worker; inspect ${path.join(root, "supervisor.log")}`);
        const pid = child.pid,
          start = processStart(pid);
        this.service.updateJob(
          researchId,
          jobId,
          `launch-${j.token}`,
          (job) => {
            job.status = "running";
            job.pid = pid;
            job.processStart = start;
            job.externalId = `pid-${pid}`;
          },
        );
      } else {
        if (j.spec.backend === "ssh_docker") {
          const h = this.host(j);
          this.service.updateJob(
            researchId,
            jobId,
            `reserve-${j.token}`,
            (job, c) => {
              if (
                c.state.researches
                  .flatMap((r) => r.foundations?.jobs ?? [])
                  .filter(
                    (x) =>
                      x.jobId !== jobId &&
                      x.spec.hostId === h.id &&
                      x.status === "running",
                  ).length >= h.maxConcurrentJobs
              )
                throw new Error("Remote host concurrency limit reached");
              job.status = "running";
            },
          );
          this.remote(h, [
            "mkdir",
            "-p",
            `${h.root}/${j.token}/profile`,
            `${h.root}/${j.token}/output`,
          ]);
          const options = ["-B", "-o", "StrictHostKeyChecking=yes"];
          for (const name of Object.keys(profileHashes))
            this.exec(this.options.scp ?? "scp", [
              ...options,
              "--",
              path.join(this.profileRoot, name),
              `${h.target}:${h.root}/${j.token}/profile/${name}`,
            ]);
          this.exec(this.options.scp ?? "scp", [
            ...options,
            "--",
            path.join(root, "input.json"),
            `${h.target}:${h.root}/${j.token}/output/input.json`,
          ]);
        }
        const profile =
            j.spec.backend === "ssh_docker"
              ? `${this.host(j).root}/${j.token}/profile`
              : this.profileRoot,
          output =
            j.spec.backend === "ssh_docker"
              ? `${this.host(j).root}/${j.token}/output`
              : root;
        const args = [
          "create",
          "--name",
          `dsh-${j.token}`,
          "--label",
          `dsh.spec=${j.specHash}`,
          "--label",
          `dsh.token=${j.token}`,
          "--label",
          `dsh.input=${inputHash}`,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "64",
          "--memory",
          "256m",
          "--cpus",
          "1",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=32m",
          "--env",
          "PYTHONDONTWRITEBYTECODE=1",
          "--mount",
          `type=bind,src=${profile},dst=/profile,readonly`,
          "--mount",
          `type=bind,src=${output},dst=/output`,
        ];
        if (j.spec.backend === "ssh_docker" && this.host(j).gpuDevices?.length)
          args.push("--gpus", `device=${this.host(j).gpuDevices!.join(",")}`);
        const existing = this.inspect(j);
        if (!existing)
          this.docker(j, [
            ...args,
            j.spec.image!,
            "python",
            "/profile/worker.py",
            "/output/input.json",
          ]);
        this.service.updateJob(
          researchId,
          jobId,
          `launch-${j.token}`,
          (job) => {
            job.status = "running";
            job.externalId = `dsh-${j.token}`;
          },
        );
        if (!existing?.running) this.docker(j, ["start", `dsh-${j.token}`]);
      }
      return this.reconcile(researchId, jobId);
    } catch (e) {
      j = this.job(researchId, jobId);
      if (!terminal(j))
        this.service.updateJob(
          researchId,
          jobId,
          `launch-failed-${j.token}`,
          (job) => {
            job.status = "failed";
            job.error = String(e);
          },
        );
      throw e;
    }
  }
  reconcile(researchId: string, jobId: string) {
    let j = this.job(researchId, jobId);
    if (terminal(j)) return j;
    const root = this.jobRoot(researchId, jobId),
      completion = path.join(root, "completion.json");
    if (j.spec.backend === "ssh_docker" && !fs.existsSync(completion)) {
      const h = this.host(j),
        state = this.inspect(j);
      if (state && !state.running && state.status !== "created")
        for (const name of [
          "completion.json",
          "metrics.json",
          "stdout.log",
          "stderr.log",
        ]) {
          try {
            this.exec(this.options.scp ?? "scp", [
              "-B",
              "-o",
              "StrictHostKeyChecking=yes",
              "--",
              `${h.target}:${h.root}/${j.token}/output/${name}`,
              path.join(root, name),
            ]);
          } catch (e) {
            if (name === "completion.json") throw e;
          }
        }
    }
    if (fs.existsSync(completion)) {
      const artifact = fs.lstatSync(completion);
      if (
        !artifact.isFile() ||
        artifact.isSymbolicLink() ||
        artifact.size > 65536
      )
        throw new Error("Invalid completion artifact");
      const c = JSON.parse(fs.readFileSync(completion, "utf8")),
        input = JSON.parse(
          fs.readFileSync(path.join(root, "input.json"), "utf8"),
        );
      const { inputHash, ...identity } = input;
      if (
        digest(identity) !== inputHash ||
        c.jobId !== j.jobId ||
        c.token !== j.token ||
        c.inputHash !== inputHash ||
        input.specHash !== j.specHash ||
        digest(input.spec) !== j.specHash
      )
        throw new Error("Completion identity mismatch");
      if (!["succeeded", "failed", "cancelled"].includes(c.status))
        throw new Error("Invalid completion state");
      let metrics: Record<string, number> | null = null;
      if (c.status === "succeeded") {
        const measured = JSON.parse(
          fs.readFileSync(path.join(root, "metrics.json"), "utf8"),
        );
        if (
          measured.jobId !== j.jobId ||
          measured.token !== j.token ||
          measured.inputHash !== inputHash ||
          digest(measured.metrics) !== digest(c.metrics)
        )
          throw new Error("Measured artifact identity mismatch");
        if (
          !c.metrics ||
          !Object.keys(c.metrics).length ||
          Object.keys(c.metrics).length > 50
        )
          throw new Error("Missing measured metrics");
        metrics = Object.fromEntries(
          Object.entries(c.metrics).map(([k, v]) => [k, finite(v)]),
        );
      }
      const artifacts = filesAt(root, input.maxOutputBytes);
      this.service.updateJob(researchId, jobId, `collect-${j.token}`, (job) => {
        job.status = c.status;
        job.error = c.error ?? null;
        job.metrics = metrics;
        job.artifacts = artifacts;
      });
    } else if (j.spec.backend === "portable_cpu") {
      if (j.pid === null && fs.existsSync(path.join(root, "launch.json"))) {
        const launch = JSON.parse(
          fs.readFileSync(path.join(root, "launch.json"), "utf8"),
        );
        if (launch.token !== j.token) throw new Error("Launch token mismatch");
        this.service.updateJob(
          researchId,
          jobId,
          `reattach-${j.token}`,
          (job) => {
            job.status = "running";
            job.pid = launch.pid;
            job.processStart = launch.processStart;
            job.externalId = `pid-${launch.pid}`;
          },
        );
        j = this.job(researchId, jobId);
      }
      const inputFile = path.join(root, "input.json"),
        heartbeatFile = path.join(root, "heartbeat.json");
      if (fs.existsSync(inputFile)) {
        const input = JSON.parse(fs.readFileSync(inputFile, "utf8"));
        let last = Date.parse(j.updatedAt) / 1000;
        if (fs.existsSync(heartbeatFile)) {
          const h = JSON.parse(fs.readFileSync(heartbeatFile, "utf8"));
          if (h.token !== j.token)
            throw new Error("Heartbeat identity mismatch");
          last = h.updatedAt;
        }
        if (Date.now() / 1000 - last > input.timeoutSeconds + 10)
          this.service.updateJob(
            researchId,
            jobId,
            `interrupt-${j.token}`,
            (job) => {
              job.status = "interrupted";
              job.error =
                "Worker heartbeat expired without a completion record; explicit new attempt required";
            },
          );
      }
    } else {
      const s = this.inspect(j);
      if (s?.status === "created") {
        const p = currentProtocol(
          this.service.snapshot(researchId).foundations,
        );
        if (p?.hash !== j.spec.protocolHash)
          throw new Error(
            "Protocol changed before the authorized container started",
          );
        const input = JSON.parse(
          fs.readFileSync(path.join(root, "input.json"), "utf8"),
        );
        if (s.inputHash !== input.inputHash)
          throw new Error("Created container input identity mismatch");
        this.docker(j, ["start", `dsh-${j.token}`]);
        this.service.updateJob(
          researchId,
          jobId,
          `resume-created-${j.token}`,
          (job) => {
            job.status = "running";
            job.externalId = `dsh-${job.token}`;
          },
        );
      } else if (s?.running && j.status === "queued")
        this.service.updateJob(
          researchId,
          jobId,
          `reattach-${j.token}`,
          (job) => {
            job.status = "running";
            job.externalId = `dsh-${job.token}`;
          },
        );
      else if (s && !s.running && s.status !== "created")
        this.service.updateJob(
          researchId,
          jobId,
          `interrupt-${j.token}`,
          (job) => {
            job.status = "interrupted";
            job.error = `Container ${s.status} without valid completion; no automatic resubmission`;
          },
        );
      else if (
        !s &&
        fs.existsSync(path.join(root, "submit.lock")) &&
        Date.now() - Date.parse(j.updatedAt) > 30000
      ) {
        this.service.updateJob(
          researchId,
          jobId,
          `lost-submit-${j.token}`,
          (job) => {
            job.status = "interrupted";
            job.error =
              "No matching external container after interrupted submission; explicit new attempt required";
          },
        );
      }
    }
    return this.job(researchId, jobId);
  }
  cancel(researchId: string, jobId: string) {
    const j = this.job(researchId, jobId);
    if (terminal(j)) return j;
    if (
      j.spec.backend === "portable_cpu" &&
      fs.existsSync(path.join(this.jobRoot(researchId, jobId), "submit.lock"))
    ) {
      const control = path.join(this.jobRoot(researchId, jobId), "cancel.json");
      if (!fs.existsSync(control)) writeAtomic(control, { token: j.token });
      return this.reconcile(researchId, jobId);
    } else if (j.spec.backend !== "portable_cpu") {
      const s = this.inspect(j);
      if (s?.running) this.docker(j, ["stop", "--time", "5", `dsh-${j.token}`]);
      if (this.inspect(j)?.running)
        throw new Error("Container still running after cancellation");
    }
    // Local supervisor owns the child and will publish cancellation after terminating it.
    if (j.spec.backend === "portable_cpu" && j.pid !== null)
      return this.reconcile(researchId, jobId);
    this.service.updateJob(researchId, jobId, `cancel-${j.token}`, (job) => {
      job.status = "cancelled";
      job.error = "Cancelled by human action";
    });
    return this.job(researchId, jobId);
  }
  artifact(
    researchId: string,
    jobId: string,
    name: string,
    expectedHash: string,
  ): Buffer {
    const j = this.job(researchId, jobId),
      entry = j.artifacts.find(
        (a) => a.name === name && a.sha256 === sha(expectedHash),
      );
    if (!entry) throw new Error("Artifact not registered");
    const p = path.join(this.jobRoot(researchId, jobId), entry.name);
    const s = fs.lstatSync(p);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.size !== entry.bytes ||
      fileHash(p) !== entry.sha256
    )
      throw new Error("Artifact changed");
    return fs.readFileSync(p);
  }
}
