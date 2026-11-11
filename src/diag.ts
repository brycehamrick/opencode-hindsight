/**
 * JSONL diagnostics — the durable record of what the memory pipeline did.
 *
 * Every outcome is recorded so a memory-less session is distinguishable from a
 * healthy one: a failed reflect, an empty recall, a dropped retain each get a
 * line here even when the plugin fails open and the agent keeps working.
 *
 * The log is append-only JSONL at ~/.hindsight/diagnostics.log (override with
 * HINDSIGHT_DIAG_FILE), rotated to `.1` at ~1MB. Writes are fire-and-forget
 * and never throw — diagnostics must not be able to break the plugin.
 */

import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Rotate the log once it passes this size. */
const ROTATE_BYTES = 1_000_000;
/** Cap any single string field so an injected answer or error body cannot
 * balloon the log. */
const MAX_FIELD_CHARS = 2_000;
/** Default preview length for query/text fields. */
const PREVIEW_CHARS = 120;

/** In-flight writes — what diagFlush() waits on. */
const pending = new Set<Promise<void>>();
/** Serializes rotation so concurrent events cannot lose a line to it. */
let rotating: Promise<void> | null = null;
/**
 * FIFO write queue — appends must land in the order the events happened, or
 * the log's timeline (ms timings, failure-then-fallback sequences) lies.
 * Two concurrent appendFile calls are not order-preserving.
 */
let writeQueue: Promise<void> = Promise.resolve();

/** Resolve the diagnostics file path (HINDSIGHT_DIAG_FILE wins). */
export function diagFilePath(): string {
  const fromEnv = process.env.HINDSIGHT_DIAG_FILE?.trim();
  return fromEnv || join(homedir(), ".hindsight", "diagnostics.log");
}

/** Clip a string for a diag field. */
export function diagPreview(text: string, chars = PREVIEW_CHARS): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > chars ? `${compact.slice(0, chars)}…` : compact;
}

/**
 * Record one diagnostics event. Never throws, never blocks the caller.
 *
 * Fields: strings are clipped, Errors become {name, message}, other values are
 * JSON-encoded (and clipped) so the line stays one parseable JSON object.
 */
export function diag(event: string, fields: Record<string, unknown> = {}): void {
  let line: string;
  try {
    line = JSON.stringify({ t: new Date().toISOString(), event, ...sanitizeFields(fields) });
  } catch {
    return; // a diagnostics failure must never surface in the plugin
  }
  const path = diagFilePath();
  const write = enqueue(() => writeLine(path, line));
  pending.add(write);
  void write.finally(() => pending.delete(write));
}

/** Queue an append behind earlier ones; the returned promise settles when the
 * line has been written (or dropped). */
function enqueue(op: () => Promise<void>): Promise<void> {
  const next = writeQueue.then(op, op);
  writeQueue = next.catch(() => {});
  return next;
}

/**
 * Wait for every diagnostics write still in flight (bounded by the writes
 * themselves — they fail open). Called on plugin shutdown so the last events
 * of a session are not dropped with the process.
 */
export async function diagFlush(): Promise<void> {
  while (pending.size) {
    await Promise.allSettled([...pending]);
  }
}

async function writeLine(path: string, line: string): Promise<void> {
  try {
    await maybeRotate(path);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${line}\n`, "utf8");
  } catch {
    // Unwritable path, vanished directory, disk full — drop the line.
  }
}

async function maybeRotate(path: string): Promise<void> {
  if (rotating) await rotating;
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return; // no file yet — the append creates it
  }
  if (size <= ROTATE_BYTES) return;
  let release: () => void;
  rotating = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await rm(`${path}.1`, { force: true });
    await rename(path, `${path}.1`);
  } catch {
    // Rotation failed — keep appending to the oversized file rather than
    // losing lines.
  } finally {
    release!();
    rotating = null;
  }
}

function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = sanitizeValue(value);
  }
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return clip(value);
  if (value instanceof Error) {
    return clip(`${value.name}: ${value.message}`);
  }
  if (typeof value === "object" && value !== null) {
    try {
      return clip(JSON.stringify(value));
    } catch {
      return "[unserializable]";
    }
  }
  return value;
}

function clip(text: string): string {
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…` : text;
}
