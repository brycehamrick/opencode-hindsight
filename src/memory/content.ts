import type { Message } from "../types.js";

/** Strip injected memory blocks to prevent retain feedback loops. */
export function stripMemoryTags(content: string): string {
  return content
    .replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g, "")
    .replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>/g, "")
    .replace(/Relevant context from memory:[\s\S]*?(?=\n\n|$)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove likely secrets and sensitive tokens from retained content. */
export function stripSecrets(content: string): string {
  // Authorization / Bearer tokens
  content = content.replace(/\bAuthorization\s*[:=]\s*["']?\s*[Bb]earer\s+\S+["']?/g, "[REDACTED_AUTH]");
  // Generic API keys / tokens
  content = content.replace(
    /\b(?:api[_-]?key|apikey|token|secret|password|passwd|pwd)\s*[:=]\s*["']?[\w\-./+=]{8,}["']?/gi,
    "[REDACTED_SECRET]"
  );
  // GitHub-style tokens
  content = content.replace(/\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  // AWS keys
  content = content.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]");
  // Private keys
  content = content.replace(/-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
  return content;
}

/** Remove or truncate large base64 blobs. */
export function stripBase64(content: string, maxChunkLength = 64): string {
  // Match base64-like sequences: alphanumeric+/ at least 64 chars, padded with =,
  // or very long (256+) un-padded sequences that are likely base64.
  return content.replace(/([A-Za-z0-9+/]{64,}={1,2}|[A-Za-z0-9+/]{128,})/g, (match) => {
    if (match.length <= maxChunkLength) return match;
    return `[BASE64:${match.length}chars]`;
  });
}

/** Format a tool-call trace line for retention.
 *
 * Compact representation of non-operational tool activity so memory keeps the
 * *what and how* of a session ("edited servers/work.md", "ran the test suite")
 * without retaining full tool payloads or noisy operational output. */
export function formatToolTrace(toolName: string, summary?: string): string {
  const name = toolName.trim() || "tool";
  if (!summary || !summary.trim()) return `[tool: ${name}]`;
  const compact = summary.trim().replace(/\s+/g, " ");
  return `[tool: ${name} ${compact.slice(0, 120)}]`;
}

/** Prepare content for retention. */
export function sanitizeForRetention(
  content: string,
  options: { stripSecrets: boolean; stripBase64: boolean; maxLength: number }
): string {
  let sanitized = content;
  if (options.stripSecrets) sanitized = stripSecrets(sanitized);
  if (options.stripBase64) sanitized = stripBase64(sanitized);
  sanitized = stripMemoryTags(sanitized);
  if (sanitized.length > options.maxLength) {
    sanitized = sanitized.slice(0, options.maxLength) + "\n...[truncated]";
  }
  return sanitized.trim();
}

/** Compose a recall query from the latest user message and recent context. */
export function composeRecallQuery(
  latestQuery: string,
  messages: Message[],
  recallContextTurns: number
): string {
  const latest = latestQuery.trim();
  if (recallContextTurns <= 1 || !messages.length) return latest;

  const contextual = sliceLastTurnsByUserBoundary(messages, recallContextTurns);
  const contextLines: string[] = [];

  for (const msg of contextual) {
    const content = stripMemoryTags(msg.content).trim();
    if (!content) continue;
    if (msg.role === "user" && content === latest) continue;
    contextLines.push(`${msg.role}: ${content}`);
  }

  if (!contextLines.length) return latest;
  return ["Prior context:", contextLines.join("\n"), latest].join("\n\n");
}

/** Truncate a composed recall query to a character budget, preserving the latest query. */
export function truncateRecallQuery(query: string, latestQuery: string, maxChars: number): string {
  if (maxChars <= 0 || query.length <= maxChars) return query;

  const latest = latestQuery.trim();
  const latestOnly = latest.length > maxChars ? latest.slice(0, maxChars) : latest;

  if (!query.includes("Prior context:")) return latestOnly;

  const contextMarker = "Prior context:\n\n";
  const markerIndex = query.indexOf(contextMarker);
  if (markerIndex === -1) return latestOnly;

  const suffix = "\n\n" + latest;
  const suffixIndex = query.lastIndexOf(suffix);
  if (suffixIndex === -1) return latestOnly;
  if (suffix.length >= maxChars) return latestOnly;

  const contextBody = query.slice(markerIndex + contextMarker.length, suffixIndex);
  const contextLines = contextBody.split("\n").filter(Boolean);

  const kept: string[] = [];
  for (let i = contextLines.length - 1; i >= 0; i--) {
    kept.unshift(contextLines[i]);
    const candidate = `${contextMarker}${kept.join("\n")}${suffix}`;
    if (candidate.length > maxChars) {
      kept.shift();
      break;
    }
  }

  if (kept.length) return `${contextMarker}${kept.join("\n")}${suffix}`;
  return latestOnly;
}

/** Slice messages to the last N user-initiated turns. */
export function sliceLastTurnsByUserBoundary(messages: Message[], turns: number): Message[] {
  if (!messages.length || turns <= 0) return [];

  let userTurnsSeen = 0;
  let startIndex = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen >= turns) {
        startIndex = i;
        break;
      }
    }
  }

  return startIndex === -1 ? [...messages] : messages.slice(startIndex);
}

/** Format recall results for injection into the system prompt. */
export function formatMemories(results: { text: string; type?: string | null; mentioned_at?: string | null }[]): string {
  if (!results.length) return "";
  return results
    .map((r) => {
      const typeStr = r.type ? ` [${r.type}]` : "";
      const dateStr = r.mentioned_at ? ` (${r.mentioned_at})` : "";
      return `- ${r.text}${typeStr}${dateStr}`;
    })
    .join("\n\n");
}

/** Format a memory context block with preamble. */
export function formatMemoryContext(
  results: { text: string; type?: string | null }[],
  options: { preamble?: string; maxTokens?: number } = {}
): string | null {
  if (!results.length) return null;

  let formatted = formatMemories(results);
  if (!formatted) return null;

  const preamble = options.preamble ?? "Relevant context from memory:";
  const context = `${preamble}\n${formatted}`;

  if (options.maxTokens && options.maxTokens > 0) {
    return truncateToApproxTokens(context, options.maxTokens);
  }

  return context;
}

/** Very rough token estimator: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate text to an approximate token budget by dropping lines from the end. */
export function truncateToApproxTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;

  const lines = text.split("\n");
  let kept: string[] = [];
  for (const line of lines) {
    const candidate = [...kept, line].join("\n");
    if (candidate.length > maxChars) break;
    kept.push(line);
  }

  const result = kept.join("\n");
  if (!result) return lines[0]?.slice(0, maxChars) ?? "";
  return result;
}

/** Format current UTC time. */
export function formatCurrentTime(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}`;
}
