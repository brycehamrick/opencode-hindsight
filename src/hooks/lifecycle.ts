/**
 * Lifecycle write-back (MEMORY_PIPELINE_PLAN.md WS4).
 *
 * Idle-family signals are the only moment the COMPLETED exchange is readable:
 * the transcript a request was built from never contains the reply that
 * request produced, so every signal REFETCHES the authoritative transcript
 * (`ctx.session.context`) rather than trusting the event payload.
 *
 * Guarantees:
 *  - Bank isolation: `event.subscribe` is global across every project the
 *    host serves, and the envelope carries no location — only sessions our
 *    own scoped hooks admitted are eligible for retention, so another
 *    project's idle event can never re-point the bank.
 *  - One retain per exchange: retains are fire-and-forget from the event
 *    loop; the manager serializes per session and the growth gate skips
 *    unchanged transcripts, so `session.idle` + `session.execution.*` firing
 *    for the same turn costs one retain.
 *  - Graceful exit: cleanup waits (bounded) for in-flight retains so the
 *    session's final write survives the process.
 */

import type { MemoryManager } from "../memory/manager.js";
import { diag } from "../diag.js";
import {
  fetchSessionTranscript,
  normalizeMessages,
  normalizeMessagesWithToolCalls,
  resolveAgentName,
} from "./shared.js";

/** Events meaning "the assistant has finished; the completed exchange is
 * readable". `session.execution.*` also covers one-shot `opencode run`
 * sessions, which can exit before `session.idle` ever fires. */
const IDLE_EVENTS = new Set([
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

/** How long cleanup holds the host's exit for in-flight retains. */
const FLUSH_TIMEOUT_MS = 10_000;

export function registerLifecycle(
  ctx: any,
  memory: MemoryManager,
  ownSessions: Set<string>,
  ensureSessionWorkspace: (sessionID: unknown) => Promise<void>
): () => void {
  /** Write-backs started and not settled — what cleanup waits for. */
  const inFlight = new Set<Promise<void>>();

  const controller = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      try {
        const type = event?.type;
        const isClosed = type === "session.closed";
        if (!isClosed && !IDLE_EVENTS.has(type)) continue;

        const sessionId = event?.data?.sessionID ?? event?.properties?.sessionID ?? event?.sessionID;
        if (typeof sessionId !== "string" || !sessionId) continue;

        // HARD bank-isolation guard: never act on a session this plugin
        // instance did not admit (another project's idle event carries no
        // location to tell it apart).
        if (!ownSessions.has(sessionId)) {
          diag("idle_foreign_skipped", { signal: type, session: sessionId });
          continue;
        }

        diag("idle_signal", { signal: type, session: sessionId });
        // The workspace was resolved at admission; this re-points idempotently
        // for same-location sessions and never runs for foreign ones.
        await ensureSessionWorkspace(sessionId);

        // Refetch the authoritative transcript — the event payload predates
        // the reply. Fall back to the payload only when the host exposes no
        // transcript API.
        const raw = await fetchSessionTranscript(ctx, sessionId);
        const source = raw ?? event.messages;
        const messages = normalizeMessagesWithToolCalls(source) ?? normalizeMessages(source ?? []);
        if (!messages.length) continue;

        const write = memory
          .retainTurns(sessionId, messages, resolveAgentName(event), {
            finalFlush: isClosed,
          })
          .catch((error: unknown) => {
            diag("retain_failed", { session: sessionId, error: String(error), trigger: type });
          });
        inFlight.add(write);
        void write.finally(() => inFlight.delete(write));
      } catch (error) {
        // Fail open — do not crash the event stream.
        diag("retain_failed", { error: String(error) });
        console.error("[hindsight] Event hook error:", error);
      }
    }
  })();

  return () => {
    controller.abort();
    // Bounded flush: the final retain of a session must not be dropped with
    // the process, but a stalled server must not hold the exit open either.
    void (async () => {
      const timeout = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        timer.unref?.();
      });
      await Promise.race([Promise.allSettled([...inFlight]), timeout]);
    })();
  };
}
