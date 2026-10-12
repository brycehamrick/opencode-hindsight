import type { Message, RecallResult } from "../types.js";
import type { MemoryManager } from "../memory/manager.js";
import { formatMemoryContext } from "../memory/content.js";

export async function registerHooks(ctx: any, memory: MemoryManager): Promise<() => void> {
  // Cache per-message recall results keyed by the latest user message content.
  const recallCache = new Map<string, RecallResult[]>();
  // Cache sessionID -> workspace directory so each session's bank derivation
  // uses the directory the session actually runs in.
  const sessionDirectories = new Map<string, string>();

  async function ensureSessionWorkspace(sessionID: unknown): Promise<void> {
    if (typeof sessionID !== "string" || !sessionID) return;
    if (sessionDirectories.has(sessionID)) {
      memory.setWorkspaceDirectory(sessionDirectories.get(sessionID)!);
      return;
    }
    try {
      const session = await ctx.session?.get?.({ sessionID });
      const directory = session?.location?.directory;
      if (typeof directory === "string" && directory.trim()) {
        sessionDirectories.set(sessionID, directory);
        // Cap cache size.
        if (sessionDirectories.size > 500) {
          const first = sessionDirectories.keys().next().value;
          if (first) sessionDirectories.delete(first);
        }
        memory.setWorkspaceDirectory(directory);
      }
    } catch {
      // Fail open — keep the existing workspace directory.
    }
  }

  // Per-message recall + core memory.
  await ctx.session.hook("context", async (event: any) => {
    try {
      await ensureSessionWorkspace(event.sessionID);
      const agentName = resolveAgentName(event);
      const lastUserText = findLastUserMessageText(event.messages);
      // Normalize host messages (string or content-parts formats) into the
      // plugin's internal { role, content } shape for recall composition.
      const messages = normalizeMessages(event.messages ?? []);

      // Always inject core memory (small, stable facts).
      const core = await memory.getCoreMemories(agentName);

      // On-demand recall for the current user message.
      let recalled: RecallResult[] = [];
      if (lastUserText) {
        const key = `${agentName}:${lastUserText}`;
        const cached = recallCache.get(key);
        if (cached) {
          recalled = cached;
        } else {
          recalled = await memory.recallForMessage(lastUserText, messages, agentName);
          recallCache.set(key, recalled);
          // Cap cache size.
          if (recallCache.size > 100) {
            const first = recallCache.keys().next().value;
            if (first) recallCache.delete(first);
          }
        }
      }

      // Dedupe recalled results against core memory.
      const coreTexts = new Set(core.map((m) => m.text.trim().toLowerCase()));
      const uniqueRecalled = recalled.filter((m) => !coreTexts.has(m.text.trim().toLowerCase()));

      const contextText = formatMemoryContext([...core, ...uniqueRecalled], {
        preamble:
          "Relevant memories from past conversations (prioritize recent when conflicting). " +
          "Only use memories that are directly useful; ignore the rest.",
        maxTokens: event.budget?.memory ?? 768,
      });

      // OpenCode's system parts are structured values ({ type: "text", text }),
      // not raw strings — pushing a bare string fails host-side validation.
      if (contextText && Array.isArray(event.system)) {
        event.system.push({ type: "text", text: contextText });
      }
    } catch (error) {
      // Fail open so OpenCode keeps working even if Hindsight is down.
      console.error("[hindsight] Context hook error:", error);
    }
  });

  // Idle / session end retention.
  const controller = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      try {
        if (event.type === "session.idle" || event.type === "session.closed") {
          const sessionId = event.properties?.sessionID ?? event.sessionID;
          if (!sessionId) continue;

          await ensureSessionWorkspace(sessionId);
          const messages = event.messages ?? (await getSessionMessages(ctx, sessionId));
          if (messages.length) {
            const agentName = resolveAgentName(event);
            await memory.retainTurns(sessionId, messages, agentName);
          }
        }
      } catch (error) {
        // Fail open — do not crash the event stream.
        console.error("[hindsight] Event hook error:", error);
      }
    }
  })();

  return () => controller.abort();
}

function resolveAgentName(event: any): string | undefined {
  // OpenCode passes the agent as a branded string ID on session context
  // events; older/other events may carry an object or agentID field.
  if (typeof event?.agent === "string") return event.agent;
  return (
    event.agent?.id ??
    event.session?.agent?.id ??
    event.agentID ??
    event.agentName ??
    undefined
  );
}

/**
 * Find the latest user message and extract its text.
 *
 * Message content is either a plain string (older hosts) or an array of
 * content parts ({ type: "text", text }) in the current OpenCode/AI SDK
 * format, so normalize both.
 */
function findLastUserMessageText(messages: any[] = []): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const text = messageText(message);
    if (text.trim()) return text;
  }
  return undefined;
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  return extractTextParts(content ?? message?.parts);
}

async function getSessionMessages(
  ctx: any,
  sessionId: string
): Promise<Message[]> {
  // Best-effort retrieval of session messages for retention.
  // V2 may expose messages via ctx.session.messages, ctx.session.get, or event payloads.
  try {
    if (typeof ctx.session?.messages === "function") {
      const response = await ctx.session.messages({ path: { id: sessionId } });
      return normalizeMessages(response.data ?? response);
    }
    if (typeof ctx.session?.get === "function") {
      const response = await ctx.session.get({ sessionID: sessionId });
      return normalizeMessages(response.messages ?? response.data?.messages ?? []);
    }
  } catch {
    // Fall through to empty.
  }
  return [];
}

function normalizeMessages(raw: any[]): Message[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((msg: any) => {
      const role = msg.info?.role ?? msg.role ?? "unknown";
      const content = extractTextParts(msg.parts ?? msg.content);
      return { role, content };
    })
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim()) as Message[];
}

function extractTextParts(parts: any): string {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p: any) => p.type === "text" || typeof p === "string")
    .map((p: any) => (typeof p === "string" ? p : p.text))
    .filter(Boolean)
    .join("\n");
}
