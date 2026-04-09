#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { createMock, always } from "../../pi-mock/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, "../dist/extensions/pi-council/index.js");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`  ❌ ${name}: ${err.message}\n`);
    if (process.env.DEBUG) console.error(err.stack);
  }
}

process.stdout.write("\n🧪 UI Ownership Tests\n\n");

await test("U1: non-UI synthetic invocation does not become widget owner", async () => {
  const mock = await createMock({
    brain: always("ok"),
    extensions: [EXTENSION_PATH],
  });

  try {
    const bg = await mock.invokeTool("spawn_council", {
      action: "set",
      runId: "bg-run",
      question: "Background council",
      label: "bg",
      members: [{ id: "claude", state: "running" }],
    }, {
      hasUI: false,
      sessionId: "bg-session",
      invocationId: "bg-inv",
    });

    assert(bg.ok === true, "synthetic call succeeded");
    assert(bg.widgets.length === 0, `background-only invocation should not emit widget, got ${bg.widgets.length}`);
    assert(mock.widgets.filter(w => w.key === "pi-council").length === 0, "no global pi-council widget without an interactive owner");
  } finally {
    await mock.close();
  }
});

await test("U2: later interactive synthetic invocation becomes owner and renders all active rows", async () => {
  const mock = await createMock({
    brain: always("ok"),
    extensions: [EXTENSION_PATH],
  });

  try {
    await mock.invokeTool("spawn_council", {
      action: "set",
      runId: "bg-run",
      question: "Background council",
      label: "bg",
      members: [{ id: "claude", state: "running" }],
    }, {
      hasUI: false,
      sessionId: "bg-session",
      invocationId: "bg-inv",
    });

    const ui = await mock.invokeTool("spawn_council", {
      action: "set",
      runId: "ui-run",
      question: "Interactive council",
      label: "ui",
      members: [{ id: "gpt", state: "running" }],
    }, {
      hasUI: true,
      sessionId: "ui-session",
      invocationId: "ui-inv",
    });

    assert(ui.ok === true, "interactive call succeeded");
    const latest = ui.widgets.at(-1);
    assert(latest, "interactive invocation emitted widget update");
    assert(latest.key === "pi-council", `widget key: ${latest.key}`);
    assert(latest.origin?.source === "synthetic-tool", `origin source: ${latest.origin?.source}`);
    assert(latest.origin?.sessionId === "ui-session", `owner session: ${latest.origin?.sessionId}`);
    assert(latest.origin?.invocationId === "ui-inv", `owner invocation: ${latest.origin?.invocationId}`);
    assert(latest.origin?.hasUI === true, `owner hasUI: ${latest.origin?.hasUI}`);
    assert(latest.origin?.toolName === "spawn_council", `toolName: ${latest.origin?.toolName}`);
    assert(latest.lines?.some(l => l.includes("bg")), `widget contains background row: ${JSON.stringify(latest.lines)}`);
    assert(latest.lines?.some(l => l.includes("ui")), `widget contains interactive row: ${JSON.stringify(latest.lines)}`);
  } finally {
    await mock.close();
  }
});

await test("U3: later non-UI synthetic updates route through existing interactive owner", async () => {
  const mock = await createMock({
    brain: always("ok"),
    extensions: [EXTENSION_PATH],
  });

  try {
    await mock.invokeTool("spawn_council", {
      action: "set",
      runId: "ui-run",
      question: "Interactive council",
      label: "ui",
      members: [{ id: "claude", state: "running" }],
    }, {
      hasUI: true,
      sessionId: "ui-session",
      invocationId: "ui-inv",
    });

    const bgLater = await mock.invokeTool("spawn_council", {
      action: "set",
      runId: "bg-later-run",
      question: "Later background council",
      label: "later-bg",
      members: [{ id: "gpt", state: "running" }],
    }, {
      hasUI: false,
      sessionId: "bg-later-session",
      invocationId: "bg-later-inv",
    });

    assert(bgLater.ok === true, "background update succeeded");
    const latest = bgLater.widgets.at(-1);
    assert(latest, "background update still emitted widget through interactive owner");
    assert(latest.key === "pi-council", `widget key: ${latest.key}`);
    assert(latest.origin?.sessionId === "ui-session", `owner session: ${latest.origin?.sessionId}`);
    assert(latest.origin?.invocationId === "ui-inv", `owner invocation: ${latest.origin?.invocationId}`);
    assert(latest.origin?.hasUI === true, `owner hasUI: ${latest.origin?.hasUI}`);
    assert(latest.origin?.sessionId !== "bg-later-session", "did not route through background session");
    assert(latest.origin?.invocationId !== "bg-later-inv", "did not route through background invocation");
    assert(latest.lines?.some(l => l.includes("later-bg")), `widget contains later background row: ${JSON.stringify(latest.lines)}`);
  } finally {
    await mock.close();
  }
});

await test("U4: clear routes through interactive owner and removes final widget row", async () => {
  const mock = await createMock({
    brain: always("ok"),
    extensions: [EXTENSION_PATH],
  });

  try {
    await mock.invokeTool("spawn_council", {
      action: "set",
      runId: "ui-run",
      question: "Interactive council",
      label: "ui",
      members: [{ id: "claude", state: "running" }],
    }, {
      hasUI: true,
      sessionId: "ui-session",
      invocationId: "ui-inv",
    });

    const cleared = await mock.invokeTool("spawn_council", {
      action: "clear",
      runId: "ui-run",
    }, {
      hasUI: false,
      sessionId: "bg-session",
      invocationId: "bg-clear-inv",
    });

    assert(cleared.ok === true, "clear succeeded");
    const latest = cleared.widgets.at(-1);
    assert(latest, "clear emitted widget update");
    assert(latest.origin?.sessionId === "ui-session", `owner session: ${latest.origin?.sessionId}`);
    assert(latest.origin?.invocationId === "ui-inv", `owner invocation: ${latest.origin?.invocationId}`);
    assert(latest.origin?.hasUI === true, `owner hasUI: ${latest.origin?.hasUI}`);
    assert(latest.lines === undefined, `widget cleared, got ${JSON.stringify(latest.lines)}`);
  } finally {
    await mock.close();
  }
});

process.stdout.write(`\n📊 UI Ownership: ${passed} passed, ${failed} failed out of ${passed + failed}\n\n`);
process.exit(failed > 0 ? 1 : 0);
