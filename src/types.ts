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

export interface SessionState {
  lastRetainedTurn: number;
  lastRecallQuery?: string;
  lastRecallAt?: number;
  lastTranscriptDocumentId?: string;
  /** User-turn count already covered by a final flush (session close),
   * so a later idle fire for the same window doesn't re-retain it. */
  lastFinalFlushTurn?: number;
}
