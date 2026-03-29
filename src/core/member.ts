/**
 * Council member — a single pi agent running in RPC mode.
 *
 * Bidirectional communication via stdin/stdout JSON protocol.
 * Supports steer, follow-up, abort, and full event streaming.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
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
  private thinking = "";
  private stderrOutput = "";
  private error: string | undefined;
  private isStreaming = false;
  private startedAt: number;
  private finishedAt: number | undefined;
  private exitCode: number | null | undefined;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private listeners: EventListener[] = [];
  private pendingResponses = new Map<string, {
    resolve: (resp: RpcResponse) => void;
    reject: (err: Error) => void;
  }>();
  private responseIdCounter = 0;
  /** When true, the next agent_end is from an abort that will be followed by a re-prompt.
   *  We suppress the done transition so the re-prompt's agent_end is the real completion. */
  private suppressNextAgentEnd = false;
  /** Resolves when the suppressed agent_end fires, so abort() can await it. */
  /** Serializes abort calls — only one abort+redirect can run at a time. */
  private abortLock: Promise<void> = Promise.resolve();
  private onceAgentEndSuppressed: (() => void) | undefined;
  /** Timer for the retry grace window — when we see an error agent_end, we
   *  wait briefly for auto_retry_start before committing to done. */
  private retryGraceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Snapshot of the error agent_end event, held during the grace window. */
  private pendingErrorEnd: RpcEvent | undefined;
  private sessionStats: unknown = null;
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
      thinking?: string;
      cwd?: string;
      piBinary?: string;
      piBinaryArgs?: string[];
    } = {},
  ): void {
    const {
      systemPrompt,
      thinking,
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

    if (thinking) {
      piArgs.push("--thinking", thinking);
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
        this.clearRetryGrace();
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
    // Uses StringDecoder to correctly handle multi-byte UTF-8 sequences
    // split across pipe chunks (without it, chunk.toString() corrupts them
    // into U+FFFD replacement characters).
    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      this.processBuffer();
    });

    // Collect stderr for error reporting and observability
    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderrOutput += chunk.toString();
    });

    this.child.on("close", (code) => {
      this.clearRetryGrace();
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
    // Only meaningful when actively streaming — pi queues it between tool calls.
    // For done members, send it but don't change state. If pi ignores it
    // (agent idle), nothing happens. Don't set state to "running" or the
    // member gets stuck waiting for an agent_end that never comes.
    await this.sendRpcCommand({ type: "steer", message });
  }

  /**
   * Send a follow-up message — delivered after agent finishes current work.
   * Keeps the process alive for more interaction.
   */
  async followUp(message: string): Promise<void> {
    this.ensureAlive();
    await this.sendRpcCommand({ type: "follow_up", message });
  }

  /**
   * Abort the current operation and optionally send a new prompt.
   * When a newPrompt is provided, the abort's agent_end is suppressed —
   * the member stays "running" and the re-prompt's agent_end becomes
   * the real completion. Output/thinking are reset for the fresh turn.
   */
  async abort(newPrompt?: string): Promise<void> {
    this.ensureAlive();
    if (newPrompt) {
      // Serialize: wait for any in-flight abort to finish first.
      // Two concurrent abort+redirects would clobber each other's callbacks.
      const prev = this.abortLock;
      let unlock: () => void;
      this.abortLock = new Promise<void>((r) => { unlock = r; });
      await prev;

      try {
        if (this.state === "running") {
          this.suppressNextAgentEnd = true;
          const abortDone = new Promise<void>((resolve) => {
            this.onceAgentEndSuppressed = resolve;
          });
          await this.sendRpcCommand({ type: "abort" });
          await abortDone;
        } else {
          await this.sendRpcCommand({ type: "abort" });
        }
        this.output = "";
        this.thinking = "";
        const prevState = this.state;
        try {
          this.state = "running";
          this.finishedAt = undefined;
          await this.sendRpcCommand({ type: "prompt", message: newPrompt });
        } catch {
          // Prompt failed (stdin closed, process dead). Restore state and
          // re-emit done so anything awaiting waitForDone() doesn't hang.
          this.state = prevState;
          this.finishedAt = this.finishedAt ?? Date.now();
          if (prevState === "done") {
            this.emit({ type: "member_done", memberId: this.id, output: this.output });
          }
        }
      } finally {
        unlock!();
      }
    } else {
      await this.sendRpcCommand({ type: "abort" });
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
      this.clearRetryGrace();
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
      thinking: this.thinking,
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
   * Get the accumulated text output (excludes thinking).
   */
  getOutput(): string {
    return this.output;
  }

  /**
   * Get the accumulated thinking/reasoning content.
   */
  getThinking(): string {
    return this.thinking;
  }

  /**
   * Get session stats (tokens, cost) via pi's get_session_stats RPC.
   * Returns raw pi response data, or null if unavailable.
   */
  private async getSessionStats(): Promise<unknown> {
    try {
      if (!this.child?.stdin?.writable) return null;
      const resp = await this.sendRpcCommand({ type: "get_session_stats" }, 5000);
      return resp.success && resp.data ? resp.data : null;
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

  /**
   * Check if an agent_end event represents an error that pi might auto-retry.
   * Looks at the last assistant message's stopReason.
   */
  private isErrorAgentEnd(event: RpcEvent): boolean {
    const messages = event.messages;
    if (!Array.isArray(messages)) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as Record<string, unknown> | undefined;
      if (msg?.role === "assistant") {
        return msg.stopReason === "error";
      }
    }
    return false;
  }

  /** Cancel any pending retry grace timer. */
  private clearRetryGrace(): void {
    if (this.retryGraceTimer) {
      clearTimeout(this.retryGraceTimer);
      this.retryGraceTimer = undefined;
      this.pendingErrorEnd = undefined;
    }
  }

  /**
   * Extract clean output and thinking from the agent_end event's final message.
   *
   * The `messages` field contains the full conversation with properly typed
   * content blocks (type:"text" vs type:"thinking"). We use the last assistant
   * message to set authoritative output/thinking, overriding whatever was
   * accumulated from streaming deltas.
   *
   * This fixes providers like OpenRouter that may send thinking tokens as
   * text_delta events during streaming — the final message still has the
   * correct content block types.
   */
  private extractFromFinalMessage(event: RpcEvent): void {
    const messages = event.messages;
    if (!Array.isArray(messages)) return;

    // Walk backwards to find the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as Record<string, unknown> | undefined;
      if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

      const textParts: string[] = [];
      const thinkingParts: string[] = [];

      for (const block of msg.content as Record<string, unknown>[]) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          textParts.push(block.text);
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
          thinkingParts.push(block.thinking);
        }
      }

      // Override streaming-accumulated values with authoritative content blocks
      if (textParts.length > 0) {
        this.output = textParts.join("\n\n");
      }
      if (thinkingParts.length > 0) {
        this.thinking = thinkingParts.join("\n\n");
      }
      // If the final message had thinking blocks but NO text blocks, the
      // delta-accumulated output likely contains thinking content that leaked
      // through as text_delta (e.g. OpenRouter/Gemini). Clear it — the
      // thinking field already has the content.
      if (thinkingParts.length > 0 && textParts.length === 0) {
        this.output = "";
      }
      break;
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

  private warn(msg: string): void {
    const line = `[council:${this.id}] ${msg}`;
    this.stderrOutput += line + "\n";
    process.stderr.write(line + "\n");
  }

  private handleRpcEvent(event: RpcEvent): void {
    // Handle command responses
    if (event.type === "response") {
      const id = typeof event.id === "string" ? event.id : undefined;
      if (!id) {
        this.warn(`response missing id: ${JSON.stringify(event)}`);
        return;
      }
      const pending = this.pendingResponses.get(id);
      if (!pending) {
        this.warn(`response for unknown id: ${id}`);
        return;
      }
      this.pendingResponses.delete(id);
      pending.resolve({
        type: "response",
        command: String(event.command ?? ""),
        success: !!event.success,
        error: typeof event.error === "string" ? event.error : undefined,
        data: event.data,
      });
      return;
    }

    // Handle agent events
    switch (event.type) {
      case "agent_start":
        this.isStreaming = true;
        // Also cancel retry grace — agent_start means a new cycle is
        // underway (whether from auto-retry or otherwise). Belt-and-
        // suspenders alongside auto_retry_start handling.
        this.clearRetryGrace();
        break;

      case "agent_end":
        this.isStreaming = false;
        // If this agent_end is from an abort that will be followed by a
        // re-prompt, suppress the done transition. The re-prompt will
        // produce its own agent_end which becomes the real completion.
        if (this.suppressNextAgentEnd) {
          this.suppressNextAgentEnd = false;
          const cb = this.onceAgentEndSuppressed;
          this.onceAgentEndSuppressed = undefined;
          cb?.();
          break;
        }
        // Extract clean output and thinking from the final message's typed
        // content blocks. This is the authoritative source — it properly
        // separates text from thinking even when streaming deltas were
        // misclassified (e.g. OpenRouter sending thinking as text_delta).
        this.extractFromFinalMessage(event);

        // Check if this is an error agent_end that pi might auto-retry.
        // Pi emits: agent_end(error) → auto_retry_start → agent_start → ... → agent_end(success)
        // We defer the done transition for a grace window to catch the retry.
        if (this.state === "running" && this.isErrorAgentEnd(event)) {
          this.pendingErrorEnd = event;
          this.retryGraceTimer = setTimeout(() => {
            // No auto_retry_start arrived — pi isn't retrying.
            // Commit to done with whatever output the error cycle produced.
            this.pendingErrorEnd = undefined;
            this.retryGraceTimer = undefined;
            // Guard: only transition if still running. close/error/cancel
            // may have already moved us to a terminal state.
            if (this.state !== "running") return;
            this.captureStats().catch(() => {});
            this.state = "done";
            this.finishedAt = Date.now();
            this.emit({ type: "member_done", memberId: this.id, output: this.output });
          }, 1000);
          break;
        }

        // Normal (non-error) agent_end — commit immediately.
        this.captureStats().catch(() => {});
        if (this.state === "running") {
          this.state = "done";
          this.finishedAt = Date.now();
          this.emit({ type: "member_done", memberId: this.id, output: this.output });
        }
        break;

      case "auto_retry_start":
        // Pi is retrying after an error agent_end. Cancel the grace timer
        // and stay in "running" state. The retry cycle will produce a fresh
        // agent_start → streaming → agent_end sequence.
        if (this.pendingErrorEnd) {
          clearTimeout(this.retryGraceTimer!);
          this.pendingErrorEnd = undefined;
          this.retryGraceTimer = undefined;
          // Reset output/thinking — the retry produces fresh content.
          this.output = "";
          this.thinking = "";
        }
        break;

      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame && typeof ame === "object" && "type" in ame) {
          if (ame.type === "text_delta" && "delta" in ame && typeof ame.delta === "string") {
            this.output += ame.delta;
            this.emit({ type: "member_output", memberId: this.id, delta: ame.delta });
          } else if (ame.type === "thinking_delta" && "delta" in ame && typeof ame.delta === "string") {
            this.thinking += ame.delta;
          }
          // All other event types (text_start, text_end, thinking_start,
          // thinking_end, toolcall_*, start, done, error) are silently
          // ignored — we use agent_end's final message for authoritative output.
        }
        break;
      }

      case "tool_execution_start": {
        this.toolEvents.push({ ...event });
        if (typeof event.toolName !== "string") {
          this.warn(`tool_execution_start missing toolName: ${JSON.stringify(event).slice(0, 200)}`);
        }
        const toolName = String(event.toolName ?? "");
        const args = event.args ?? {};
        this.emit({ type: "member_tool_start", memberId: this.id, toolName, args });
        break;
      }

      case "tool_execution_end": {
        this.toolEvents.push({ ...event });
        if (typeof event.toolName !== "string") {
          this.warn(`tool_execution_end missing toolName: ${JSON.stringify(event).slice(0, 200)}`);
        }
        const toolName = String(event.toolName ?? "");
        const isError = !!event.isError;
        this.emit({ type: "member_tool_end", memberId: this.id, toolName, isError });
        break;
      }

      default:
        // Unknown event type from pi — log so we know about protocol changes
        break;
    }
  }
}
