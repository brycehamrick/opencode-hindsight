import type { MemoryManager } from "../memory/manager.js";
import type { Message } from "../types.js";

/**
 * Shared helpers for the session hooks (context fallback, prompt channel,
 * lifecycle write-back). Lives outside index.ts so every hook can use them
 * without an import cycle.
 */

/** Resolve the active agent name from whatever shape the host event carries. */
export function resolveAgentName(event: any): string | undefined {
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
 * Per-session workspace-directory resolution: OpenCode's background service
 * hosts sessions from many directories in one process, so each session must
 * re-point the manager's bank derivation at its own directory before memory
 * work. Cached per sessionID.
 */
export function createSessionWorkspaceResolver(ctx: any, memory: MemoryManager) {
  const sessionDirectories = new Map<string, string>();

  return async function ensureSessionWorkspace(sessionID: unknown): Promise<void> {
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
  };
}

/**
 * Find the latest user message and extract its text.
 *
 * Message content is either a plain string (older hosts) or an array of
 * content parts ({ type: "text", text }) in the current OpenCode/AI SDK
 * format, so normalize both.
 */
export function findLastUserMessageText(messages: any[] = []): string | undefined {
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

export function extractTextParts(parts: any): string {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p: any) => p.type === "text" || typeof p === "string")
    .map((p: any) => (typeof p === "string" ? p : p.text))
    .filter(Boolean)
    .join("\n");
}

/** Tools whose activity is pure plumbing; excluded from retained traces. */
const OPERATIONAL_TOOL_PARTS = new Set([
  "read", "write", "bash", "glob", "grep", "ls", "list", "cat",
  "sed", "awk", "find", "head", "tail", "process", "spawn",
]);

/**
 * Extract compact tool-call traces from raw host message parts.
 * Handles the tool-part shapes seen across opencode builds:
 * { type: "tool", tool, state: { input, title/status } } and legacy
 * { type: "toolCall", tool, input }. Returns undefined when the payload
 * carries no recognizable tool parts (older hosts), so callers can keep their
 * existing message normalization.
 */
function extractToolTraces(parts: any): { name: string; summary?: string; inputJson?: string }[] | undefined {
  if (!Array.isArray(parts)) return undefined;
  const traces: { name: string; summary?: string; inputJson?: string }[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "tool" || part.type === "toolCall") {
      const name = part.tool ?? part.name;
      if (typeof name !== "string" || !name) continue;
      if (OPERATIONAL_TOOL_PARTS.has(name)) continue;
      const state = part.state ?? {};
      const input = state.input ?? part.input;
      let inputJson: string | undefined;
      if (input != null) {
        try {
          inputJson = JSON.stringify(input);
        } catch {
          inputJson = undefined;
        }
      }
      traces.push({
        name,
        summary: typeof state.title === "string" ? state.title : undefined,
        inputJson,
      });
    }
  }
  return traces.length ? traces : undefined;
}

export function normalizeMessages(raw: any[]): Message[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((msg: any) => {
      const role = msg.info?.role ?? msg.role ?? "unknown";
      const content = extractTextParts(msg.parts ?? msg.content);
      return { role, content };
    })
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim()) as Message[];
}

/** Normalize and re-attach compact tool traces for retention. */
export function normalizeMessagesWithToolCalls(raw: any): Message[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const messages = normalizeMessages(raw);
  // normalizeMessages drops tool parts; re-attach traces by index for the
  // assistant messages that had them.
  for (let i = 0; i < raw.length && i < messages.length; i++) {
    const source = raw[i];
    if (!source || typeof source !== "object") continue;
    const role = source.info?.role ?? source.role;
    if (role !== "assistant") continue;
    const traces = extractToolTraces(source.parts ?? source.content);
    if (traces) messages[i].toolCalls = traces;
  }
  return messages;
}

/**
 * Refetch a session's CURRENT transcript from the host (WS4). The idle-event
 * payload predates the reply that just finished, so retention must read the
 * authoritative list. Prefers `ctx.session.context` (current v2), falling
 * back to legacy message APIs. Returns undefined when the host exposes none.
 */
export async function fetchSessionTranscript(ctx: any, sessionId: string): Promise<any[] | undefined> {
  try {
    if (typeof ctx.session?.context === "function") {
      const messages = await ctx.session.context({ sessionID: sessionId });
      if (Array.isArray(messages)) return messages;
    }
    if (typeof ctx.session?.messages === "function") {
      const response = await ctx.session.messages({ path: { id: sessionId } });
      const messages = response?.data ?? response;
      if (Array.isArray(messages)) return messages;
    }
    if (typeof ctx.session?.get === "function") {
      const response = await ctx.session.get({ sessionID: sessionId });
      const messages = response?.messages ?? response?.data?.messages;
      if (Array.isArray(messages)) return messages;
    }
  } catch {
    // Unreadable transcript — caller decides (event payload may still work).
  }
  return undefined;
}
