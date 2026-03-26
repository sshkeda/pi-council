/**
 * CouncilSession — shared orchestration core for running a council of AI agents.
 *
 * Used by both the CLI `ask` command and the pi extension `spawn_council` tool.
 * Handles: spawning workers, tracking completion, timeout, cancellation, artifacts.
 * Emits events so consumers can wire up their own UI (stderr, pi extension status, etc).
 */

import * as fs from "node:fs";
import { type ChildProcess } from "node:child_process";
import { spawnWorker, agentPaths } from "./runner.js";
import { parseStream } from "./stream-parser.js";
import { writeArtifacts } from "./artifacts.js";
import type { Config, ModelSpec } from "./config.js";
import type { WorkerResult } from "./artifacts.js";

export interface AgentState {
  id: string;
  provider: string;
  model: string;
  output: string;
  exitCode: number | null;
  finished: boolean;
  stopReason: string | null;
  errorMessage: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

export interface CouncilEvents {
  onSpawned?: (model: ModelSpec, pid: number) => void;
  onSpawnError?: (model: ModelSpec, error: Error) => void;
  onFinished?: (agent: AgentState, finishedCount: number, totalCount: number) => void;
  onAllDone?: (agents: AgentState[]) => void;
  onTimeout?: (agents: AgentState[], timeoutSeconds: number) => void;
  onCancelled?: (agents: AgentState[]) => void;
}

export interface CouncilSessionOptions {
  runId: string;
  runDir: string;
  prompt: string;
  models: ModelSpec[];
  config: Config;
  cwd: string;
  timeoutSeconds?: number;
  events?: CouncilEvents;
}

export class CouncilSession {
  readonly runId: string;
  readonly runDir: string;
  readonly agents: AgentState[];
  readonly children: ChildProcess[] = [];

  private cancelled = false;
  private timedOut = false;
  private finishedCount = 0;
  private timeoutTimer?: NodeJS.Timeout;
  private allDoneResolvers: Array<() => void> = [];
  private readonly models: ModelSpec[];
  private readonly config: Config;
  private readonly prompt: string;
  private readonly cwd: string;
  private readonly events: CouncilEvents;

  constructor(opts: CouncilSessionOptions) {
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
      finished: false,
      stopReason: null,
      errorMessage: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    }));

    // Set up timeout
    // Use explicit timeout if provided (even 0 = no timeout), otherwise config default
    const timeoutSec = opts.timeoutSeconds !== undefined ? opts.timeoutSeconds : opts.config.timeout_seconds;
    if (timeoutSec > 0) {
      this.timeoutTimer = setTimeout(() => this.handleTimeout(timeoutSec), timeoutSec * 1000);
      this.timeoutTimer.unref();
    }
  }

  /** Spawn all workers. Returns false if any spawn failed (prior children are killed). */
  start(): boolean {
    for (let i = 0; i < this.models.length; i++) {
      const m = this.models[i];
      let child: ChildProcess;
      try {
        const result = spawnWorker(this.runDir, m, this.prompt, this.config, this.cwd, false);
        child = result.child;
        this.events.onSpawned?.(m, result.pid);
      } catch (err) {
        this.agents[i].finished = true;
        this.agents[i].exitCode = 1;
        this.agents[i].output = `spawn error: ${(err as Error).message}`;
        this.finishedCount++;
        this.events.onSpawnError?.(m, err as Error);

        // Set cancelled BEFORE killAll so handleFinish won't race with complete()
        this.cancelled = true;
        this.killAll();
        this.markUnfinishedAs("1");
        this.saveArtifacts();
        this.allDoneResolvers.forEach(r => r());
        return false;
      }
      this.children.push(child);

      const handleFinish = (code: number | null, error?: string) => {
        if (this.agents[i].finished) return;
        this.agents[i].finished = true;
        this.agents[i].exitCode = code;

        if (error) {
          this.agents[i].output = error;
        } else {
          const paths = agentPaths(this.runDir, m.id);
          const parsed = parseStream(paths.stream);
          this.agents[i].output = parsed.finalText || parsed.assistantText;
          this.agents[i].usage = parsed.usage;
          this.agents[i].stopReason = parsed.stopReason;
          this.agents[i].errorMessage = parsed.errorMessage;
        }

        this.writeDone(m.id, String(code ?? ""));
        this.finishedCount++;

        if (this.cancelled) return;

        this.events.onFinished?.(this.agents[i], this.finishedCount, this.models.length);

        if (this.finishedCount === this.models.length) {
          this.complete();
        }
      };

      child.on("error", (err) => handleFinish(1, `spawn error: ${err.message}`));
      child.on("close", (code) => handleFinish(code, undefined));
    }
    return true;
  }

  /** Wait for all agents to finish. Resolves when done, timed out, or cancelled. Safe to call multiple times. */
  waitForCompletion(): Promise<void> {
    if (this.finishedCount === this.models.length || this.cancelled) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.allDoneResolvers.push(resolve);
    });
  }

  /** Cancel the session — kill all children, save partial artifacts. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.killAll();
    this.markUnfinishedAs("cancelled");
    this.saveArtifacts();
    this.events.onCancelled?.(this.agents);
    this.allDoneResolvers.forEach(r => r());
  }

  /** Get a markdown summary for display (e.g., in followUp messages). */
  buildSummary(): string {
    return this.agents
      .map((r) => {
        const icon = r.exitCode === 0 ? "✅" : "❌";
        return `## ${icon} ${r.id.toUpperCase()} (${r.model})\n\n${r.output || "(no output)"}`;
      })
      .join("\n\n---\n\n");
  }

  /** Save results.md and results.json using the shared artifact writer. */
  saveArtifacts(): void {
    writeArtifacts(this.runDir, {
      runId: this.runId,
      prompt: this.prompt,
      workers: this.agents.map((a): WorkerResult => ({
        id: a.id,
        provider: a.provider,
        model: a.model,
        status: (a.exitCode === 0 && a.stopReason !== "error") ? "done"
          : a.exitCode === 124 ? "timed_out"
          : a.output === "(cancelled)" ? "cancelled"
          : a.output?.startsWith("spawn error") ? "spawn_error"
          : "failed",
        finalText: a.output,
        errorMessage: a.errorMessage ?? (a.exitCode !== 0 ? (a.output || "agent failed") : null),
        usage: a.usage,
      })),
    });
  }

  /** Clean up timeout timer. Call in finally blocks. */
  dispose(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
  }

  get isCancelled(): boolean { return this.cancelled; }
  get isTimedOut(): boolean { return this.timedOut; }
  get isDone(): boolean { return this.finishedCount === this.models.length; }
  get modelNames(): string { return this.models.map((m) => m.id).join(", "); }

  // --- Private ---

  private complete(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.saveArtifacts();
    this.events.onAllDone?.(this.agents);
    this.allDoneResolvers.forEach(r => r());
  }

  private handleTimeout(seconds: number): void {
    if (this.cancelled || this.finishedCount === this.models.length) return;
    this.cancelled = true;
    this.timedOut = true;
    this.killAll();
    this.markUnfinishedAs("124");

    // Still save and notify
    this.saveArtifacts();
    this.events.onTimeout?.(this.agents, seconds);
    this.allDoneResolvers.forEach(r => r());
  }

  private killAll(): void {
    for (const child of this.children) {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
    }
    // Escalate to SIGKILL after 2s for any survivors
    setTimeout(() => {
      for (const child of this.children) {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch { /* already exited */ }
        }
      }
    }, 2000).unref();
  }

  private markUnfinishedAs(code: string): void {
    const messages: Record<string, string> = {
      "cancelled": "(cancelled)",
      "124": "(timed out)",
      "1": "(not started)",
    };
    for (let j = 0; j < this.agents.length; j++) {
      if (!this.agents[j].finished) {
        this.agents[j].finished = true;
        this.agents[j].exitCode = code === "cancelled" ? 1 : parseInt(code, 10) || 1;
        // Preserve any partial output already written to the stream
        if (!this.agents[j].output) {
          const paths = agentPaths(this.runDir, this.agents[j].id);
          const parsed = parseStream(paths.stream);
          this.agents[j].output = parsed.assistantText || parsed.finalText || (messages[code] ?? `(failed: ${code})`);
          this.agents[j].stopReason = parsed.stopReason;
          this.agents[j].errorMessage = parsed.errorMessage;
          this.agents[j].usage = parsed.usage;
        }
        this.finishedCount++;
        this.writeDone(this.agents[j].id, code);
      }
    }
  }

  private writeDone(modelId: string, content: string): void {
    const donePath = agentPaths(this.runDir, modelId).done;
    try {
      // Write-once: don't overwrite if already exists (e.g., from cancel/timeout)
      fs.writeFileSync(donePath, content, { flag: "wx" });
    } catch {
      // EEXIST = already written (expected), other errors = best effort
    }
  }
}
