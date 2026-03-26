/** CouncilSession — shared orchestration for ask + extension. Thin wrapper around spawn + wait. */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ChildProcess } from "node:child_process";
import { spawnWorker, agentPaths, parseStream } from "./runner.js";
import type { Config, ModelSpec } from "./config.js";

export interface AgentResult {
  id: string;
  provider: string;
  model: string;
  output: string;
  exitCode: number | null;
  stopReason: string | null;
  errorMessage: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

export interface SessionEvents {
  onSpawned?: (model: ModelSpec, pid: number) => void;
  onFinished?: (agent: AgentResult, done: number, total: number) => void;
  onAllDone?: (agents: AgentResult[]) => void;
  onTimeout?: (agents: AgentResult[], secs: number) => void;
  onCancelled?: (agents: AgentResult[]) => void;
}

export interface SessionOptions {
  runId: string;
  runDir: string;
  prompt: string;
  models: ModelSpec[];
  config: Config;
  cwd: string;
  timeoutSeconds?: number;
  events?: SessionEvents;
}

export class CouncilSession {
  readonly runId: string;
  readonly runDir: string;
  readonly agents: AgentResult[];
  readonly children: ChildProcess[] = [];
  private cancelled = false;
  private timedOut = false;
  private done = 0;
  private timer?: NodeJS.Timeout;
  private waiters: Array<() => void> = [];
  private models: ModelSpec[];
  private config: Config;
  private prompt: string;
  private cwd: string;
  private events: SessionEvents;

  constructor(opts: SessionOptions) {
    this.runId = opts.runId;
    this.runDir = opts.runDir;
    this.prompt = opts.prompt;
    this.models = opts.models;
    this.config = opts.config;
    this.cwd = opts.cwd;
    this.events = opts.events ?? {};
    this.agents = opts.models.map((m) => ({
      id: m.id,
      provider: m.provider,
      model: m.model,
      output: "",
      exitCode: null,
      stopReason: null,
      errorMessage: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    }));
    const t = opts.timeoutSeconds !== undefined ? opts.timeoutSeconds : opts.config.timeout_seconds;
    if (t > 0) {
      this.timer = setTimeout(() => this.handleTimeout(t), t * 1000);
      this.timer.unref();
    }
  }

  start(): boolean {
    for (let i = 0; i < this.models.length; i++) {
      const m = this.models[i];
      try {
        const { pid, child } = spawnWorker(this.runDir, m, this.prompt, this.config, this.cwd, false);
        this.children.push(child);
        this.events.onSpawned?.(m, pid);
        const finish = (code: number | null, error?: string) => {
          if (this.agents[i].exitCode !== null) return;
          this.agents[i].exitCode = code;
          if (error) {
            this.agents[i].output = error;
          } else {
            const p = parseStream(agentPaths(this.runDir, m.id).stream);
            this.agents[i].output = p.finalText || p.assistantText;
            this.agents[i].usage = p.usage;
            this.agents[i].stopReason = p.stopReason;
            this.agents[i].errorMessage = p.errorMessage;
          }
          try {
            fs.writeFileSync(agentPaths(this.runDir, m.id).done, String(code ?? ""), { flag: "wx" });
          } catch {}
          this.done++;
          if (!this.cancelled) {
            this.events.onFinished?.(this.agents[i], this.done, this.models.length);
          }
          if (this.done === this.models.length && !this.cancelled) this.complete();
        };
        child.on("error", (err) => finish(1, `spawn error: ${err.message}`));
        child.on("close", (code) => finish(code, undefined));
      } catch (err) {
        this.agents[i].exitCode = 1;
        this.agents[i].output = (err as Error).message;
        this.done++;
        this.cancelled = true;
        this.killAll();
        this.markRest("1");
        this.saveArtifacts();
        this.waiters.forEach((r) => r());
        return false;
      }
    }
    return true;
  }

  wait(): Promise<void> {
    if (this.done === this.models.length || this.cancelled) return Promise.resolve();
    return new Promise((r) => {
      this.waiters.push(r);
    });
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.timer) clearTimeout(this.timer);
    this.killAll();
    this.markRest("cancelled");
    this.saveArtifacts();
    this.events.onCancelled?.(this.agents);
    this.waiters.forEach((r) => r());
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
  get isCancelled() {
    return this.cancelled;
  }
  get isTimedOut() {
    return this.timedOut;
  }
  get isDone() {
    return this.done === this.models.length;
  }
  get modelNames() {
    return this.models.map((m) => m.id).join(", ");
  }

  summary(): string {
    return this.agents
      .map((a) => {
        const icon = a.exitCode === 0 && a.stopReason !== "error" ? "✅" : "❌";
        return `## ${icon} ${a.id.toUpperCase()} (${a.model})\n\n${a.output || "(no output)"}`;
      })
      .join("\n\n---\n\n");
  }

  saveArtifacts(): void {
    const workers = this.agents.map((a) => ({
      id: a.id,
      provider: a.provider,
      model: a.model,
      status: a.exitCode === 0 && a.stopReason !== "error" && !a.errorMessage ? "done" : "failed",
      finalText: a.output,
      errorMessage: a.errorMessage ?? (a.exitCode !== 0 ? a.output || "failed" : null),
      usage: a.usage,
    }));
    const json = JSON.stringify({ runId: this.runId, prompt: this.prompt, completedAt: Date.now(), workers }, null, 2);
    let md = `# pi-council results\nRun: ${this.runId}\n\nQuestion:\n${this.prompt}\n\n---\n\n`;
    for (const w of workers) {
      md += `## ${w.id} — ${w.provider}/${w.model}\n\n${w.finalText || `(no output: ${w.errorMessage ?? "unknown"})`}\n\n`;
      if (w.usage.cost > 0)
        md += `*cost: $${w.usage.cost.toFixed(4)} | tokens: ↑${w.usage.input} ↓${w.usage.output}*\n\n`;
      md += "---\n\n";
    }
    try {
      fs.writeFileSync(path.join(this.runDir, "results.json"), json);
      fs.writeFileSync(path.join(this.runDir, "results.md"), md);
    } catch (e) {
      process.stderr.write(`⚠️  Failed to write artifacts: ${(e as Error).message}\n`);
    }
  }

  private complete(): void {
    if (this.timer) clearTimeout(this.timer);
    this.saveArtifacts();
    this.events.onAllDone?.(this.agents);
    this.waiters.forEach((r) => r());
  }

  private handleTimeout(secs: number): void {
    if (this.cancelled || this.done === this.models.length) return;
    this.cancelled = true;
    this.timedOut = true;
    this.killAll();
    this.markRest("124");
    this.saveArtifacts();
    this.events.onTimeout?.(this.agents, secs);
    this.waiters.forEach((r) => r());
  }

  private killAll(): void {
    for (const c of this.children) {
      try {
        c.kill("SIGTERM");
      } catch {}
    }
    setTimeout(() => {
      for (const c of this.children) {
        if (c.exitCode === null)
          try {
            c.kill("SIGKILL");
          } catch {}
      }
    }, 2000).unref();
  }

  private markRest(code: string): void {
    for (let j = 0; j < this.agents.length; j++) {
      if (this.agents[j].exitCode === null) {
        this.agents[j].exitCode = code === "cancelled" ? 1 : parseInt(code, 10) || 1;
        const p = parseStream(agentPaths(this.runDir, this.agents[j].id).stream);
        this.agents[j].output =
          p.assistantText ||
          p.finalText ||
          (code === "cancelled" ? "(cancelled)" : code === "124" ? "(timed out)" : "(not started)");
        this.agents[j].stopReason = p.stopReason;
        this.agents[j].errorMessage = p.errorMessage;
        this.agents[j].usage = p.usage;
        this.done++;
        try {
          fs.writeFileSync(agentPaths(this.runDir, this.agents[j].id).done, code, { flag: "wx" });
        } catch {}
      }
    }
  }
}
