/**
 * Hook registration (MEMORY_PIPELINE_PLAN.md WS1/WS4/WS6).
 *
 * Wires the injection channel (prompt-admission + synthetic message, with the
 * context-hook fallback), the compaction hook, and the lifecycle write-back,
 * and owns the `ownSessions` admission set that keeps the GLOBAL event stream
 * from ever acting on another project's sessions.
 */

import type { MemoryManager } from "../memory/manager.js";
import { diag, diagFlush } from "../diag.js";
import { registerPromptHook, type ChannelState } from "./prompt.js";
import { registerLifecycle } from "./lifecycle.js";
import {
  createSessionWorkspaceResolver,
  findLastUserMessageText,
  normalizeMessages,
  normalizeMessagesWithToolCalls,
  resolveAgentName,
} from "./shared.js";

export async function registerHooks(ctx: any, memory: MemoryManager): Promise<() => void> {
  const ensureSessionWorkspace = createSessionWorkspaceResolver(ctx, memory);
  /**
   * Sessions THIS plugin instance owns. `event.subscribe` is global across
   * every project the host serves and its envelopes carry no location, so
   * only sessions admitted by our own scoped hooks are eligible for
   * write-back — the hard bank-isolation guard (WS4).
   */
  const ownSessions = new Set<string>();

  // Injection channel (WS1): "synthetic" (prompt-admission + stored synthetic
  // message — system prompt untouched, prefix cache preserved) with a
  // circuit-breaker fallback to "system" (context hook + frozen block, the
  // Phase-1 channel) for hosts that cannot deliver synthetic messages.
  const channelState: ChannelState = { channel: "system" };
  const promptWired = await registerPromptHook(
    ctx,
    memory,
    ensureSessionWorkspace,
    channelState,
    ownSessions
  );
  if (promptWired) channelState.channel = "synthetic";
  diag("inject_channel", { channel: channelState.channel });

  // Context-hook channel: admits every session it serves (the guard's other
  // feeder) and pushes the frozen block ONLY when the synthetic channel is
  // not active — it must never duplicate a block already delivered as a
  // stored message.
  await ctx.session.hook("context", async (event: any) => {
    try {
      if (typeof event?.sessionID === "string" && event.sessionID) {
        ownSessions.add(event.sessionID);
      }
      if (channelState.channel !== "system") return;
      await ensureSessionWorkspace(event.sessionID);
      const agentName = resolveAgentName(event);
      const lastUserText = findLastUserMessageText(event.messages);
      // Normalize host messages (string or content-parts formats) into the
      // plugin's internal { role, content } shape for recall composition.
      const messages = normalizeMessages(event.messages ?? []);

      const block = await memory.injection.onModelCall({
        sessionId: event.sessionID,
        agent: agentName,
        prompt: lastUserText,
        messages,
        budgetTokens: event.budget?.memory,
      });

      // OpenCode's system parts are structured values ({ type: "text", text }),
      // not raw strings — pushing a bare string fails host-side validation.
      if (block && Array.isArray(event.system)) {
        event.system.push({ type: "text", text: block });
      }
    } catch (error) {
      // Fail open so OpenCode keeps working even if Hindsight is down.
      diag("context_hook_failed", { error: String(error) });
      console.error("[hindsight] Context hook error:", error);
    }
  });

  // Compaction hook (WS6): checkpoint summaries are their own request kind —
  // retain any pending turns first (already onCompaction's first step), then
  // inject a short recall so the summary keeps the session's memory context.
  await ctx.session.hook("compaction", async (event: any) => {
    try {
      if (typeof event?.sessionID === "string" && event.sessionID) {
        ownSessions.add(event.sessionID);
      }
      await ensureSessionWorkspace(event.sessionID);
      const messages = normalizeMessagesWithToolCalls(event.messages) ?? normalizeMessages(event.messages ?? []);
      const context = await memory.onCompaction(event.sessionID, messages, resolveAgentName(event));
      if (context && Array.isArray(event.system)) {
        event.system.push({ type: "text", text: context });
        diag("compaction_inject", { session: event.sessionID, chars: context.length });
      }
    } catch (error) {
      // Fail open — compaction must proceed even if memory is unreachable.
      diag("compaction_hook_failed", { error: String(error) });
    }
  });

  // Lifecycle write-back (WS4): idle-family signals refetch the authoritative
  // transcript; bank isolation via ownSessions; fire-and-forget retains with
  // a bounded flush on cleanup.
  const lifecycleCleanup = registerLifecycle(ctx, memory, ownSessions, ensureSessionWorkspace);

  return () => {
    lifecycleCleanup();
    // Last diagnostics lines of a session should survive the process.
    void diagFlush();
  };
}
