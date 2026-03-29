#!/usr/bin/env node

/**
 * E2E streaming test — spawns REAL models, checks intermediate output
 * is clean (no thinking tokens leaked), verifies final result.
 *
 * Uses the Council API directly (not CLI) so we get in-process streaming.
 */

import { Council } from "../dist/src/core/council.js";

const TIMEOUT_MS = 90_000;
let failed = false;

function assert(cond, msg) {
  if (!cond) {
    console.error(`  ❌ FAIL: ${msg}`);
    failed = true;
  } else {
    console.log(`  ✅ ${msg}`);
  }
}

console.log("\n🔬 E2E Streaming Test (real models)\n");

const council = new Council("What is 2+2? Answer in exactly one sentence.");

// Track ALL events for observability
const events = [];
const outputSnapshots = new Map(); // memberId -> [{ time, len, preview }]
const thinkingSnapshots = new Map();

council.on((event) => {
  events.push({ type: event.type, time: Date.now(), memberId: event.memberId });

  if (event.type === "member_output") {
    const member = council.getMember(event.memberId);
    if (member) {
      const status = member.getStatus();
      if (!outputSnapshots.has(event.memberId)) outputSnapshots.set(event.memberId, []);
      outputSnapshots.get(event.memberId).push({
        time: Date.now(),
        len: status.output.length,
        preview: status.output.slice(0, 80),
      });
    }
  }

  if (event.type === "member_done" || event.type === "member_failed") {
    const member = council.getMember(event.memberId);
    if (member) {
      const s = member.getStatus();
      const dur = s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : "?";
      const icon = s.state === "done" ? "✅" : "❌";
      console.log(`\n${icon} ${s.id} (${dur}) — output: ${s.output.length} chars, thinking: ${s.thinking.length} chars`);
      if (s.output) console.log(`  output: "${s.output.slice(0, 120)}"`);
      if (s.thinking) console.log(`  thinking preview: "${s.thinking.slice(0, 120)}"`);
      if (s.error) console.log(`  error: ${s.error}`);
    }
  }
});

// Spawn with 2 models for speed (Claude + Gemini covers the thinking issue)
council.spawn({
  models: [
    { id: "claude", provider: "anthropic", model: "claude-opus-4-6" },
    { id: "gemini", provider: "google", model: "gemini-3.1-pro-preview" },
  ],
});

console.log("Spawned: claude, gemini");
console.log("Waiting for completion...\n");

// Poll status every 2s for observability
const pollInterval = setInterval(() => {
  const status = council.getStatus();
  const elapsed = ((Date.now() - council.startedAt) / 1000).toFixed(0);
  const memberSummary = status.members.map(m => {
    const icon = m.state === "done" ? "✅" : m.state === "failed" ? "❌" : "🔄";
    const out = m.output ? `out:${m.output.length}` : "out:0";
    const think = m.thinking ? `think:${m.thinking.length}` : "";
    return `${icon}${m.id}(${out}${think ? " " + think : ""})`;
  }).join("  ");
  console.log(`  [${elapsed}s] ${memberSummary}`);
}, 2000);

// Wait for completion with timeout
const timer = setTimeout(() => {
  console.error(`\n⏰ TIMEOUT after ${TIMEOUT_MS / 1000}s`);
  council.cancel();
  clearInterval(pollInterval);
  process.exit(1);
}, TIMEOUT_MS);

const result = await council.waitForCompletion();
clearTimeout(timer);
clearInterval(pollInterval);

console.log(`\n── Assertions ──`);

// 1. All members completed
assert(result.members.every(m => m.state === "done"), "all members done");

// 2. All members have output
for (const m of result.members) {
  assert(m.output.length > 0, `${m.id} has output (${m.output.length} chars)`);
}

// 3. No thinking tokens leaked into output
for (const m of result.members) {
  assert(!m.output.includes("ppp}"), `${m.id} output has no ppp} garbage`);
  assert(!m.output.match(/^\.{3,}/m), `${m.id} output has no ... spam`);
  assert(!m.output.includes(">thought"), `${m.id} output has no >thought marker`);
  assert(!m.output.includes("CRITICAL INSTRUCTION"), `${m.id} output has no leaked system prompt`);
}

// 4. Thinking is stored separately if present
for (const m of result.members) {
  if (m.thinking.length > 0) {
    assert(!m.output.includes(m.thinking.slice(0, 50)), `${m.id} thinking not duplicated in output`);
  }
}

// 5. Intermediate streaming was clean (check snapshots)
for (const [memberId, snaps] of outputSnapshots) {
  for (const snap of snaps) {
    assert(!snap.preview.includes("ppp}"), `${memberId} streaming snapshot clean (no ppp})`);
    assert(!snap.preview.includes(">thought"), `${memberId} streaming snapshot clean (no >thought)`);
  }
}

// 6. JSON artifacts exist and have thinking field
import * as fs from "node:fs";
import * as path from "node:path";
for (const m of result.members) {
  const jsonPath = path.join(council.getRunDir(), `${m.id}.json`);
  assert(fs.existsSync(jsonPath), `${m.id}.json exists`);
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  assert("thinking" in data, `${m.id}.json has thinking field`);
  assert("output" in data, `${m.id}.json has output field`);
}

console.log(`\n📊 Events: ${events.length} total`);
console.log(`   member_output: ${events.filter(e => e.type === "member_output").length}`);
console.log(`   member_done: ${events.filter(e => e.type === "member_done").length}`);
console.log(`   member_started: ${events.filter(e => e.type === "member_started").length}`);

if (failed) {
  console.error("\n💥 SOME ASSERTIONS FAILED");
  process.exit(1);
} else {
  console.log("\n✅ ALL PASSED");
  process.exit(0);
}
