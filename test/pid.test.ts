import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { pidAlive, isPiProcess } from "../src/util/pid.js";

describe("pidAlive", () => {
  it("returns true for own PID", () => {
    assert.equal(pidAlive(process.pid), true);
  });

  it("returns false for PID 0", () => {
    assert.equal(pidAlive(0), false);
  });

  it("returns false for negative PID", () => {
    assert.equal(pidAlive(-1), false);
  });

  it("returns false for NaN", () => {
    assert.equal(pidAlive(NaN), false);
  });

  it("returns false for Infinity", () => {
    assert.equal(pidAlive(Infinity), false);
  });

  it("returns false for very large PID (likely nonexistent)", () => {
    assert.equal(pidAlive(999999999), false);
  });
});

describe("isPiProcess", () => {
  it("returns true for own process (runs under node, which matches)", () => {
    // Our test process runs under node, which isPiProcess correctly identifies
    // as a potential pi agent process — this is the safe/conservative behavior
    assert.equal(isPiProcess(process.pid), true);
  });

  it("returns false for nonexistent PID", () => {
    assert.equal(isPiProcess(999999999), false);
  });

  it("returns false for invalid PID", () => {
    assert.equal(isPiProcess(-1), false);
    assert.equal(isPiProcess(0), false);
  });
});
