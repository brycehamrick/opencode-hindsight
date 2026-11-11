import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diag, diagFlush, diagFilePath, diagPreview } from "../../src/diag.js";

let dir: string;
let diagFile: string;
const originalEnv = process.env.HINDSIGHT_DIAG_FILE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hindsight-diag-test-"));
  diagFile = join(dir, "diagnostics.log");
  process.env.HINDSIGHT_DIAG_FILE = diagFile;
});

afterEach(async () => {
  await diagFlush();
  rmSync(dir, { recursive: true, force: true });
  if (originalEnv === undefined) delete process.env.HINDSIGHT_DIAG_FILE;
  else process.env.HINDSIGHT_DIAG_FILE = originalEnv;
});

function readLines(): Record<string, unknown>[] {
  const raw = readFileSync(diagFile, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("diag", () => {
  it("defaults to ~/.hindsight/diagnostics.log and honors HINDSIGHT_DIAG_FILE", () => {
    delete process.env.HINDSIGHT_DIAG_FILE;
    expect(diagFilePath()).toContain(join(".hindsight", "diagnostics.log"));
    process.env.HINDSIGHT_DIAG_FILE = diagFile;
    expect(diagFilePath()).toBe(diagFile);
  });

  it("writes one JSON object per line with a timestamp and the event", async () => {
    diag("recall_ok", { ms: 12, count: 3 });
    await diagFlush();

    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe("recall_ok");
    expect(lines[0].ms).toBe(12);
    expect(lines[0].count).toBe(3);
    expect(typeof lines[0].t).toBe("string");
    expect(new Date(lines[0].t as string).toString()).not.toBe("Invalid Date");
  });

  it("clips long string fields and collapses whitespace in previews", async () => {
    diag("reflect_ok", { answer: "x".repeat(5000) });
    diag("recall_ok", { query: diagPreview("line1\nline2\ttabbed") });
    await diagFlush();

    const [reflect, recall] = readLines();
    expect((reflect.answer as string).length).toBeLessThanOrEqual(2001);
    expect(recall.query).toBe("line1 line2 tabbed");
  });

  it("serializes Error values to name and message", async () => {
    diag("retain_failed", { error: new Error("ECONNREFUSED") });
    await diagFlush();

    const [line] = readLines();
    expect(line.error).toContain("Error: ECONNREFUSED");
  });

  it("never throws on an unwritable path", async () => {
    // A path whose parent is a regular file can never be created.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    process.env.HINDSIGHT_DIAG_FILE = join(blocker, "nested", "diagnostics.log");

    expect(() => diag("retain_ok", {})).not.toThrow();
    await diagFlush();
  });

  it("rotates to .1 once the file passes 1MB and keeps appending", async () => {
    // Pre-fill past the rotation threshold.
    writeFileSync(diagFile, "x".repeat(1_000_001));;

    diag("retain_ok", { docId: "after-rotate" });
    await diagFlush();

    expect(existsSync(`${diagFile}.1`)).toBe(true);
    expect(statSync(`${diagFile}.1`).size).toBe(1_000_001);
    const lines = readLines();
    expect(lines.at(-1)?.event).toBe("retain_ok");
    expect(lines.at(-1)?.docId).toBe("after-rotate");
  });

  it("drops undefined fields but keeps null and falsy values", async () => {
    diag("inject_empty", { chars: 0, note: null, gone: undefined });
    await diagFlush();

    const [line] = readLines();
    expect(line.chars).toBe(0);
    expect(line.note).toBeNull();
    expect("gone" in line).toBe(false);
  });

  it("writes events in the order they were recorded", async () => {
    // Regression: two concurrent fire-and-forget appends raced and could land
    // out of order, corrupting the log's timeline.
    for (let i = 0; i < 25; i++) diag("order_probe", { i });
    await diagFlush();

    const lines = readLines().filter((l) => l.event === "order_probe");
    expect(lines.map((l) => l.i)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });
});
