import * as fs from "node:fs";
import * as readline from "node:readline";
import { StringDecoder } from "node:string_decoder";

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

function processLine(line: string, result: ParsedStream): void {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > MAX_LINE_LENGTH) return;

  let event: PiEvent;
  try {
    event = JSON.parse(trimmed) as PiEvent;
  } catch {
    return;
  }

  if (!event || typeof event.type !== "string") return;

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

      const stopReason = msg.stopReason ?? null;
      if (stopReason === "stop" && joined) {
        result.finalText = joined;
        result.assistantText = joined;
      }

      if (joined) {
        result.assistantText = joined;
      }

      result.stopReason = stopReason;
      result.errorMessage = msg.errorMessage ?? null;

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

/**
 * Parse a pi JSONL stream file synchronously, line-by-line.
 * Uses a manual line splitter on a streaming read to avoid loading the entire
 * file into memory. Handles files of any size without memory spikes.
 */
/** Cache parsed results by filepath + mtime to avoid reparsing unchanged files. LRU with max 50 entries. */
const CACHE_MAX = 50;
const parseCache = new Map<string, { mtimeMs: number; size: number; result: ParsedStream }>();

function cacheSet(key: string, entry: { mtimeMs: number; size: number; result: ParsedStream }): void {
  // LRU eviction: delete oldest entries when cache exceeds max size
  if (parseCache.size >= CACHE_MAX) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  parseCache.set(key, entry);
}

export function parseStream(filePath: string): ParsedStream {
  // Check cache: skip reparsing if file hasn't changed
  try {
    const stat = fs.statSync(filePath);
    const cached = parseCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.result;
    }
  } catch {
    // File doesn't exist or stat failed — parse will handle it
  }

  const result: ParsedStream = {
    assistantText: "",
    finalText: "",
    stopReason: null,
    errorMessage: null,
    toolCalls: 0,
    events: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  };

  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return result;
  }

  try {
    // Read in 64KB chunks and split into lines manually.
    // Uses StringDecoder to correctly handle multibyte UTF-8 chars split across chunk boundaries.
    const chunkSize = 64 * 1024;
    const buf = Buffer.alloc(chunkSize);
    const decoder = new StringDecoder("utf-8");
    let leftover = "";
    let bytesRead: number;

    while ((bytesRead = fs.readSync(fd, buf, 0, chunkSize, null)) > 0) {
      const chunk = leftover + decoder.write(buf.subarray(0, bytesRead));
      const lines = chunk.split("\n");

      // Last element is incomplete (no trailing newline yet) — save for next chunk
      leftover = lines.pop() ?? "";

      for (const line of lines) {
        processLine(line, result);
      }
    }

    // Flush any remaining bytes in the decoder + leftover
    const remaining = leftover + decoder.end();
    if (remaining.trim()) {
      processLine(remaining, result);
    }
  } finally {
    fs.closeSync(fd);
  }

  // Update cache
  try {
    const stat = fs.statSync(filePath);
    cacheSet(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, result });
  } catch { /* best effort */ }

  return result;
}

/**
 * Async version of parseStream using Node.js readline for non-blocking parsing.
 * Use in contexts where blocking the event loop is unacceptable.
 */
export async function parseStreamAsync(filePath: string): Promise<ParsedStream> {
  const result: ParsedStream = {
    assistantText: "",
    finalText: "",
    stopReason: null,
    errorMessage: null,
    toolCalls: 0,
    events: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  };

  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  } catch {
    return result;
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    processLine(line, result);
  }

  return result;
}
