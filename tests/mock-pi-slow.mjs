#!/usr/bin/env node
/**
 * Wrapper that runs mock-pi with a long delay.
 * Used for testing cancel/steer during active processing.
 */
process.env.MOCK_PI_DELAY_MS = "2000";
const __dirname = new URL(".", import.meta.url).pathname;
await import(new URL("mock-pi.mjs", import.meta.url).href);
