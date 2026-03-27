#!/usr/bin/env node
/**
 * Wrapper that runs mock-pi with tool calls enabled.
 * Used for testing tool execution event pipeline.
 */
process.env.MOCK_PI_TOOL_CALLS = "true";
process.env.MOCK_PI_DELAY_MS = "20";
await import(new URL("mock-pi.mjs", import.meta.url).href);
