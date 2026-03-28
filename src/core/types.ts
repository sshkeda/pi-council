/**
 * Core types for the council system.
 */

export interface ModelSpec {
  id: string;
  provider: string;
  model: string;
}

export interface Profile {
  name: string;
  models: ModelSpec[];
  systemPrompt: string;
}

export interface SpawnOptions {
  /** Use a named profile */
  profile?: string;
  /** Or specify custom models */
  models?: ModelSpec[];
  /** Custom system prompt (applied to all members) */
  systemPrompt?: string;
  /** Per-model system prompt overrides (key: model id, value: prompt) */
  systemPrompts?: Record<string, string>;
  /** Working directory for agents */
  cwd?: string;
  /** Override the pi binary path (for testing with mock-pi) */
  piBinary?: string;
  /** Extra args to prepend (e.g. ["node"] when piBinary is a .mjs script) */
  piBinaryArgs?: string[];
}

export type MemberState =
  | "spawning"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface MemberStatus {
  id: string;
  model: ModelSpec;
  state: MemberState;
  /** Accumulated text output so far */
  output: string;
  /** Error message if failed */
  error?: string;
  /** Accumulated stderr output */
  stderr: string;
  /** Whether the member is currently streaming (processing a prompt) */
  isStreaming: boolean;
  /** Start time */
  startedAt: number;
  /** End time (if done) */
  finishedAt?: number;
  /** Duration in ms (if done) */
  durationMs?: number;
  /** Exit code of the process */
  exitCode?: number | null;
  /** Raw session stats from pi's get_session_stats RPC (tokens, cost) */
  stats?: unknown;
  /** Raw pi RPC events for tool executions (start + end, in order) */
  toolEvents: unknown[];
}

export type FollowUpType = "abort" | "steer";

export interface FollowUpOptions {
  /** Which type of follow-up */
  type: FollowUpType;
  /** Message to send */
  message: string;
  /** Target specific member IDs, or all if omitted */
  memberIds?: string[];
}

export interface CouncilStatus {
  runId: string;
  prompt: string;
  startedAt: number;
  members: MemberStatus[];
  /** How many members are done */
  finishedCount: number;
  /** Whether all members are done */
  isComplete: boolean;
}

export interface CouncilResult {
  runId: string;
  prompt: string;
  startedAt: number;
  completedAt: number;
  /** Time to first result in ms (when the first member finished) */
  ttfrMs?: number;
  members: {
    id: string;
    model: ModelSpec;
    state: MemberState;
    output: string;
    error?: string;
    durationMs?: number;
    stats?: unknown;
  }[];
}

/** Event emitted by the council for observability */
export type CouncilEvent =
  | { type: "member_started"; memberId: string; model: ModelSpec }
  | { type: "member_output"; memberId: string; delta: string }
  | { type: "member_tool_start"; memberId: string; toolName: string; args: Record<string, unknown> }
  | { type: "member_tool_end"; memberId: string; toolName: string; isError: boolean }
  | { type: "member_done"; memberId: string; output: string }
  | { type: "member_failed"; memberId: string; error: string }
  | { type: "council_complete"; result: CouncilResult };
