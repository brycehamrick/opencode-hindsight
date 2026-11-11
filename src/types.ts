export interface ToolCallTrace {
  /** Tool name, e.g. "edit", "commit", "fetch". */
  name: string;
  /** Short human summary, when the host provides one. */
  summary?: string;
  /** Raw input as compact JSON, used when no summary exists. */
  inputJson?: string;
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
  /** Non-operational tool activity to retain as compact traces. Optional:
   * hosts that can't supply it simply omit the field. */
  toolCalls?: ToolCallTrace[];
}

export interface RecallResult {
  text: string;
  type?: string | null;
  mentioned_at?: string | null;
  score?: number;
  documentId?: string;
  metadata?: Record<string, string>;
}

export interface PluginState {
  missions: string[];
  sessions: Record<string, SessionState>;
}

/**
 * Per-session auto-inject state (tri-state). "unresolved" means the source
 * has not produced an answer yet — either not run, or failed within its
 * attempt budget — and a later turn may try again. "empty" is terminal: the
 * source ran (or exhausted its budget) and there is nothing to inject.
 * "answer" holds the frozen synthesis body.
 *
 * Persisted so a plugin reload does not re-synthesize or lose the budget
 * count.
 */
export interface InjectState {
  status: "unresolved" | "empty" | "answer";
  failAttempts: number;
  emptyAttempts: number;
  /** Frozen answer body (status "answer"). */
  text?: string;
  /** Excerpt of the prompt the answer was recalled for (provenance). */
  goalExcerpt?: string;
  /** Cold-bank deferral consumed yet? (one free skip on a brand-new bank) */
  coldDeferred?: boolean;
}

export interface SessionState {
  lastRetainedTurn: number;
  lastRecallQuery?: string;
  lastRecallAt?: number;
  lastTranscriptDocumentId?: string;
  /** User-turn count already covered by a final flush (session close),
   * so a later idle fire for the same window doesn't re-retain it. */
  lastFinalFlushTurn?: number;
  /** Write-back growth gate: fingerprint of the transcript at the last
   * successful retain. Repeated idle/execution signals for an unchanged
   * transcript cost nothing. */
  retainedFingerprint?: string;
  // ── auto-inject (MEMORY_PIPELINE_PLAN.md WS2) ────────────────────────────
  startedAt?: string;
  /** Admitted user turns seen (prompt-text boundaries). */
  turns?: number;
  inject?: InjectState;
  /** Frozen core-memory section for this session (byte-stable by design). */
  coreBlock?: string | null;
}
