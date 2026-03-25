import * as fs from "node:fs";

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
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return result;
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    result.events++;
    const type = event.type;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any — pi's JSONL schema is dynamic
    const msg = (event as any).message;

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
