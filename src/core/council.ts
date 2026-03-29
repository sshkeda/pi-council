/**
 * Council — manages a group of council members for a single run.
 *
 * Handles spawning, follow-ups, cancellation, status, and result collection.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CouncilMember } from "./member.js";
import { COUNCIL_SYSTEM_PROMPT } from "./profiles.js";
import { generateRunId } from "../util/run-id.js";
import type {
  SpawnOptions,
  CouncilStatus,
  CouncilResult,
  CouncilEvent,
  FollowUpOptions,
  ModelSpec,
} from "./types.js";

type EventListener = (event: CouncilEvent) => void;

/** Resolve paths at call time so $HOME overrides work in tests/Docker */
function getRunsDir(): string {
  return path.join(os.homedir(), ".pi-council", "runs");
}

export class Council {
  readonly runId: string;
  readonly prompt: string;
  readonly startedAt: number;
  private members: CouncilMember[] = [];
  private listeners: EventListener[] = [];
  private runDir: string;
  private ttfrMs: number | undefined;
  private memberTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(prompt: string, runId?: string) {
    this.runId = runId ?? generateRunId();
    this.prompt = prompt;
    this.startedAt = Date.now();
    this.runDir = path.join(getRunsDir(), this.runId);
  }

  /**
   * Spawn council members based on options.
   */
  spawn(options: SpawnOptions): void {
    const {
      models,
      systemPrompt: customSystemPrompt,
      systemPrompts,
      thinking,
      cwd,
      piBinary,
      piBinaryArgs,
      memberTimeoutMs,
    } = options;

    if (!models || models.length === 0) {
      throw new Error("No models provided. Pass models in spawn options.");
    }

    const systemPrompt = customSystemPrompt ?? COUNCIL_SYSTEM_PROMPT;

    // Create run directory and save metadata
    fs.mkdirSync(this.runDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.runDir, "meta.json"),
      JSON.stringify({
        runId: this.runId,
        prompt: this.prompt,
        startedAt: this.startedAt,
        models,
        cwd,
      }, null, 2),
    );
    fs.writeFileSync(path.join(this.runDir, "prompt.txt"), this.prompt);

    // Spawn each member
    for (const model of models) {
      const member = new CouncilMember(model.id, model);

      // Forward member events to council listeners
      member.on((event) => {
        this.emit(event);

        // On member completion: write per-member result to disk, track TTFR
        if (event.type === "member_done" || event.type === "member_failed") {
          const memberId = "memberId" in event ? String(event.memberId) : "";
          const m = this.getMember(memberId);
          if (m) {
            const status = m.getStatus();
            try {
              fs.writeFileSync(
                path.join(this.runDir, `${memberId}.json`),
                JSON.stringify({
                  id: status.id,
                  model: status.model,
                  state: status.state,
                  output: status.output,
                  thinking: status.thinking,
                  error: status.error,
                  stderr: status.stderr,
                  durationMs: status.durationMs,
                  stats: status.stats,
                  toolEvents: status.toolEvents,
                }, null, 2),
              );
            } catch {}
          }

          if (this.ttfrMs === undefined) {
            this.ttfrMs = Date.now() - this.startedAt;
          }
        }

        // Check if council is complete after each member event
        if (
          (event.type === "member_done" || event.type === "member_failed") &&
          this.isComplete()
        ) {
          this.onComplete();
        }
      });

      this.members.push(member);

      // Use per-model prompt if provided, otherwise fall back to shared prompt
      const memberPrompt = systemPrompts?.[model.id] ?? systemPrompt;

      member.spawn(this.prompt, {
        systemPrompt: memberPrompt,
        thinking,
        cwd,
        piBinary,
        piBinaryArgs,
      });

      // Set per-member timeout if configured
      if (memberTimeoutMs && memberTimeoutMs > 0) {
        const timer = setTimeout(() => {
          if (member.isAlive() && !member.hasResult()) {
            member.cancel();
          }
        }, memberTimeoutMs);
        this.memberTimeouts.set(model.id, timer);
        // Clear timeout when member finishes naturally
        member.on((event) => {
          if (event.type === "member_done" || event.type === "member_failed") {
            const t = this.memberTimeouts.get(model.id);
            if (t) { clearTimeout(t); this.memberTimeouts.delete(model.id); }
          }
        });
      }
    }
  }

  /**
   * Send a follow-up to council members.
   */
  async followUp(options: FollowUpOptions): Promise<void> {
    const targets = options.memberIds
      ? this.members.filter((m) => options.memberIds!.includes(m.id))
      : this.members.filter((m) => m.isAlive());

    const promises = targets.map(async (member) => {
      try {
        if (options.type === "abort") {
          await member.abort(options.message);
        } else {
          await member.steer(options.message);
        }
      } catch {
        // Member may have finished between check and send
      }
    });

    await Promise.all(promises);
  }

  /**
   * Cancel specific member(s) or the entire council.
   */
  cancel(memberIds?: string[]): void {
    const targets = memberIds
      ? this.members.filter((m) => memberIds.includes(m.id))
      : this.members;

    for (const member of targets) {
      if (member.isAlive()) {
        member.cancel();
      }
    }
  }

  /**
   * Get status of all members.
   */
  getStatus(): CouncilStatus {
    const memberStatuses = this.members.map((m) => m.getStatus());
    return {
      runId: this.runId,
      prompt: this.prompt,
      startedAt: this.startedAt,
      members: memberStatuses,
      finishedCount: memberStatuses.filter((m) =>
        m.state === "done" || m.state === "failed" || m.state === "cancelled" || m.state === "timed_out",
      ).length,
      isComplete: this.isComplete(),
    };
  }

  /**
   * Get a specific member by ID.
   */
  getMember(id: string): CouncilMember | undefined {
    return this.members.find((m) => m.id === id);
  }

  /**
   * Get all members.
   */
  getMembers(): CouncilMember[] {
    return [...this.members];
  }

  /**
   * Read the current output stream of a member.
   */
  readStream(memberId: string): string {
    const member = this.getMember(memberId);
    if (!member) throw new Error(`Unknown member: ${memberId}`);
    return member.getOutput();
  }

  /**
   * Whether all members have finished.
   */
  isComplete(): boolean {
    return this.members.length > 0 && this.members.every((m) => m.hasResult());
  }

  /**
   * Wait for all members to finish.
   */
  async waitForCompletion(): Promise<CouncilResult> {
    await Promise.all(this.members.map((m) => m.waitForDone()));
    return this.getResult();
  }

  /**
   * Get the final result.
   */
  getResult(): CouncilResult {
    return {
      runId: this.runId,
      prompt: this.prompt,
      startedAt: this.startedAt,
      completedAt: Date.now(),
      ttfrMs: this.ttfrMs,
      members: this.members.map((m) => {
        const status = m.getStatus();
        return {
          id: status.id,
          model: status.model,
          state: status.state,
          output: status.output,
          thinking: status.thinking,
          error: status.error,
          durationMs: status.durationMs,
          stats: status.stats,
          toolEvents: status.toolEvents,
        };
      }),
    };
  }

  /**
   * Subscribe to council events.
   */
  on(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Get the run directory path.
   */
  getRunDir(): string {
    return this.runDir;
  }

  // --- Internal ---

  private emit(event: CouncilEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  private onComplete(): void {
    const result = this.getResult();

    // Close all member RPC sessions now that the council is done
    for (const member of this.members) {
      member.finish();
    }

    // Write artifacts
    this.writeArtifacts(result);

    // Emit completion event
    this.emit({ type: "council_complete", result });
  }

  private writeArtifacts(result: CouncilResult): void {
    try {
      // results.json
      fs.writeFileSync(
        path.join(this.runDir, "results.json"),
        JSON.stringify(result, null, 2),
      );

      // results.md
      const md = this.buildMarkdown(result);
      fs.writeFileSync(path.join(this.runDir, "results.md"), md);
    } catch {}
  }

  private buildMarkdown(result: CouncilResult): string {
    const sections = result.members.map((m) => {
      const icon = m.state === "done" ? "✅" : "❌";
      const header = `## ${icon} ${m.id.toUpperCase()} (${m.model.model})`;
      const body = m.output || m.error || "(no output)";
      const thinkingSection = m.thinking
        ? `\n\n<details>\n<summary>Thinking (${m.thinking.length} chars)</summary>\n\n${m.thinking}\n\n</details>`
        : "";
      const duration = m.durationMs ? `\n\n*${(m.durationMs / 1000).toFixed(1)}s*` : "";
      return `${header}\n\n${body}${thinkingSection}${duration}`;
    });

    return `# Council Results\n\n**Prompt:** ${result.prompt}\n\n---\n\n${sections.join("\n\n---\n\n")}`;
  }
}

/**
 * Council registry — tracks all active councils across the process.
 */
export class CouncilRegistry {
  private councils = new Map<string, Council>();

  add(council: Council): void {
    this.councils.set(council.runId, council);
  }

  get(runId: string): Council | undefined {
    return this.councils.get(runId);
  }

  getLatest(): Council | undefined {
    const entries = [...this.councils.entries()];
    if (entries.length === 0) return undefined;
    return entries[entries.length - 1][1];
  }

  remove(runId: string): void {
    this.councils.delete(runId);
  }

  list(): Council[] {
    return [...this.councils.values()];
  }

  /** Get all active (incomplete) councils */
  active(): Council[] {
    return this.list().filter((c) => !c.isComplete());
  }
}

/** Global registry for the process */
export const registry = new CouncilRegistry();
