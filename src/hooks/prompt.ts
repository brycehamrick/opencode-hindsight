/**
 * Prompt-admission injection channel (MEMORY_PIPELINE_PLAN.md WS1, Phase 2).
 *
 * `ctx.session.hook("prompt")` runs ONCE per admitted user prompt (synthetic
 * messages do not run it, so our own injection cannot recurse). The block is
 * delivered as a stored synthetic user message that lands just before the
 * admitted prompt, `resume: false` so it never starts a model run of its own.
 * Because it is stored in the turn it belongs to, every later request repeats
 * it byte for byte — the system prompt stays untouched and the provider's
 * prefix cache stays valid (the official plugin's #5914 lesson).
 *
 * Delivery is deliver-on-change: the model sees a synthetic message whenever
 * the frozen block's content changes (typically once per session), never a
 * repeat of bytes it already has. A channel that keeps failing on the host
 * (version skew, etc.) trips a circuit breaker after two consecutive delivery
 * failures and the context-hook fallback takes over for the process.
 */

import type { MemoryManager } from "../memory/manager.js";
import { diag } from "../diag.js";
import { resolveAgentName } from "./shared.js";

/** Consecutive synthetic-delivery failures before falling back to the
 * context-hook channel. */
const SYNTHETIC_FAILURE_LIMIT = 2;

export type InjectionChannel = "synthetic" | "system";

export interface ChannelState {
  channel: InjectionChannel;
}

/**
 * Register the prompt hook. Returns false — without touching anything — when
 * the host cannot support this channel (no ctx.session.synthetic, or the
 * prompt hook itself fails to register), leaving the caller on the
 * context-hook fallback.
 */
export async function registerPromptHook(
  ctx: any,
  memory: MemoryManager,
  ensureSessionWorkspace: (sessionID: unknown) => Promise<void>,
  channelState: ChannelState,
  ownSessions: Set<string>
): Promise<boolean> {
  if (typeof ctx.session?.synthetic !== "function") return false;

  /** SessionID -> the exact block text already delivered (dedupe repeats). */
  const delivered = new Map<string, string>();
  let deliveryFailures = 0;

  try {
    await ctx.session.hook("prompt", async (event: any) => {
      try {
        const sessionID = event?.sessionID;
        if (typeof sessionID !== "string" || !sessionID) return;

        // Admission always counts, whatever the channel — this set is the
        // bank-isolation guard's primary feeder (WS4), and after a
        // circuit-breaker fallback admissions must keep being tracked.
        ownSessions.add(sessionID);
        if (channelState.channel !== "synthetic") return;

        await ensureSessionWorkspace(sessionID);
        const prompt = typeof event?.prompt?.text === "string" ? event.prompt.text : "";
        await memory.injection.onPrompt({
          sessionId: sessionID,
          agent: resolveAgentName(event),
          prompt,
        });

        const block = memory.injection.peekBlock(sessionID);
        if (!block) return;
        if (delivered.get(sessionID) === block) return; // unchanged since delivery

        try {
          await ctx.session.synthetic({
            sessionID,
            text: block,
            description: "Hindsight memory",
            // Must never start a model run of its own.
            resume: false,
          });
          delivered.set(sessionID, block);
          diag("inject_deliver_ok", { session: sessionID, chars: block.length });
        } catch (error) {
          deliveryFailures++;
          diag("inject_deliver_failed", {
            session: sessionID,
            error: String(error),
            failures: deliveryFailures,
          });
          if (deliveryFailures >= SYNTHETIC_FAILURE_LIMIT) {
            // Circuit breaker: this host cannot deliver synthetic messages.
            // The context hook (always registered) takes over.
            channelState.channel = "system";
            diag("inject_channel_fallback", { failures: deliveryFailures });
          }
        }
      } catch (error) {
        // Fail open — an injection problem must never block a prompt.
        diag("prompt_hook_failed", { error: String(error) });
      }
    });
  } catch (error) {
    // The host rejected the hook registration itself (unknown hook name on an
    // older build) — stay on the fallback channel.
    diag("prompt_hook_register_failed", { error: String(error) });
    return false;
  }

  return true;
}
