import type { Message, PluginState, SessionState } from "../types.js";
import type { Logger } from "../logger.js";
import type { HindsightConfig } from "../config.js";
import type { HindsightClientWrapper, RetainOptions } from "./client.js";
import { diag } from "../diag.js";
import {
  sanitizeForRetention,
  sliceLastTurnsByUserBoundary,
  stripMemoryTags,
  formatToolTrace,
} from "./content.js";

export interface RetentionEngine {
  retainFact(
    fact: string,
    context?: string,
    metadata?: Record<string, string>,
    tags?: string[]
  ): Promise<void>;
  retainTurns(
    sessionId: string,
    turns: Message[],
    state: SessionState,
    options?: { finalFlush?: boolean }
  ): Promise<SessionState>;
  flushFinalTurns(sessionId: string, turns: Message[], state: SessionState): Promise<SessionState>;
  deleteByDocumentId(documentId: string): Promise<boolean>;
  deleteByQuery(query: string): Promise<boolean>;
}

export function createRetentionEngine(
  client: HindsightClientWrapper,
  bankId: string,
  config: HindsightConfig,
  logger: Logger
): RetentionEngine {
  const pendingRetains = new Set<string>();

  /**
   * client.retain + diagnostics. Every successful write gets a retain_ok line
   * so the log answers "what did the plugin actually store" without server
   * access; failures propagate to the caller's fail-open handling.
   */
  async function retainTracked(
    content: string,
    options: RetainOptions,
    sessionId?: string
  ): Promise<void> {
    const startedAt = Date.now();
    await client.retain(bankId, content, options);
    diag("retain_ok", {
      ms: Date.now() - startedAt,
      chars: content.length,
      docId: options.documentId,
      session: sessionId,
    });
  }

  async function retainFact(
    fact: string,
    context?: string,
    metadata: Record<string, string> = {},
    tags?: string[]
  ): Promise<void> {
    const content = sanitizeForRetention(fact, {
      stripSecrets: config.stripSecrets,
      stripBase64: config.stripBase64,
      maxLength: config.maxRetainedMessageLength,
    });
    if (!content) {
      logger.debug("Skipping empty fact after sanitization");
      return;
    }

    const documentId = `fact-${hashContent(content)}`;
    const key = `${bankId}:${documentId}`;
    if (pendingRetains.has(key)) {
      logger.debug("Skipping duplicate in-flight fact retain", { documentId });
      return;
    }
    pendingRetains.add(key);

    try {
      await retainTracked(
        content,
        {
          context: context || config.retainContext,
          documentId,
          tags: [...config.retainTags, "fact", "tool", ...(tags ?? [])],
          metadata: { ...config.retainMetadata, ...metadata },
          async: true,
        }
      );
      logger.debug("Retained fact", { documentId, length: content.length });
    } finally {
      pendingRetains.delete(key);
    }
  }

  async function retainTurns(
    sessionId: string,
    turns: Message[],
    state: SessionState,
    options?: { finalFlush?: boolean }
  ): Promise<SessionState> {
    if (!config.autoRetain || config.retainMode === "none" || !turns.length) {
      return state;
    }

    if (options?.finalFlush) {
      return await flushFinalTurns(sessionId, turns, state);
    }

    if (config.retainMode === "facts") {
      return await retainFactsFromTurns(sessionId, turns, state);
    }

    return await retainTranscriptChunks(sessionId, turns, state);
  }

  /**
   * Flush whatever the turn gate has left unretained — the final partial
   * window of a session (e.g. 1-2 trailing turns that never reached
   * retainEveryNTurns). Called on session close so the tail of the
   * conversation isn't lost. No-ops when nothing is pending.
   */
  async function flushFinalTurns(
    sessionId: string,
    turns: Message[],
    state: SessionState
  ): Promise<SessionState> {
    if (!config.autoRetain || config.retainMode === "none" || !turns.length) {
      return state;
    }

    const userTurns = turns.filter((m) => m.role === "user").length;
    const covered = Math.max(state.lastRetainedTurn, state.lastFinalFlushTurn ?? 0);
    const pending = userTurns - covered;
    if (pending <= 0) return state;

    // Only the unretained tail; earlier turns are already in memory.
    const targetMessages = sliceLastTurnsByUserBoundary(turns, pending);

    if (config.retainMode === "facts") {
      const facts = extractAtomicFacts(targetMessages, config.extractionMaxTokens);
      let retained = 0;
      for (const fact of facts) {
        const content = sanitizeForRetention(fact, {
          stripSecrets: config.stripSecrets,
          stripBase64: config.stripBase64,
          maxLength: config.maxRetainedMessageLength,
        });
        if (!content) continue;

        const documentId = `fact-${hashContent(content)}`;
        const key = `${bankId}:${documentId}`;
        if (pendingRetains.has(key)) continue;
        pendingRetains.add(key);

        try {
          await retainTracked(
            content,
            {
              context: config.retainContext,
              documentId,
              tags: [...config.retainTags, "fact", "final"],
              metadata: {
                ...config.retainMetadata,
                session_id: sessionId,
                retained_at: new Date().toISOString(),
              },
              async: true,
            },
            sessionId
          );
          retained++;
        } finally {
          pendingRetains.delete(key);
        }
      }
      logger.debug("Final flush retained facts", { sessionId, retained, pending });
      return {
        ...state,
        lastRetainedTurn: userTurns,
        lastFinalFlushTurn: userTurns,
      };
    }

    // transcript mode: one final chunk covering the pending tail
    const parts: string[] = [];
    for (const msg of targetMessages) {
      const content = messageContentForRetention(msg);
      if (!content) continue;
      parts.push(`[role: ${msg.role}]\n${content}\n[${msg.role}:end]`);
    }
    if (!parts.length) {
      return { ...state, lastFinalFlushTurn: userTurns };
    }

    const documentId = `${sessionId}-final`;
    await retainTracked(
      parts.join("\n\n"),
      {
        context: config.retainContext,
        documentId,
        tags: [...config.retainTags, "transcript", "final"],
        metadata: {
          ...config.retainMetadata,
          session_id: sessionId,
          user_turns: String(userTurns),
          retained_at: new Date().toISOString(),
        },
        async: true,
      },
      sessionId
    );

    logger.debug("Final flush retained transcript tail", { sessionId, documentId, pending });
    return {
      ...state,
      lastRetainedTurn: userTurns,
      lastFinalFlushTurn: userTurns,
      lastTranscriptDocumentId: documentId,
    };
  }

  async function retainFactsFromTurns(
    sessionId: string,
    turns: Message[],
    state: SessionState
  ): Promise<SessionState> {
    const userTurns = turns.filter((m) => m.role === "user").length;
    if (userTurns - state.lastRetainedTurn < config.retainEveryNTurns) {
      return state;
    }

    const windowTurns = config.retainEveryNTurns + config.retainOverlapTurns;
    const targetMessages = sliceLastTurnsByUserBoundary(turns, windowTurns);
    const facts = extractAtomicFacts(targetMessages, config.extractionMaxTokens);

    let retained = 0;
    for (const fact of facts) {
      const content = sanitizeForRetention(fact, {
        stripSecrets: config.stripSecrets,
        stripBase64: config.stripBase64,
        maxLength: config.maxRetainedMessageLength,
      });
      if (!content) continue;

      const documentId = `fact-${hashContent(content)}`;
      const key = `${bankId}:${documentId}`;
      if (pendingRetains.has(key)) continue;
      pendingRetains.add(key);

      try {
        await retainTracked(
          content,
          {
            context: config.retainContext,
            documentId,
            tags: [...config.retainTags, "fact", "auto"],
            metadata: {
              ...config.retainMetadata,
              session_id: sessionId,
              retained_at: new Date().toISOString(),
            },
            async: true,
          },
          sessionId
        );
        retained++;
      } finally {
        pendingRetains.delete(key);
      }
    }

    logger.debug("Retained atomic facts", { sessionId, retained, userTurns });
    return { ...state, lastRetainedTurn: userTurns };
  }

  /**
   * Transcript mode: ONE document per session (`documentId = sessionId`),
   * upserted with the full sanitized transcript each time the turn gate
   * passes. The old chunked windowing + delete-previous-chunk dance is gone:
   * the server upserts by document id and the growth gate upstream suppresses
   * redundant writes, so there is nothing to clean up.
   */
  async function retainTranscriptChunks(
    sessionId: string,
    turns: Message[],
    state: SessionState
  ): Promise<SessionState> {
    const userTurns = turns.filter((m) => m.role === "user").length;
    if (userTurns - state.lastRetainedTurn < config.retainEveryNTurns) {
      return state;
    }

    const parts: string[] = [];
    for (const msg of turns) {
      const content = messageContentForRetention(msg);
      if (!content) continue;
      parts.push(`[role: ${msg.role}]\n${content}\n[${msg.role}:end]`);
    }

    if (!parts.length) return state;

    const transcript = parts.join("\n\n");
    if (transcript.trim().length < 10) return state;

    await retainTracked(
      transcript,
      {
        context: config.retainContext,
        documentId: sessionId,
        tags: [...config.retainTags, "transcript", "auto"],
        metadata: {
          ...config.retainMetadata,
          session_id: sessionId,
          user_turns: String(userTurns),
          retained_at: new Date().toISOString(),
        },
        async: true,
      },
      sessionId
    );

    logger.debug("Retained transcript upsert", { sessionId, userTurns });
    return { ...state, lastRetainedTurn: userTurns };
  }

  /** Sanitized, tool-trace-enriched content for one message. */
  function messageContentForRetention(msg: Message): string {
    const sanitized = sanitizeForRetention(msg.content, {
      stripSecrets: config.stripSecrets,
      stripBase64: config.stripBase64,
      maxLength: config.maxRetainedMessageLength,
    });
    const trace = msg.toolCalls?.length
      ? msg.toolCalls
          .filter((c) => !OPERATIONAL_TOOLS.has(c.name))
          .map((c) => formatToolTrace(c.name, c.summary ?? c.inputJson))
          .join(" ")
      : "";
    if (sanitized && trace) return `${sanitized}\n${trace}`;
    return sanitized || trace;
  }

  async function deleteByDocumentId(documentId: string): Promise<boolean> {
    return await client.deleteDocument(bankId, documentId);
  }

  async function deleteByQuery(_query: string): Promise<boolean> {
    // The Hindsight client does not expose a query-based delete in the V1 package.
    // In the future this can use a delete-by-query API if available.
    logger.warn("deleteByQuery is not supported by the current Hindsight client");
    return false;
  }

  return {
    retainFact,
    retainTurns,
    flushFinalTurns,
    deleteByDocumentId,
    deleteByQuery,
  };
}

function hashContent(content: string): string {
  // Simple stable hash for deterministic document IDs.
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function extractAtomicFacts(messages: Message[], _maxTokens: number): string[] {
  // MVP: turn the last user/assistant exchange into one or two atomic facts.
  // A future version can use a lightweight LLM call for richer extraction.
  const facts: string[] = [];
  let currentTurn: Message[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    currentTurn.unshift(msg);
    if (msg.role === "user") break;
  }

  if (!currentTurn.length) return facts;

  const userMsg = currentTurn.find((m) => m.role === "user");
  const assistantMsg = currentTurn.find((m) => m.role === "assistant");

  if (userMsg && assistantMsg) {
    const toolTrace = assistantMsg.toolCalls?.length
      ? " " +
        assistantMsg.toolCalls
          .filter((c) => !OPERATIONAL_TOOLS.has(c.name))
          .map((c) => formatToolTrace(c.name, c.summary ?? c.inputJson))
          .join(" ")
      : "";
    const fact = stripMemoryTags(
      `User asked: ${userMsg.content.trim()}\nAssistant concluded: ${assistantMsg.content.trim()}${toolTrace}`
    );
    facts.push(fact);
  } else if (userMsg) {
    facts.push(stripMemoryTags(userMsg.content.trim()));
  }

  return facts;
}

/** Tools whose activity is pure plumbing (file reads, shell, glob…) — traces
 * add noise, not memory. Anything else (edit target, commit, HTTP call) is
 * worth a compact trace line. */
const OPERATIONAL_TOOLS = new Set([
  "read", "write", "bash", "glob", "grep", "ls", "list", "cat",
  "sed", "awk", "find", "head", "tail", "process", "spawn",
]);
