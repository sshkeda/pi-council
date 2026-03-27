#!/usr/bin/env node
/**
 * Wrapper that runs mock-pi with a moderate delay.
 * Used for testing cancel/steer during active processing.
 * 500ms is enough to test timing without slowing the suite.
 */
process.env.MOCK_PI_DELAY_MS = "500";
await import(new URL("mock-pi.mjs", import.meta.url).href);
