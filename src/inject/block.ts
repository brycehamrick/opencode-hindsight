/**
 * Injection block formatting (MEMORY_PIPELINE_PLAN.md WS2).
 *
 * The block is FROZEN per session: every section string is computed once and
 * reused byte-for-byte for the session's remainder. In this phase the block is
 * delivered through the context hook's system parts, so byte-stability is what
 * keeps the provider's prefix cache valid — a system prompt that changes
 * between turns re-bills the whole conversation as uncached input every turn.
 */

import type { RecallResult } from "../types.js";
import { formatMemories } from "../memory/content.js";

export const MEMORY_BLOCK_TAG = "hindsight_memories";

/** Format the frozen core-memory section. Undefined when there is no core. */
export function formatCoreSection(core: RecallResult[]): string | undefined {
  if (!core.length) return undefined;
  return (
    "[core] Stable preferences and conventions " +
    "(prioritize recent when conflicting; ignore what is not useful):\n" +
    formatMemories(core)
  );
}

/**
 * Format the once-per-session context section. `body` is either a reflect
 * synthesis or a formatted recall list, produced by the engine and frozen.
 */
export function formatContextSection(body: string, goalExcerpt?: string): string {
  const goal = goalExcerpt ? ` Recalled for "${goalExcerpt}".` : "";
  return `[context]${goal}\n${body.trim()}`;
}

/**
 * Assemble the full injected block. Returns undefined when no section has
 * content — pushing an empty wrapper would waste tokens every turn.
 */
export function buildMemoryBlock(sections: {
  core?: string;
  context?: string;
}): string | undefined {
  const parts = [sections.core, sections.context].filter(Boolean) as string[];
  if (!parts.length) return undefined;
  return (
    `<${MEMORY_BLOCK_TAG}>\n` +
    parts.join("\n\n") +
    `\nFor deeper lookups, call hindsight_recall or hindsight_reflect.` +
    `\n</${MEMORY_BLOCK_TAG}>`
  );
}
