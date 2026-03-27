#!/usr/bin/env node
/**
 * Wrapper that runs mock-pi with MOCK_PI_FAIL=true.
 * Used for testing crash handling through the Council class.
 */
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockPi = path.join(__dirname, "mock-pi.mjs");

// Re-exec mock-pi with the crash flag
process.env.MOCK_PI_FAIL = "true";
await import(mockPi);
