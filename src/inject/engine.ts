/**
 * InjectionEngine — the once-per-session auto-inject brain
 * (MEMORY_PIPELINE_PLAN.md WS2).
 *
 * Semantics adopted from the official Vectorize coding-agents package:
 *  - ONE source run per session (reflect synthesis by default), injected on
 *    the turn it ran and frozen thereafter — never re-run, never re-worded.
 *  - Tri-state result: an ANSWER is final; EMPTY is an answer too (matched
 *    nothing); only a FAILURE stays unresolved and retryable.
 *  - Attempt budgets: a failing source may retry `injectFailureAttempts`
 *    turns; an empty source `injectEmptyAttempts` turns, then gives up.
 *    A permanent 4xx resolves immediately — retrying cannot help.
 *  - A cold bank defers the first attempt once (nothing to reflect on yet),
 *    and a trivially short prompt skips without consuming an attempt.
 *  - Core memory is fetched once, formatted once, and byte-frozen for the
 *    session: a system block that changes between turns invalidates the
 *    provider's prefix cache and re-bills the whole conversation.
 *
 * Phase 1 delivery: `onModelCall` is driven by the context hook (which fires
 * per model call, tool continuations included); a changed last-user text marks
 * a new turn. Phase 2 moves delivery to the prompt-admission hook and a
 * stored synthetic message; this engine's state machine is unchanged.
 */

import type { HindsightConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { Message, PluginState, RecallResult, SessionState } from "../types.js";
import { diag } from "../diag.js";
import { boundQueryTokens, formatMemoryContext, stripInjectedMemory } from "../memory/content.js";
import { buildMemoryBlock, formatContextSection, formatCoreSection } from "./block.js";

/** Outcome of one auto-inject source run. */
export type InjectSourceResult =
  | { ok: true; body: string } // body "" ⇒ ran and matched nothing
  | { ok: false; error: string; permanent?: boolean };

export interface InjectionEngineDeps {
  config: HindsightConfig;
  logger: Logger;
  state: PluginState;
  persistState(): Promise<void>;
  /** Once-per-session synthesis source (mode "reflect"). */
  reflectSource(query: string, agentName?: string): Promise<InjectSourceResult>;
  /** Once-per-session retrieval source (mode "recall"). */
  recallSource(query: string, agentName?: string): Promise<InjectSourceResult>;
  /** Cached core memories (manager-owned cache). */
  getCoreMemories(agentName?: string): Promise<RecallResult[]>;
  /** Legacy per-message recall (mode "perMessage"). */
  recallForMessage(message: string, messages: Message[], agentName?: string): Promise<RecallResult[]>;
  /** Cold-bank probe, cached per bank by the caller. */
  isBankCold(agentName?: string): Promise<boolean>;
}

export interface InjectionEngine {
  /**
   * A model request is being assembled (context-hook channel). Returns the
   * system block to attach for this call — byte-identical across the session
   * once frozen — or undefined when nothing should be injected.
   */
  onModelCall(args: {
    sessionId: string;
    agent?: string;
    /** Last user message text (raw; hygiene applied internally). */
    prompt?: string;
    messages: Message[];
    /** Host-provided token budget for the block, when it offers one. */
    budgetTokens?: number;
  }): Promise<string | undefined>;
  /**
   * A user prompt was admitted (prompt-hook channel, Phase 2). Runs once per
   * prompt — turn counting, core freeze, source run — BEFORE the model call.
   * Retry-safe: an identical re-admission is a no-op.
   */
  onPrompt(args: { sessionId: string; agent?: string; prompt: string }): Promise<void>;
  /**
   * The block that should be delivered as a synthetic message this turn, if
   * any. Pure query: the caller owns delivery (and deliver-on-change
   * deduping) — a failed delivery is simply not recorded.
   */
  peekBlock(sessionId: string): string | undefined;
  /** A core-tagged fact was retained; honor coreRefreshPolicy. */
  invalidateCore(): void;
}

/** Per-session runtime state (delivery-level, not persisted). */
interface RuntimeSession {
  lastPrompt: string | undefined;
  /** In-flight core fetches, so concurrent model calls share one request. */
  coreFetch: Promise<void> | null;
  /** perMessage recall cache, keyed `${agent}:${prompt}`. */
  recallCache: Map<string, RecallResult[]>;
  /** perMessage: this turn's block, computed at admission (onPrompt). */
  turnBlock: string | undefined;
}

const RECALL_CACHE_MAX = 100;
const GOAL_EXCERPT_CHARS = 80;

export function createInjectionEngine(deps: InjectionEngineDeps): InjectionEngine {
  const { config, state, logger } = deps;
  const runtime = new Map<string, RuntimeSession>();

  function sessionOf(sessionId: string): SessionState {
    const existing = state.sessions[sessionId];
    if (existing) return existing;
    const created: SessionState = { lastRetainedTurn: 0 };
    state.sessions[sessionId] = created;
    return created;
  }

  function runtimeOf(sessionId: string): RuntimeSession {
    let rt = runtime.get(sessionId);
    if (!rt) {
      rt = { lastPrompt: undefined, coreFetch: null, recallCache: new Map(), turnBlock: undefined };
      runtime.set(sessionId, rt);
    }
    return rt;
  }

  async function persist(): Promise<void> {
    try {
      await deps.persistState();
    } catch (error) {
      logger.debug("Injection state persist failed", { error: String(error) });
    }
  }

  async function onModelCall(args: {
    sessionId: string;
    agent?: string;
    prompt?: string;
    messages: Message[];
    budgetTokens?: number;
  }): Promise<string | undefined> {
    const mode = config.autoInject;
    if (mode === "none") return undefined;
    if (!args.sessionId) return undefined;

    const prompt = stripInjectedMemory(args.prompt ?? "").trim();
    const rt = runtimeOf(args.sessionId);
    // New-turn detection: the context hook fires per model call; only a
    // changed last-user text marks a new user turn. Retrying a failed source
    // on every tool continuation would burn the attempt budget instantly.
    const isNewTurn = prompt.length > 0 && prompt !== rt.lastPrompt;
    if (isNewTurn) {
      await advanceTurn(args.sessionId, args.agent, prompt, args.messages, args.budgetTokens);
    }

    if (mode === "perMessage") {
      // Admission (onPrompt) may already have computed this turn's block —
      // same prompt, reuse it; otherwise compute with the fuller message
      // list the context hook can see.
      if (rt.turnBlock !== undefined && prompt === rt.lastPrompt) return rt.turnBlock;
      return await perMessageBlock(args.sessionId, args.agent, prompt, args.messages, args.budgetTokens);
    }

    return currentBlock(args.sessionId);
  }

  /**
   * A new user turn begins (from either entry point): count it, freeze core,
   * run the once-per-session source if eligible, persist. For perMessage
   * mode, compute this turn's block now — at admission the transcript is not
   * available, so the recall query is prompt-only (recallContextTurns
   * effectively 1 on the synthetic channel; documented).
   */
  async function advanceTurn(
    sessionId: string,
    agent: string | undefined,
    prompt: string,
    messages: Message[] = [],
    budgetTokens?: number
  ): Promise<void> {
    const rt = runtimeOf(sessionId);
    const sess = sessionOf(sessionId);
    rt.lastPrompt = prompt;
    sess.startedAt ??= new Date().toISOString();
    sess.turns = (sess.turns ?? 0) + 1;

    if (config.autoInject === "perMessage") {
      rt.turnBlock = await perMessageBlock(sessionId, agent, prompt, messages, budgetTokens);
      await persist();
      return;
    }

    await ensureCoreFrozen(sessionId, agent);
    await runSource(sessionId, agent, prompt);
    await persist();
  }

  async function onPrompt(args: { sessionId: string; agent?: string; prompt: string }): Promise<void> {
    if (config.autoInject === "none" || !args.sessionId) return;
    const prompt = stripInjectedMemory(args.prompt ?? "").trim();
    if (!prompt) return;
    const rt = runtimeOf(args.sessionId);
    // Retry-safe: the host may run admission hooks more than once for one
    // submission; only a changed prompt is a new turn.
    if (prompt === rt.lastPrompt) return;
    await advanceTurn(args.sessionId, args.agent, prompt);
  }

  function peekBlock(sessionId: string): string | undefined {
    if (config.autoInject === "perMessage") return runtimeOf(sessionId).turnBlock;
    return currentBlock(sessionId);
  }

  /**
   * Fetch the core-memory section once per session and freeze it verbatim.
   * coreBlock: undefined = never fetched, null = fetched and empty, string =
   * frozen content. A transient fetch failure is indistinguishable from an
   * empty bank here (the recall layer fails open to []); the cost is a
   * core-less session, never a broken one.
   */
  async function ensureCoreFrozen(sessionId: string, agent?: string): Promise<void> {
    const sess = sessionOf(sessionId);
    const rt = runtimeOf(sessionId);
    if (sess.coreBlock !== undefined) return; // frozen (content or empty)
    if (rt.coreFetch) return await rt.coreFetch;

    const fetch = (async () => {
      try {
        const core = await deps.getCoreMemories(agent);
        sess.coreBlock = formatCoreSection(core) ?? null;
        await persist();
      } catch (error) {
        // Leave undefined so a later turn can try again.
        logger.debug("Core memory fetch failed", { error: String(error) });
      }
    })();
    rt.coreFetch = fetch;
    try {
      await fetch;
    } finally {
      rt.coreFetch = null;
    }
  }

  /** One attempt at the once-per-session source, on a new turn, while unresolved. */
  async function runSource(sessionId: string, agent: string | undefined, prompt: string): Promise<void> {
    const sess = sessionOf(sessionId);
    const inj = (sess.inject ??= { status: "unresolved", failAttempts: 0, emptyAttempts: 0 });
    if (inj.status !== "unresolved") return;

    // Cold-bank defer, consumed exactly once: on a brand-new bank the
    // synthesis would find nothing, so don't burn prompt one's attempt on it.
    if (!inj.coldDeferred) {
      inj.coldDeferred = true;
      if (await deps.isBankCold(agent)) {
        diag("inject_deferred_cold", { session: sessionId });
        return;
      }
    }

    // Trivially short prompts ("hi", "ok") are skipped WITHOUT consuming an
    // attempt, so an opener doesn't burn the session's synthesis on garbage.
    if (prompt.length < config.minReflectPromptChars) {
      diag("inject_skip_short", { session: sessionId, len: prompt.length });
      return;
    }

    const query = boundQueryTokens(prompt, config.maxRecallQueryTokens);
    const result =
      config.autoInject === "recall"
        ? await deps.recallSource(query, agent)
        : await deps.reflectSource(query, agent);

    // ── reflect fallback chain (WS5) ─────────────────────────────────────────
    // A reflect failure does not cost the session its memory: one
    // retrieval-only recall runs within its own retrieval budget
    // (injectTimeoutMs). A fallback body is cached exactly like a reflect
    // answer — injected once, never retried — and applies to permanent 4xx
    // too (the reflect endpoint may be misconfigured while recall works).
    let fallbackBody: string | undefined;
    if (!result.ok && config.autoInject === "reflect") {
      diag("reflect_fallback", { session: sessionId, permanent: result.permanent === true });
      const fb = await deps.recallSource(query, agent);
      if (fb.ok) {
        const body = fb.body.trim();
        if (body) {
          fallbackBody = body;
          diag("reflect_fallback_ok", { session: sessionId, chars: body.length });
        } else {
          diag("reflect_fallback_empty", { session: sessionId });
        }
      } else {
        diag("reflect_fallback_failed", { session: sessionId, error: fb.error });
      }
    }

    if (fallbackBody !== undefined) {
      inj.status = "answer";
      inj.text = fallbackBody;
      inj.goalExcerpt = excerpt(prompt);
      diag("inject_ok", { session: sessionId, chars: fallbackBody.length, goal: inj.goalExcerpt, via: "fallback" });
      return;
    }

    if (result.ok) {
      const body = result.body.trim();
      if (body) {
        inj.status = "answer";
        inj.text = body;
        inj.goalExcerpt = excerpt(prompt);
        diag("inject_ok", { session: sessionId, chars: body.length, goal: inj.goalExcerpt });
      } else {
        inj.emptyAttempts++;
        if (inj.emptyAttempts >= config.injectEmptyAttempts) inj.status = "empty";
        diag("inject_empty", { session: sessionId, emptyAttempts: inj.emptyAttempts });
      }
    } else if (result.permanent) {
      // A 4xx fails identically on every later turn — resolve now rather than
      // spend the session's second attempt on a call that cannot succeed.
      inj.status = "empty";
      diag("inject_failed", { session: sessionId, permanent: true, error: result.error });
    } else {
      inj.failAttempts++;
      if (inj.failAttempts >= config.injectFailureAttempts) inj.status = "empty";
      diag("inject_failed", {
        session: sessionId,
        failAttempts: inj.failAttempts,
        error: result.error,
      });
    }
  }

  /** Rebuild the block from frozen pieces — same inputs, same bytes. */
  function currentBlock(sessionId: string): string | undefined {
    const sess = sessionOf(sessionId);
    const context =
      sess.inject?.status === "answer" && sess.inject.text
        ? formatContextSection(sess.inject.text, sess.inject.goalExcerpt)
        : undefined;
    return buildMemoryBlock({ core: sess.coreBlock ?? undefined, context });
  }

  /**
   * Legacy mode: per-message recall through the manager's cached recall path,
   * deduped against core, formatted exactly as the pre-pipeline hook did.
   * NOT frozen — byte-stability is not achievable when the block legitimately
   * varies per turn; that is why this mode is the escape hatch, not default.
   */
  async function perMessageBlock(
    sessionId: string,
    agent: string | undefined,
    prompt: string,
    messages: Message[],
    budgetTokens?: number
  ): Promise<string | undefined> {
    const rt = runtimeOf(sessionId);
    const core = await deps.getCoreMemories(agent);

    let recalled: RecallResult[] = [];
    if (prompt) {
      const key = `${agent ?? ""}:${prompt}`;
      const cached = rt.recallCache.get(key);
      if (cached) {
        recalled = cached;
      } else {
        recalled = await deps.recallForMessage(prompt, messages, agent);
        rt.recallCache.set(key, recalled);
        if (rt.recallCache.size > RECALL_CACHE_MAX) {
          const first = rt.recallCache.keys().next().value;
          if (first) rt.recallCache.delete(first);
        }
      }
    }

    const coreTexts = new Set(core.map((m) => m.text.trim().toLowerCase()));
    const unique = recalled.filter((m) => !coreTexts.has(m.text.trim().toLowerCase()));

    return (
      formatMemoryContext([...core, ...unique], {
        preamble: config.recallPromptPreamble,
        maxTokens: budgetTokens ?? 768,
      }) ?? undefined
    );
  }

  function invalidateCore(): void {
    // "session" (default): the frozen block stands until the next session —
    // refreshing mid-session would change the system block and break the
    // prefix cache. The manager's underlying cache drop already covers the
    // next session. "onInvalidate": refetch at the next model call.
    if (config.coreRefreshPolicy !== "onInvalidate") return;
    for (const [sessionId, sess] of Object.entries(state.sessions)) {
      if (sess.coreBlock !== undefined && runtime.has(sessionId)) {
        sess.coreBlock = undefined;
      }
    }
  }

  return { onModelCall, onPrompt, peekBlock, invalidateCore };
}

function excerpt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > GOAL_EXCERPT_CHARS ? `${compact.slice(0, GOAL_EXCERPT_CHARS)}…` : compact;
}
