/**
 * Council member — a single pi agent running in RPC mode.
 *
 * Bidirectional communication via stdin/stdout JSON protocol.
 * Supports steer, follow-up, abort, and full event streaming.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ModelSpec, MemberState, MemberStatus, CouncilEvent } from "./types.js";

type EventListener = (event: CouncilEvent) => void;

interface RpcResponse {
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export class CouncilMember {
  readonly id: string;
  readonly model: ModelSpec;

  private child: ChildProcess | null = null;
  private state: MemberState = "spawning";
  private output = "";
  private stderrOutput = "";
  private error: string | undefined;
  private isStreaming = false;
  private startedAt: number;
  private finishedAt: number | undefined;
  private exitCode: number | null | undefined;
  private buffer = "";
  private listeners: EventListener[] = [];
  private pendingResponses = new Map<string, {
    resolve: (resp: RpcResponse) => void;
    reject: (err: Error) => void;
  }>();
  private responseIdCounter = 0;
  private sessionStats: { tokens: { input: number; output: number; total: number }; cost: number } | null = null;
  private toolEvents: unknown[] = [];

  constructor(id: string, model: ModelSpec) {
    this.id = id;
    this.model = model;
    this.startedAt = Date.now();
  }

  /**
   * Spawn the pi agent in RPC mode and send the initial prompt.
   */
  spawn(
    prompt: string,
    options: {
      systemPrompt?: string;
      cwd?: string;
      piBinary?: string;
      piBinaryArgs?: string[];
    } = {},
  ): void {
    const {
      systemPrompt,
      cwd,
      piBinary = "pi",
      piBinaryArgs = [],
    } = options;

    const piArgs = [
      "--mode", "rpc",
      "--provider", this.model.provider,
      "--model", this.model.model,
      "--no-session",
    ];

    if (systemPrompt) {
      piArgs.push("--append-system-prompt", systemPrompt);
    }

    // Support running scripts: piBinary="node", piBinaryArgs=["mock-pi.mjs"]
    const allArgs = [...piBinaryArgs, ...piArgs];

    this.child = spawn(piBinary, allArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: cwd ?? process.cwd(),
      env: { ...process.env },
    });

    // Attach error handler IMMEDIATELY to prevent unhandled error crash
    this.child.on("error", (err) => {
      if (this.state === "running" || this.state === "spawning") {
        this.state = "failed";
        this.error = `Process error: ${err.message}`;
        this.finishedAt = Date.now();
        this.emit({ type: "member_failed", memberId: this.id, error: this.error });
      }
    });

    if (!this.child.pid) {
      this.state = "failed";
      this.error = "Failed to spawn pi process";
      this.finishedAt = Date.now();
      this.emit({ type: "member_failed", memberId: this.id, error: this.error });
      return;
    }

    this.state = "running";
    this.emit({ type: "member_started", memberId: this.id, model: this.model });

    // Read stdout line by line (JSONL)
    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    // Collect stderr for error reporting and observability
    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderrOutput += chunk.toString();
    });

    this.child.on("close", (code) => {
      this.exitCode = code;
      // Only transition if still running/spawning — agent_end already
      // handles the normal done transition. This catches crashes and
      // processes killed externally.
      if (this.state === "running" || this.state === "spawning") {
        this.state = "failed";
        this.error = this.stderrOutput.trim() || `Process exited with code ${code}`;
        this.finishedAt = Date.now();
        this.emit({ type: "member_failed", memberId: this.id, error: this.error });
      }
      this.isStreaming = false;
    });

    // Send the initial prompt
    this.sendRpcCommand({ type: "prompt", message: prompt }).catch(() => {
      // stdin may not be writable if spawn failed
    });
  }

  /**
   * Send a steer message — delivered after current tool call completes.
   * Keeps the process alive for more interaction.
   */
  async steer(message: string): Promise<void> {
    this.ensureAlive();
    // Re-activate if done — the process is still alive, we're sending more work
    if (this.state === "done") this.state = "running";
    await this.sendRpcCommand({ type: "steer", message });
  }

  /**
   * Send a follow-up message — delivered after agent finishes current work.
   * Keeps the process alive for more interaction.
   */
  async followUp(message: string): Promise<void> {
    this.ensureAlive();
    if (this.state === "done") this.state = "running";
    await this.sendRpcCommand({ type: "follow_up", message });
  }

  /**
   * Abort the current operation and optionally send a new prompt.
   */
  async abort(newPrompt?: string): Promise<void> {
    this.ensureAlive();
    await this.sendRpcCommand({ type: "abort" });
    if (newPrompt) {
      // Wait a tick for abort to process, then send new prompt
      await new Promise((r) => setTimeout(r, 50));
      await this.sendRpcCommand({ type: "prompt", message: newPrompt });
    }
  }

  /**
   * Finish interaction — close stdin to let the process exit.
   * Call this when no more follow-ups will be sent.
   */
  finish(): void {
    this.closeStdin();
  }

  /**
   * Kill the member process entirely.
   */
  cancel(): void {
    if (this.child && (this.state === "running" || this.state === "spawning")) {
      this.state = "cancelled";
      this.finishedAt = Date.now();
      this.emit({ type: "member_failed", memberId: this.id, error: "cancelled" });
      try {
        this.child.kill("SIGTERM");
      } catch {}
    }
  }

  /**
   * Get current status.
   */
  getStatus(): MemberStatus {
    return {
      id: this.id,
      model: this.model,
      state: this.state,
      output: this.output,
      error: this.error,
      stderr: this.stderrOutput,
      isStreaming: this.isStreaming,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      durationMs: this.finishedAt ? this.finishedAt - this.startedAt : undefined,
      exitCode: this.exitCode,
      stats: this.sessionStats,
      toolEvents: [...this.toolEvents],
    };
  }

  /**
   * Get the accumulated output text.
   */
  getOutput(): string {
    return this.output;
  }

  /**
   * Get the cached session stats (captured on agent_end).
   */
  getCachedStats(): { tokens: { input: number; output: number; total: number }; cost: number } | null {
    return this.sessionStats;
  }

  /**
   * Get session stats (tokens, cost) via RPC get_session_stats.
   * Returns null if the member is not alive or the command fails.
   */
  async getSessionStats(): Promise<{ tokens: { input: number; output: number; total: number }; cost: number } | null> {
    try {
      if (!this.child?.stdin?.writable) return null;
      const resp = await this.sendRpcCommand({ type: "get_session_stats" }, 5000);
      if (resp.success && resp.data) {
        return resp.data as { tokens: { input: number; output: number; total: number }; cost: number };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Whether this member's process can still receive commands.
   * A "done" member is still alive — its process is open for steer/followUp.
   */
  isAlive(): boolean {
    return this.state === "running" || this.state === "spawning" || this.state === "done";
  }

  /**
   * Whether this member has produced a result (done, failed, cancelled, timed_out).
   * A "done" member has a result but its process may still be alive.
   */
  hasResult(): boolean {
    return this.state === "done" || this.state === "failed" || this.state === "cancelled" || this.state === "timed_out";
  }

  /**
   * Whether this member's process has fully exited.
   */
  isDone(): boolean {
    return this.state === "failed" || this.state === "cancelled" || this.state === "timed_out";
  }

  /**
   * Subscribe to events from this member.
   */
  on(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Wait for this member to finish.
   */
  waitForDone(): Promise<MemberStatus> {
    if (this.hasResult()) return Promise.resolve(this.getStatus());
    return new Promise((resolve) => {
      const unsub = this.on((event) => {
        if (
          event.type === "member_done" ||
          event.type === "member_failed"
        ) {
          unsub();
          resolve(this.getStatus());
        }
      });
    });
  }

  // --- Internal ---

  private emit(event: CouncilEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  private ensureAlive(): void {
    if (!this.child || (this.state !== "running" && this.state !== "done")) {
      throw new Error(`Member ${this.id} is not alive (state: ${this.state})`);
    }
  }

  private async captureStats(): Promise<void> {
    try {
      const stats = await this.getSessionStats();
      if (stats) {
        this.sessionStats = stats;
      }
    } catch {
      // Non-fatal — stats are optional
    }
  }

  private closeStdin(): void {
    try {
      if (this.child?.stdin?.writable) {
        this.child.stdin.end();
      }
    } catch {}
  }

  private sendRpcCommand(command: Record<string, unknown>, timeoutMs = 10_000): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin?.writable) {
        reject(new Error("stdin not writable"));
        return;
      }

      const id = `req-${++this.responseIdCounter}`;
      const cmd = { ...command, id };

      const timer = setTimeout(() => {
        this.pendingResponses.delete(id);
        reject(new Error(`RPC command timed out: ${command.type}`));
      }, timeoutMs);

      this.pendingResponses.set(id, {
        resolve: (resp) => { clearTimeout(timer); resolve(resp); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.child.stdin.write(JSON.stringify(cmd) + "\n");
    });
  }

  private processBuffer(): void {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;

      try {
        const event: RpcEvent = JSON.parse(line);
        this.handleRpcEvent(event);
      } catch {
        // Skip unparseable lines
      }
    }
  }

  private handleRpcEvent(event: RpcEvent): void {
    // Handle command responses
    if (event.type === "response") {
      const resp = event as unknown as RpcResponse;
      const id = (event as { id?: string }).id;
      if (id && this.pendingResponses.has(id)) {
        const pending = this.pendingResponses.get(id)!;
        this.pendingResponses.delete(id);
        pending.resolve(resp);
      }
      return;
    }

    // Handle agent events
    switch (event.type) {
      case "agent_start":
        this.isStreaming = true;
        break;

      case "agent_end":
        this.isStreaming = false;
        // Capture cost/token stats
        this.captureStats().catch(() => {});
        // Mark as done — but keep process alive for steer/followUp.
        // Council calls finish() to close stdin when it's ready.
        if (this.state === "running") {
          this.state = "done";
          this.finishedAt = Date.now();
          this.emit({ type: "member_done", memberId: this.id, output: this.output });
        }
        break;

      case "message_update": {
        const ame = event.assistantMessageEvent as { type: string; delta?: string } | undefined;
        if (ame?.type === "text_delta" && ame.delta) {
          this.output += ame.delta;
          this.emit({ type: "member_output", memberId: this.id, delta: ame.delta });
        }
        break;
      }

      case "tool_execution_start": {
        this.toolEvents.push({ ...event });
        const toolName = event.toolName as string;
        const args = event.args as Record<string, unknown>;
        this.emit({ type: "member_tool_start", memberId: this.id, toolName, args });
        break;
      }

      case "tool_execution_end": {
        this.toolEvents.push({ ...event });
        const toolName = event.toolName as string;
        const isError = event.isError as boolean;
        this.emit({ type: "member_tool_end", memberId: this.id, toolName, isError });
        break;
      }
    }
  }
}
