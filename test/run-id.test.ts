import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { generateRunId } from "../src/util/run-id.js";

describe("generateRunId", () => {
  it("matches YYYYMMDD-HHMMSS-XXXX format", () => {
    const id = generateRunId();
    assert.match(id, /^\d{8}-\d{6}-[0-9a-f]{8}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateRunId()));
    assert.equal(ids.size, 50);
  });

  it("starts with a valid date", () => {
    const id = generateRunId();
    const datePart = id.split("-")[0];
    const year = parseInt(datePart.slice(0, 4));
    const month = parseInt(datePart.slice(4, 6));
    const day = parseInt(datePart.slice(6, 8));
    assert.ok(year >= 2024 && year <= 2100);
    assert.ok(month >= 1 && month <= 12);
    assert.ok(day >= 1 && day <= 31);
  });
});
