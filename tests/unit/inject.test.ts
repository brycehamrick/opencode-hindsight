import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInjectionEngine, type InjectionEngineDeps, type InjectSourceResult } from "../../src/inject/engine.js";
import { buildMemoryBlock, formatContextSection, formatCoreSection } from "../../src/inject/block.js";
import { DefaultLogger } from "../../src/logger.js";
import type { HindsightConfig } from "../../src/config.js";
import type { PluginState } from "../../src/types.js";

function baseConfig(overrides: Partial<HindsightConfig> = {}): HindsightConfig {
  return {
    hindsightApiUrl: "http://localhost:8888",
    hindsightApiToken: "token",
    bankId: "test-bank",
    bankIdPrefix: "",
    dynamicBankId: false,
    dynamicBankGranularity: ["agent", "project"],
    bankMission: "",
    retainMission: null,
    autoRecall: true,
    autoInject: "reflect",
    autoRetain: true,
    retainMode: "facts",
    coreMemoryMaxTokens: 64,
    perMessageRecallMaxTokens: 128,
    compactionRecallMaxTokens: 128,
    extractionMaxTokens: 128,
    recallBudget: "mid",
    recallContextTurns: 2,
    recallMaxQueryChars: 200,
    maxRecallQueryTokens: 500,
    recallPromptPreamble: "Relevant memories from past conversations.",
    recallTypes: ["world", "experience"],
    recallTags: [],
    recallTagsMatch: "any",
    reflectTimeoutMs: 20_000,
    injectTimeoutMs: 8_000,
    injectFailureAttempts: 2,
    injectEmptyAttempts: 5,
    minReflectPromptChars: 8,
    coreRefreshPolicy: "session",
    retainContext: "opencode",
    retainEveryNTurns: 3,
    retainOverlapTurns: 2,
    retainTags: [],
    retainMetadata: {},
    stripSecrets: true,
    stripBase64: true,
    maxRetainedMessageLength: 1000,
    debug: false,
    ...overrides,
  };
}

interface Fixture {
  deps: InjectionEngineDeps;
  state: PluginState;
  engine: ReturnType<typeof createInjectionEngine>;
}

function createFixture(
  configOverrides: Partial<HindsightConfig> = {},
  depOverrides: Partial<InjectionEngineDeps> = {}
): Fixture {
  const state: PluginState = { missions: [], sessions: {} };
  const deps: InjectionEngineDeps = {
    config: baseConfig(configOverrides),
    logger: new DefaultLogger(false),
    state,
    persistState: vi.fn().mockResolvedValue(undefined),
    reflectSource: vi.fn().mockResolvedValue({ ok: true, body: "We settled on pnpm workspaces." }),
    recallSource: vi.fn().mockResolvedValue({ ok: true, body: "- fact one" }),
    getCoreMemories: vi.fn().mockResolvedValue([{ text: "user prefers TypeScript" }]),
    recallForMessage: vi.fn().mockResolvedValue([{ text: "recalled fact" }]),
    isBankCold: vi.fn().mockResolvedValue(false),
    ...depOverrides,
  };
  return { deps, state, engine: createInjectionEngine(deps) };
}

const CALL = (prompt?: string, sessionId = "ses-1") => ({
  sessionId,
  agent: "build",
  prompt,
  messages: [{ role: "user", content: prompt ?? "" }],
});

describe("InjectionEngine (reflect mode)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs the source once and freezes the block byte-for-byte", async () => {
    const { deps, engine } = createFixture();

    const first = await engine.onModelCall(CALL("what build tool do we use?"));
    // Same prompt again: a tool continuation within the same turn.
    const same = await engine.onModelCall(CALL("what build tool do we use?"));
    // A new turn after the answer.
    const next = await engine.onModelCall(CALL("and the test runner?"));

    expect(deps.reflectSource).toHaveBeenCalledTimes(1);
    expect(first).toContain("We settled on pnpm workspaces.");
    expect(first).toContain("user prefers TypeScript"); // core section present
    expect(same).toBe(first);
    expect(next).toBe(first); // frozen: identical bytes on later turns
    expect(first).toContain("<hindsight_memories>");
    expect(first).toContain('Recalled for "what build tool do we use?"');
  });

  it("counts turns and persists inject state", async () => {
    const { deps, state, engine } = createFixture();
    await engine.onModelCall(CALL("first substantive question"));
    await engine.onModelCall(CALL("second question"));

    expect(state.sessions["ses-1"].turns).toBe(2);
    expect(state.sessions["ses-1"].inject?.status).toBe("answer");
    expect(deps.persistState).toHaveBeenCalled();
  });

  it("retries a failed source on the next turn, then gives up after the budget", async () => {
    const fail: InjectSourceResult = { ok: false, error: "timeout after 20000ms" };
    // The fallback chain must not rescue this scenario: recall fails too.
    const { deps, engine } = createFixture({}, {
      reflectSource: vi.fn().mockResolvedValueOnce(fail).mockResolvedValueOnce(fail),
      recallSource: vi.fn().mockResolvedValue({ ok: false, error: "also down" }),
    });

    const b1 = await engine.onModelCall(CALL("question one, long enough"));
    const b2 = await engine.onModelCall(CALL("question two, also long"));
    const b3 = await engine.onModelCall(CALL("question three, long too"));

    expect(deps.reflectSource).toHaveBeenCalledTimes(2); // budget of 2 spent
    // Block falls back to core-only while unresolved…
    expect(b1).toContain("user prefers TypeScript");
    expect(b1).not.toContain("pnpm");
    // …and stays core-only once the budget resolves to empty.
    expect(b2).toBe(b3);
    expect(b3).not.toContain("pnpm");
  });

  it("resolves a permanent 4xx immediately without spending the retry budget", async () => {
    // Empty fallback: the permanent failure stands.
    const { deps, state, engine } = createFixture({}, {
      reflectSource: vi.fn().mockResolvedValue({ ok: false, error: "400 bad request", permanent: true }),
      recallSource: vi.fn().mockResolvedValue({ ok: true, body: "" }),
    });

    await engine.onModelCall(CALL("question one, long enough"));
    await engine.onModelCall(CALL("question two, also long"));

    expect(deps.reflectSource).toHaveBeenCalledTimes(1);
    expect(state.sessions["ses-1"].inject?.status).toBe("empty");
  });

  it("gives up after the empty-attempts budget", async () => {
    const { deps, state, engine } = createFixture({}, {
      reflectSource: vi.fn().mockResolvedValue({ ok: true, body: "" }),
    });

    for (let turn = 1; turn <= 5; turn++) {
      await engine.onModelCall(CALL(`question number ${turn}, long enough`));
    }
    await engine.onModelCall(CALL("question six, still long enough"));

    expect(deps.reflectSource).toHaveBeenCalledTimes(5);
    expect(state.sessions["ses-1"].inject?.status).toBe("empty");
  });

  it("defers the first attempt exactly once on a cold bank", async () => {
    const { deps, engine } = createFixture({}, { isBankCold: vi.fn().mockResolvedValue(true) });

    await engine.onModelCall(CALL("question one, long enough"));
    expect(deps.reflectSource).not.toHaveBeenCalled(); // deferred, not spent

    await engine.onModelCall(CALL("question two, also long"));
    expect(deps.reflectSource).toHaveBeenCalledTimes(1); // turn 2 eligible
  });

  it("skips trivially short prompts without consuming an attempt", async () => {
    const { deps, engine } = createFixture();

    await engine.onModelCall(CALL("hi"));
    expect(deps.reflectSource).not.toHaveBeenCalled();

    await engine.onModelCall(CALL("what did we decide about retries?"));
    expect(deps.reflectSource).toHaveBeenCalledTimes(1);
  });

  it("does not retry within a turn on tool continuations", async () => {
    const fail: InjectSourceResult = { ok: false, error: "boom" };
    const { deps, engine } = createFixture({}, {
      reflectSource: vi.fn().mockResolvedValue(fail),
    });

    // Three model calls, same prompt = one turn = one attempt.
    await engine.onModelCall(CALL("question one, long enough"));
    await engine.onModelCall(CALL("question one, long enough"));
    await engine.onModelCall(CALL("question one, long enough"));

    expect(deps.reflectSource).toHaveBeenCalledTimes(1);
  });

  it("strips injected wrapper blocks from the prompt before using it", async () => {
    const { deps, engine } = createFixture();
    const wrapped =
      "<system-reminder>host noise</system-reminder>\nwhat build tool do we use?";

    await engine.onModelCall(CALL(wrapped));

    const query = (deps.reflectSource as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(query).not.toContain("system-reminder");
    expect(query).toContain("what build tool");
  });

  it("returns an undefined block when there is nothing to inject", async () => {
    const { engine } = createFixture({}, {
      getCoreMemories: vi.fn().mockResolvedValue([]),
      reflectSource: vi.fn().mockResolvedValue({ ok: true, body: "" }),
    });

    const block = await engine.onModelCall(CALL("empty bank question"));
    expect(block).toBeUndefined();
  });
});

describe("InjectionEngine (core freeze)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches core memories once per session", async () => {
    const { deps, engine } = createFixture();
    await engine.onModelCall(CALL("question one, long enough"));
    await engine.onModelCall(CALL("question two, also long"));

    expect(deps.getCoreMemories).toHaveBeenCalledTimes(1);
  });

  it("policy 'session' keeps the frozen core after invalidation", async () => {
    const { deps, engine } = createFixture();
    const b1 = await engine.onModelCall(CALL("question one, long enough"));

    engine.invalidateCore();
    const b2 = await engine.onModelCall(CALL("question two, also long"));

    expect(deps.getCoreMemories).toHaveBeenCalledTimes(1);
    expect(b2).toBe(b1);
  });

  it("policy 'onInvalidate' refetches core on the next model call", async () => {
    const getCore = vi.fn()
      .mockResolvedValueOnce([{ text: "old core fact" }])
      .mockResolvedValueOnce([{ text: "fresh core fact" }]);
    const { deps, engine } = createFixture({ coreRefreshPolicy: "onInvalidate" }, {
      getCoreMemories: getCore,
    });

    const b1 = await engine.onModelCall(CALL("question one, long enough"));
    expect(b1).toContain("old core fact");

    engine.invalidateCore();
    const b2 = await engine.onModelCall(CALL("question two, also long"));
    expect(deps.getCoreMemories).toHaveBeenCalledTimes(2);
    expect(b2).toContain("fresh core fact");
    expect(b2).not.toContain("old core fact");
  });

  it("freezes an empty core as null and does not refetch", async () => {
    const { deps, engine } = createFixture({}, {
      getCoreMemories: vi.fn().mockResolvedValue([]),
    });

    const b1 = await engine.onModelCall(CALL("question one, long enough"));
    const b2 = await engine.onModelCall(CALL("question two, also long"));

    expect(deps.getCoreMemories).toHaveBeenCalledTimes(1);
    expect(b1).not.toContain("[core]");
    expect(b2).toBe(b1);
  });
});

describe("InjectionEngine (recall / perMessage / none modes)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("recall mode uses the recall source with the same once-per-session machinery", async () => {
    const { deps, state, engine } = createFixture({ autoInject: "recall" });

    const b1 = await engine.onModelCall(CALL("what build tool do we use?"));
    await engine.onModelCall(CALL("and the test runner?"));

    expect(deps.recallSource).toHaveBeenCalledTimes(1);
    expect(deps.reflectSource).not.toHaveBeenCalled();
    expect(b1).toContain("- fact one");
    expect(state.sessions["ses-1"].inject?.status).toBe("answer");
  });

  it("perMessage mode recalls per prompt and caches within a turn", async () => {
    const { deps, engine } = createFixture({ autoInject: "perMessage" });

    const b1 = await engine.onModelCall(CALL("hello world question"));
    await engine.onModelCall(CALL("hello world question")); // continuation
    const b2 = await engine.onModelCall(CALL("a different question"));

    expect(deps.recallForMessage).toHaveBeenCalledTimes(2);
    expect(b1).toContain("recalled fact");
    expect(b1).toContain("user prefers TypeScript");
    expect(b2).toBeDefined();
  });

  it("perMessage mode dedupes recalled results against core", async () => {
    const { engine } = createFixture({ autoInject: "perMessage" }, {
      getCoreMemories: vi.fn().mockResolvedValue([{ text: "shared fact" }]),
      recallForMessage: vi.fn().mockResolvedValue([{ text: "shared fact" }, { text: "unique fact" }]),
    });

    const block = await engine.onModelCall(CALL("some question here"));
    expect(block).toContain("shared fact");
    expect(block).toContain("unique fact");
    expect(block?.match(/shared fact/g)?.length).toBe(1);
  });

  it("none mode injects nothing and calls nothing", async () => {
    const { deps, engine } = createFixture({ autoInject: "none" });

    const block = await engine.onModelCall(CALL("any question at all"));

    expect(block).toBeUndefined();
    expect(deps.reflectSource).not.toHaveBeenCalled();
    expect(deps.recallSource).not.toHaveBeenCalled();
    expect(deps.getCoreMemories).not.toHaveBeenCalled();
  });
});

describe("InjectionEngine (prompt channel: onPrompt + peekBlock)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("advances the turn at admission and exposes the block via peekBlock", async () => {
    const { deps, state, engine } = createFixture();

    await engine.onPrompt({ sessionId: "ses-p", agent: "build", prompt: "what build tool do we use?" });
    const block = engine.peekBlock("ses-p");

    expect(deps.reflectSource).toHaveBeenCalledTimes(1);
    expect(state.sessions["ses-p"].turns).toBe(1);
    expect(block).toContain("We settled on pnpm workspaces.");
    expect(block).toContain("user prefers TypeScript");
  });

  it("is retry-safe: an identical re-admission is a no-op", async () => {
    const { deps, state, engine } = createFixture();
    const prompt = "what build tool do we use?";

    await engine.onPrompt({ sessionId: "ses-p", agent: "build", prompt });
    await engine.onPrompt({ sessionId: "ses-p", agent: "build", prompt });

    expect(deps.reflectSource).toHaveBeenCalledTimes(1);
    expect(state.sessions["ses-p"].turns).toBe(1);
  });

  it("peekBlock stays constant across later turns (deliver-on-change caller)", async () => {
    const { engine } = createFixture();
    await engine.onPrompt({ sessionId: "ses-p", prompt: "question one, long enough" });
    const b1 = engine.peekBlock("ses-p");
    await engine.onPrompt({ sessionId: "ses-p", prompt: "question two, also long" });
    expect(engine.peekBlock("ses-p")).toBe(b1);
  });

  it("perMessage mode stores a per-turn block at admission", async () => {
    const { deps, engine } = createFixture({ autoInject: "perMessage" });

    await engine.onPrompt({ sessionId: "ses-p", prompt: "hello world question" });
    const block = engine.peekBlock("ses-p");
    expect(block).toContain("recalled fact");

    await engine.onPrompt({ sessionId: "ses-p", prompt: "another question entirely" });
    expect(deps.recallForMessage).toHaveBeenCalledTimes(2);
  });

  it("strips wrapper blocks from the admitted prompt", async () => {
    const { deps, engine } = createFixture();
    await engine.onPrompt({
      sessionId: "ses-p",
      prompt: "<system-reminder>noise</system-reminder>\nwhat build tool do we use?",
    });
    const query = (deps.reflectSource as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(query).not.toContain("system-reminder");
  });

  it("empty admitted prompts are ignored", async () => {
    const { deps, engine } = createFixture();
    await engine.onPrompt({ sessionId: "ses-p", prompt: "   " });
    expect(deps.reflectSource).not.toHaveBeenCalled();
    expect(engine.peekBlock("ses-p")).toBeUndefined();
  });
});

describe("InjectionEngine (reflect fallback chain, WS5)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a retryable reflect failure falls back to recall and caches it as the answer", async () => {
    const { deps, state, engine } = createFixture({}, {
      reflectSource: vi.fn().mockResolvedValue({ ok: false, error: "timeout after 20000ms" }),
      recallSource: vi.fn().mockResolvedValue({ ok: true, body: "- recalled via fallback" }),
    });

    const b1 = await engine.onModelCall(CALL("question one, long enough"));
    await engine.onModelCall(CALL("question two, also long")); // would have retried

    expect(deps.reflectSource).toHaveBeenCalledTimes(1); // fallback answered; no retry
    expect(deps.recallSource).toHaveBeenCalledTimes(1);
    expect(state.sessions["ses-1"].inject?.status).toBe("answer");
    expect(b1).toContain("recalled via fallback");
  });

  it("an empty fallback leaves the failure retryable and counts the attempt", async () => {
    const fail: InjectSourceResult = { ok: false, error: "500" };
    const { deps, state, engine } = createFixture({}, {
      reflectSource: vi.fn().mockResolvedValue(fail),
      recallSource: vi.fn().mockResolvedValue({ ok: true, body: "" }),
    });

    await engine.onModelCall(CALL("question one, long enough"));
    await engine.onModelCall(CALL("question two, also long"));

    expect(deps.reflectSource).toHaveBeenCalledTimes(2); // retried turn 2
    expect(deps.recallSource).toHaveBeenCalledTimes(2); // fallback tried each time
    expect(state.sessions["ses-1"].inject?.failAttempts).toBe(2);
    expect(state.sessions["ses-1"].inject?.status).toBe("empty"); // budget spent
  });

  it("a permanent 4xx skips reflect retries but still gets one fallback recall", async () => {
    const { deps, state, engine } = createFixture({}, {
      reflectSource: vi.fn().mockResolvedValue({ ok: false, error: "400", permanent: true }),
      recallSource: vi.fn().mockResolvedValue({ ok: true, body: "- fallback answer" }),
    });

    const block = await engine.onModelCall(CALL("question one, long enough"));

    expect(deps.reflectSource).toHaveBeenCalledTimes(1);
    expect(deps.recallSource).toHaveBeenCalledTimes(1);
    expect(state.sessions["ses-1"].inject?.status).toBe("answer");
    expect(block).toContain("fallback answer");
  });

  it("a permanent 4xx with an empty fallback resolves empty immediately", async () => {
    const { deps, state, engine } = createFixture({}, {
      reflectSource: vi.fn().mockResolvedValue({ ok: false, error: "400", permanent: true }),
      recallSource: vi.fn().mockResolvedValue({ ok: true, body: "" }),
    });

    await engine.onModelCall(CALL("question one, long enough"));
    await engine.onModelCall(CALL("question two, also long"));

    expect(deps.reflectSource).toHaveBeenCalledTimes(1);
    expect(deps.recallSource).toHaveBeenCalledTimes(1);
    expect(state.sessions["ses-1"].inject?.status).toBe("empty");
  });

  it("recall mode failures do not trigger the fallback (no chain below recall)", async () => {
    const { deps, state, engine } = createFixture({ autoInject: "recall" }, {
      recallSource: vi.fn().mockResolvedValue({ ok: false, error: "timeout after 8000ms" }),
    });

    await engine.onModelCall(CALL("question one, long enough"));
    await engine.onModelCall(CALL("question two, also long"));

    expect(deps.recallSource).toHaveBeenCalledTimes(2); // its own budget, no fallback
    expect(deps.reflectSource).not.toHaveBeenCalled();
    expect(state.sessions["ses-1"].inject?.failAttempts).toBe(2);
  });
});

describe("block formatting", () => {
  it("builds a tagged block from sections", () => {
    const block = buildMemoryBlock({
      core: "[core] Stable preferences:\n- a",
      context: "[context]\nWe settled on pnpm.",
    });
    expect(block).toContain("<hindsight_memories>");
    expect(block).toContain("[core] Stable preferences:");
    expect(block).toContain("We settled on pnpm.");
    expect(block).toContain("hindsight_recall");
    expect(block?.endsWith("</hindsight_memories>")).toBe(true);
  });

  it("returns undefined for empty sections", () => {
    expect(buildMemoryBlock({})).toBeUndefined();
    expect(buildMemoryBlock({ core: undefined, context: undefined })).toBeUndefined();
  });

  it("formats core and context sections deterministically", () => {
    const core = formatCoreSection([{ text: "fact", type: "world" }]);
    expect(core).toContain("[core]");
    expect(core).toContain("- fact [world]");

    const ctx = formatContextSection("Body text.", "the goal");
    expect(ctx).toBe('[context] Recalled for "the goal".\nBody text.');
  });
});
