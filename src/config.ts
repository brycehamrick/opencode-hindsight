import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export const DEFAULT_HINDSIGHT_API_URL = "https://api.hindsight.vectorize.io";

export interface HindsightPluginOptions extends Record<string, unknown> {
  hindsightApiUrl?: string;
  hindsightApiToken?: string;
  bankId?: string | null;
  bankIdPrefix?: string;
  dynamicBankId?: boolean;
  agentName?: string;
  dynamicBankGranularity?: ("agent" | "project" | "gitProject" | "channel" | "user")[];
  bankMission?: string;
  retainMission?: string | null;
  autoRecall?: boolean;
  /** Auto-injection mode: "reflect" (once per session), "recall" (once per
   * session), "perMessage" (legacy per-turn recall), or "none" (tools only). */
  autoInject?: "reflect" | "recall" | "perMessage" | "none";
  autoRetain?: boolean;
  retainMode?: "facts" | "transcript" | "none";
  coreMemoryMaxTokens?: number;
  perMessageRecallMaxTokens?: number;
  compactionRecallMaxTokens?: number;
  extractionMaxTokens?: number;
  recallBudget?: "low" | "mid" | "high";
  recallContextTurns?: number;
  recallMaxQueryChars?: number;
  maxRecallQueryTokens?: number;
  recallPromptPreamble?: string;
  recallTypes?: string[];
  recallTags?: string[];
  recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
  reflectTimeoutMs?: number;
  injectTimeoutMs?: number;
  injectFailureAttempts?: number;
  injectEmptyAttempts?: number;
  minReflectPromptChars?: number;
  coreRefreshPolicy?: "session" | "onInvalidate";
  retainContext?: string;
  retainEveryNTurns?: number;
  retainOverlapTurns?: number;
  retainTags?: string[];
  retainMetadata?: Record<string, string>;
  stripSecrets?: boolean;
  stripBase64?: boolean;
  maxRetainedMessageLength?: number;
  debug?: boolean;
}

export interface HindsightConfig {
  agentName: string;
  hindsightApiUrl: string;
  hindsightApiToken: string | null;
  bankId: string | null;
  bankIdPrefix: string;
  dynamicBankId: boolean;
  dynamicBankGranularity: ("agent" | "project" | "gitProject" | "channel" | "user")[];
  bankMission: string;
  retainMission: string | null;
  autoRecall: boolean;
  autoInject: "reflect" | "recall" | "perMessage" | "none";
  autoRetain: boolean;
  retainMode: "facts" | "transcript" | "none";
  coreMemoryMaxTokens: number;
  perMessageRecallMaxTokens: number;
  compactionRecallMaxTokens: number;
  extractionMaxTokens: number;
  recallBudget: "low" | "mid" | "high";
  recallContextTurns: number;
  recallMaxQueryChars: number;
  maxRecallQueryTokens: number;
  recallPromptPreamble: string;
  recallTypes: string[];
  recallTags: string[];
  recallTagsMatch: "any" | "all" | "any_strict" | "all_strict";
  reflectTimeoutMs: number;
  injectTimeoutMs: number;
  injectFailureAttempts: number;
  injectEmptyAttempts: number;
  minReflectPromptChars: number;
  coreRefreshPolicy: "session" | "onInvalidate";
  retainEveryNTurns: number;
  retainOverlapTurns: number;
  retainContext: string;
  retainTags: string[];
  retainMetadata: Record<string, string>;
  stripSecrets: boolean;
  stripBase64: boolean;
  maxRetainedMessageLength: number;
  debug: boolean;
}

const DEFAULTS: Omit<HindsightConfig, "autoInject"> = {
  agentName: "opencode",
  hindsightApiUrl: DEFAULT_HINDSIGHT_API_URL,
  hindsightApiToken: null,
  bankId: null,
  bankIdPrefix: "",
  dynamicBankId: false,
  dynamicBankGranularity: ["agent", "project"],
  bankMission: "",
  retainMission: null,
  autoRecall: true,
  // Deliberately absent from DEFAULTS: the effective default is derived from
  // autoRecall (below) so an explicit `autoRecall: false` maps to "none".
  autoRetain: true,
  retainMode: "facts",
  coreMemoryMaxTokens: 256,
  perMessageRecallMaxTokens: 512,
  compactionRecallMaxTokens: 512,
  extractionMaxTokens: 256,
  recallBudget: "mid",
  recallContextTurns: 2,
  recallMaxQueryChars: 800,
  maxRecallQueryTokens: 500,
  recallPromptPreamble:
    "Relevant memories from past conversations (prioritize recent when conflicting). " +
    "Only use memories that are directly useful; ignore the rest.",
  recallTypes: ["world", "experience"],
  recallTags: [],
  recallTagsMatch: "any",
  reflectTimeoutMs: 20_000,
  injectTimeoutMs: 8_000,
  injectFailureAttempts: 2,
  injectEmptyAttempts: 5,
  minReflectPromptChars: 8,
  coreRefreshPolicy: "session",
  retainEveryNTurns: 3,
  retainOverlapTurns: 2,
  retainContext: "opencode",
  retainTags: [],
  retainMetadata: {},
  stripSecrets: true,
  stripBase64: true,
  maxRetainedMessageLength: 4000,
  debug: false,
};

const ENV_OVERRIDES: Record<string, [keyof HindsightConfig, "string" | "bool" | "int" | "array"]> = {
  HINDSIGHT_API_URL: ["hindsightApiUrl", "string"],
  HINDSIGHT_API_TOKEN: ["hindsightApiToken", "string"],
  HINDSIGHT_BANK_ID: ["bankId", "string"],
  HINDSIGHT_AGENT_NAME: ["agentName", "string"],
  HINDSIGHT_AUTO_RECALL: ["autoRecall", "bool"],
  HINDSIGHT_AUTO_INJECT: ["autoInject", "string"],
  HINDSIGHT_AUTO_RETAIN: ["autoRetain", "bool"],
  HINDSIGHT_RETAIN_MODE: ["retainMode", "string"],
  HINDSIGHT_RECALL_BUDGET: ["recallBudget", "string"],
  HINDSIGHT_RECALL_MAX_QUERY_CHARS: ["recallMaxQueryChars", "int"],
  HINDSIGHT_MAX_RECALL_QUERY_TOKENS: ["maxRecallQueryTokens", "int"],
  HINDSIGHT_REFLECT_TIMEOUT_MS: ["reflectTimeoutMs", "int"],
  HINDSIGHT_INJECT_TIMEOUT_MS: ["injectTimeoutMs", "int"],
  HINDSIGHT_INJECT_FAILURE_ATTEMPTS: ["injectFailureAttempts", "int"],
  HINDSIGHT_INJECT_EMPTY_ATTEMPTS: ["injectEmptyAttempts", "int"],
  HINDSIGHT_MIN_REFLECT_PROMPT_CHARS: ["minReflectPromptChars", "int"],
  HINDSIGHT_CORE_REFRESH_POLICY: ["coreRefreshPolicy", "string"],
  HINDSIGHT_RECALL_CONTEXT_TURNS: ["recallContextTurns", "int"],
  HINDSIGHT_RETAIN_EVERY_N_TURNS: ["retainEveryNTurns", "int"],
  HINDSIGHT_RETAIN_OVERLAP_TURNS: ["retainOverlapTurns", "int"],
  HINDSIGHT_RETAIN_CONTEXT: ["retainContext", "string"],
  HINDSIGHT_DYNAMIC_BANK_ID: ["dynamicBankId", "bool"],
  HINDSIGHT_BANK_MISSION: ["bankMission", "string"],
  HINDSIGHT_BANK_ID_PREFIX: ["bankIdPrefix", "string"],
  HINDSIGHT_CORE_MEMORY_MAX_TOKENS: ["coreMemoryMaxTokens", "int"],
  HINDSIGHT_PER_MESSAGE_RECALL_MAX_TOKENS: ["perMessageRecallMaxTokens", "int"],
  HINDSIGHT_COMPACTION_RECALL_MAX_TOKENS: ["compactionRecallMaxTokens", "int"],
  HINDSIGHT_EXTRACTION_MAX_TOKENS: ["extractionMaxTokens", "int"],
  HINDSIGHT_STRIP_SECRETS: ["stripSecrets", "bool"],
  HINDSIGHT_STRIP_BASE64: ["stripBase64", "bool"],
  HINDSIGHT_MAX_RETAINED_MESSAGE_LENGTH: ["maxRetainedMessageLength", "int"],
  HINDSIGHT_RECALL_TAGS: ["recallTags", "array"],
  HINDSIGHT_RETAIN_TAGS: ["retainTags", "array"],
};

function castEnv(value: string, typ: "string" | "bool" | "int" | "array"): unknown {
  if (typ === "bool") return ["true", "1", "yes"].includes(value.toLowerCase());
  if (typ === "int") {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? null : n;
  }
  if (typ === "array") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return value;
}

function loadUserConfig(): Partial<HindsightPluginOptions> {
  try {
    const path = join(homedir(), ".hindsight", "opencode.json");
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Partial<HindsightPluginOptions>;
  } catch {
    return {};
  }
}

export function loadConfig(pluginOptions: HindsightPluginOptions = {}): HindsightConfig {
  const merged: Record<string, unknown> = { ...DEFAULTS };

  const userConfig = loadUserConfig();
  for (const [key, value] of Object.entries(userConfig)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }

  for (const [key, value] of Object.entries(pluginOptions)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }

  for (const [envName, [key, typ]] of Object.entries(ENV_OVERRIDES)) {
    const val = process.env[envName];
    if (val !== undefined) {
      const cast = castEnv(val, typ);
      if (cast !== null) merged[key] = cast;
    }
  }

  const config = merged as unknown as HindsightConfig;

  const validRetainModes: HindsightConfig["retainMode"][] = ["facts", "transcript", "none"];
  if (!validRetainModes.includes(config.retainMode)) {
    config.retainMode = "facts";
  }

  const validBudgets: HindsightConfig["recallBudget"][] = ["low", "mid", "high"];
  if (!validBudgets.includes(config.recallBudget)) {
    config.recallBudget = "mid";
  }

  const validTagsMatch: HindsightConfig["recallTagsMatch"][] = ["any", "all", "any_strict", "all_strict"];
  if (!validTagsMatch.includes(config.recallTagsMatch)) {
    config.recallTagsMatch = "any";
  }

  if (!Number.isFinite(config.maxRecallQueryTokens) || config.maxRecallQueryTokens <= 0) {
    config.maxRecallQueryTokens = 500;
  }

  // autoInject migration: absent => derive from autoRecall so an explicit
  // `autoRecall: false` keeps meaning "inject nothing". `autoRecall: true`
  // (or unset) upgrades to the new once-per-session default ("reflect").
  if (config.autoInject === undefined) {
    config.autoInject = config.autoRecall === false ? "none" : "reflect";
  }
  const validInjectModes: HindsightConfig["autoInject"][] = ["reflect", "recall", "perMessage", "none"];
  if (!validInjectModes.includes(config.autoInject)) {
    config.autoInject = "reflect";
  }

  const validRefreshPolicies: HindsightConfig["coreRefreshPolicy"][] = ["session", "onInvalidate"];
  if (!validRefreshPolicies.includes(config.coreRefreshPolicy)) {
    config.coreRefreshPolicy = "session";
  }

  // Timeouts must be positive (0 would time out instantly); attempt budgets
  // and the min-chars threshold legitimately allow 0 ("never retry" / "never
  // skip"). Anything non-finite or negative falls back to the default.
  for (const [key, fallback] of [
    ["reflectTimeoutMs", 20_000],
    ["injectTimeoutMs", 8_000],
  ] as const) {
    const value = config[key];
    if (!Number.isFinite(value) || value <= 0) {
      (config as unknown as Record<string, unknown>)[key] = fallback;
    }
  }
  for (const [key, fallback] of [
    ["injectFailureAttempts", 2],
    ["injectEmptyAttempts", 5],
    ["minReflectPromptChars", 8],
  ] as const) {
    const value = config[key];
    if (!Number.isFinite(value) || value < 0) {
      (config as unknown as Record<string, unknown>)[key] = fallback;
    }
  }

  return config;
}
