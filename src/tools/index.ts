import type { MemoryManager } from "../memory/manager.js";
import { formatMemories, formatCurrentTime } from "../memory/content.js";

const NAMESPACE = "hindsight";

export async function registerTools(ctx: any, memory: MemoryManager): Promise<void> {
  // Tools execute within a session; make bank derivation follow that
  // session's directory before touching memory.
  async function ensureWorkspace(sessionID: unknown): Promise<void> {
    if (typeof sessionID !== "string" || !sessionID) return;
    try {
      const session = await ctx.session?.get?.({ sessionID });
      const directory = session?.location?.directory;
      if (typeof directory === "string") memory.setWorkspaceDirectory(directory);
    } catch {
      // Fail open — keep the current workspace directory.
    }
  }

  await ctx.tool.transform((draft: any) => {
    draft.add({
      name: "hindsight_retain",
      description:
        "Store a fact, decision, user preference, or other useful information in long-term memory.",
      input: {
        type: "object",
        properties: {
          content: { type: "string", description: "The information to remember." },
          context: { type: "string", description: "Optional source/context." },
          tags: { type: "array", items: { type: "string" } },
          agent: { type: "string", description: "Optional agent scope. Defaults to the active agent." },
        },
        required: ["content"],
        additionalProperties: false,
      },
      options: { namespace: NAMESPACE, codemode: true },
      execute: async (input: { content: string; context?: string; tags?: string[]; agent?: string }, toolCtx?: { sessionID?: string }) => {
        await ensureWorkspace(toolCtx?.sessionID);
        await memory.retainFact(
          input.content,
          input.context,
          undefined,
          input.tags,
          input.agent
        );
        return { content: "Memory stored." };
      },
    });

    draft.add({
      name: "hindsight_recall",
      description:
        "Search long-term memory for relevant context. Use proactively when a question might depend on prior work.",
      input: {
        type: "object",
        properties: {
          query: { type: "string" },
          maxTokens: { type: "number" },
          agent: { type: "string", description: "Optional agent scope. Defaults to the active agent." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      options: { namespace: NAMESPACE, codemode: true },
      execute: async (input: { query: string; maxTokens?: number; agent?: string }, toolCtx?: { sessionID?: string }) => {
        await ensureWorkspace(toolCtx?.sessionID);
        const results = await memory.recallByQuery(input.query, input.maxTokens, input.agent);
        if (!results.length) return { content: "No relevant memories found." };
        const formatted = formatMemories(results);
        return {
          content: `Found ${results.length} relevant memories (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
        };
      },
    });

    draft.add({
      name: "hindsight_reflect",
      description: "Synthesize a thoughtful answer from long-term memory.",
      input: {
        type: "object",
        properties: {
          query: { type: "string" },
          context: { type: "string" },
          agent: { type: "string", description: "Optional agent scope. Defaults to the active agent." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      options: { namespace: NAMESPACE, codemode: true },
      execute: async (input: { query: string; context?: string; agent?: string }, toolCtx?: { sessionID?: string }) => {
        await ensureWorkspace(toolCtx?.sessionID);
        const answer = await memory.reflect(input.query, input.context, input.agent);
        return { content: answer };
      },
    });

    draft.add({
      name: "hindsight_forget",
      description: "Remove an outdated or incorrect memory by document ID or query.",
      input: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "Exact document ID to delete." },
          query: { type: "string", description: "Query to select memories to delete (if supported)." },
          agent: { type: "string", description: "Optional agent scope. Defaults to the active agent." },
        },
        additionalProperties: false,
      },
      options: { namespace: NAMESPACE, codemode: true },
      execute: async (input: { documentId?: string; query?: string; agent?: string }, toolCtx?: { sessionID?: string }) => {
        await ensureWorkspace(toolCtx?.sessionID);
        const ok = await memory.forget(input.documentId, input.query, input.agent);
        return { content: ok ? "Memory removed." : "Could not remove memory (unsupported or not found)." };
      },
    });

    draft.add({
      name: "hindsight_status",
      description: "Show Hindsight plugin diagnostics: resolved workspace directory and current memory bank.",
      input: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Optional agent scope. Defaults to the active agent." },
        },
        additionalProperties: false,
      },
      options: { namespace: NAMESPACE, codemode: true },
      execute: async (input: { agent?: string }, toolCtx?: { sessionID?: string }) => {
        await ensureWorkspace(toolCtx?.sessionID);
        const diag = memory.getDiagnostics(input.agent);
        return {
          content: `Hindsight diagnostics:\n- Workspace directory: ${diag.directory}\n- Memory bank: ${diag.bankId}\n- Agent: ${diag.agent}`,
        };
      },
    });
  });
}
