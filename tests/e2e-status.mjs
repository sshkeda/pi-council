#!/usr/bin/env node

/**
 * E2E test: verify status display shows tool calls and flags empty output.
 */

import { Council } from "../dist/src/core/council.js";

const council = new Council("What is 2+2? One sentence.");

council.on((event) => {
  if (event.type === "member_done" || event.type === "member_failed") {
    const m = council.getMember(event.memberId);
    if (!m) return;
    const s = m.getStatus();
    const hasOutput = s.output.length > 0;
    const icon = s.state === "done" && hasOutput ? "✅" : s.state === "done" ? "⚠️" : "❌";
    console.log(`${icon} ${s.id} (${(s.durationMs/1000).toFixed(1)}s)`);
    console.log(`  output: ${s.output.length} chars | thinking: ${s.thinking.length} chars | tools: ${s.toolEvents.length}`);
    if (s.output) console.log(`  text: "${s.output.slice(0, 80)}"`);
    if (!hasOutput && s.state === "done") console.log(`  ⚠️ EMPTY OUTPUT — model completed but produced no response`);
  }
});

// Use all 4 models
council.spawn({
  models: [
    { id: "claude", provider: "anthropic", model: "claude-opus-4-6" },
    { id: "gpt", provider: "openai-codex", model: "gpt-5.4" },
    { id: "gemini", provider: "google", model: "gemini-3.1-pro-preview" },
    { id: "grok", provider: "xai", model: "grok-4.20-0309-reasoning" },
  ],
});

console.log("Spawned 4 models, waiting...\n");

const pollId = setInterval(() => {
  const s = council.getStatus();
  const elapsed = ((Date.now() - council.startedAt) / 1000).toFixed(0);
  const parts = s.members.map(m => {
    const tools = m.toolEvents?.length ?? 0;
    const out = m.output?.length ?? 0;
    const think = m.thinking?.length ?? 0;
    const st = m.state === "done" ? "✅" : "🔄";
    return `${st}${m.id}(o:${out} t:${think} tc:${tools})`;
  });
  console.log(`[${elapsed}s] ${parts.join("  ")}`);
}, 3000);

const timer = setTimeout(() => { council.cancel(); clearInterval(pollId); process.exit(1); }, 120_000);

const result = await council.waitForCompletion();
clearTimeout(timer);
clearInterval(pollId);

console.log("\n--- Final ---");
let ok = true;
for (const m of result.members) {
  const hasOutput = m.output.length > 0;
  const icon = m.state === "done" && hasOutput ? "✅" : m.state === "done" ? "⚠️" : "❌";
  console.log(`${icon} ${m.id}: output=${m.output.length} thinking=${m.thinking.length} tools=${m.toolEvents?.length ?? 0}`);
  if (m.output.includes("ppp}") || m.output.includes(">thought")) {
    console.error(`  ❌ LEAKED THINKING in ${m.id}`);
    ok = false;
  }
}
console.log(ok ? "\n✅ ALL CLEAN" : "\n❌ ISSUES FOUND");
process.exit(ok ? 0 : 1);
