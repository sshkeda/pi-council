import * as fs from "node:fs";

/** Maximum bytes to read from a JSONL stream file (50 MB). */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Maximum length of a single JSONL line in characters. Lines exceeding this are skipped. */
const MAX_LINE_LENGTH = 1024 * 1024; // 1 MB

export interface ParsedStream {
  assistantText: string;
  finalText: string;
  stopReason: string | null;
  errorMessage: string | null;
  toolCalls: number;
  events: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
}

/** Shape of a content part in a pi JSONL message. */
interface ContentPart {
  type: string;
  text?: string;
}

/** Shape of the message field in pi JSONL events. */
interface PiMessage {
  role?: string;
  content?: ContentPart[];
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
}

/** Shape of a pi JSONL event line. */
interface PiEvent {
  type: string;
  message?: PiMessage;
}

export function parseStream(filePath: string): ParsedStream {
  const result: ParsedStream = {
    assistantText: "",
    finalText: "",
    stopReason: null,
    errorMessage: null,
    toolCalls: 0,
    events: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  };

  if (!fs.existsSync(filePath)) return result;

  let raw: string;
  try {
    // Read up to MAX_FILE_BYTES to prevent memory exhaustion on huge streams
    const fd = fs.openSync(filePath, "r");
    try {
      const stat = fs.fstatSync(fd);
      const bytesToRead = Math.min(stat.size, MAX_FILE_BYTES);
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, 0);
      raw = buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // File may have been removed between existsSync and open — not actionable
    return result;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip oversized lines to prevent JSON.parse from consuming unbounded memory
    if (trimmed.length > MAX_LINE_LENGTH) continue;

    let event: PiEvent;
    try {
      event = JSON.parse(trimmed) as PiEvent;
    } catch {
      // Malformed JSON line — skip (common with partial writes / truncated streams)
      continue;
    }

    // Basic structural validation: must have a type string
    if (!event || typeof event.type !== "string") continue;

    result.events++;
    const type = event.type;
    const msg = event.message;

    if (type === "message_update") {
      if (msg?.role === "assistant") {
        const texts: string[] = [];
        for (const part of msg.content ?? []) {
          if (part.type === "text") texts.push(part.text ?? "");
        }
        const joined = texts.join("").trim();
        // Always track latest assistant text as fallback
        if (joined) result.assistantText = joined;
      }
    } else if (type === "message_end") {
      if (msg?.role === "assistant") {
        const texts: string[] = [];
        for (const part of msg.content ?? []) {
          if (part.type === "text") texts.push(part.text ?? "");
          if (part.type === "toolCall") result.toolCalls++;
        }
        const joined = texts.join("").trim();

        // Only set finalText from actual final answers (stopReason="stop"),
        // not from intermediate tool-calling messages (stopReason="toolUse")
        const stopReason = msg.stopReason ?? null;
        if (stopReason === "stop" && joined) {
          result.finalText = joined;
          result.assistantText = joined;
        }

        // Always update assistantText as fallback for partial output
        if (joined) {
          result.assistantText = joined;
        }

        result.stopReason = stopReason;
        result.errorMessage = msg.errorMessage ?? null;

        // Accumulate usage
        const u = msg.usage;
        if (u) {
          result.usage.input += u.input ?? 0;
          result.usage.output += u.output ?? 0;
          result.usage.cacheRead += u.cacheRead ?? 0;
          result.usage.cacheWrite += u.cacheWrite ?? 0;
          result.usage.cost += u.cost?.total ?? 0;
        }
      }
    }
  }

  return result;
}
