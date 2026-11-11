import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRetentionEngine } from "../../src/memory/retain.js";
import { DefaultLogger } from "../../src/logger.js";
import type { HindsightConfig } from "../../src/config.js";
import type { Message, SessionState } from "../../src/types.js";

function createEngine(configOverrides: Partial<HindsightConfig> = {}) {
  const config: HindsightConfig = {
    hindsightApiUrl: "http://localhost:8888",
    hindsightApiToken: "token",
    bankId: "test-bank",
    bankIdPrefix: "",
    dynamicBankId: false,
    dynamicBankGranularity: ["agent", "project"],
    bankMission: "",
    retainMission: null,
    autoRecall: true,
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
    recallPromptPreamble: "prompt",
    recallTypes: ["world", "experience"],
    recallTags: [],
    recallTagsMatch: "any",
    autoInject: "reflect",
    reflectTimeoutMs: 20_000,
    injectTimeoutMs: 8_000,
    injectFailureAttempts: 2,
    injectEmptyAttempts: 5,
    minReflectPromptChars: 8,
    coreRefreshPolicy: "session",
    retainContext: "opencode",
    retainEveryNTurns: 1,
    retainOverlapTurns: 0,
    retainTags: [],
    retainMetadata: {},
    stripSecrets: true,
    stripBase64: true,
    maxRetainedMessageLength: 1000,
    debug: false,
    ...configOverrides,
  };

  const mockClient = {
    createBank: vi.fn().mockResolvedValue({}),
    recall: vi.fn().mockResolvedValue({ results: [] }),
    retain: vi.fn().mockResolvedValue({}),
    reflect: vi.fn().mockResolvedValue({ text: "" }),
    deleteDocument: vi.fn().mockResolvedValue({}),
  };

  const logger = new DefaultLogger(false);
  const engine = createRetentionEngine(mockClient as any, "test-bank", config, logger);

  return { engine, mockClient, config };
}

describe("RetentionEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retains a fact via tool", async () => {
    const { engine, mockClient } = createEngine();
    await engine.retainFact("use pnpm", "project setup", { source: "tool-test" }, ["convention"]);

    expect(mockClient.retain).toHaveBeenCalledTimes(1);
    const [bankId, content, options] = mockClient.retain.mock.calls[0];
    expect(bankId).toBe("test-bank");
    expect(content).toContain("use pnpm");
    expect(options.tags).toContain("fact");
    expect(options.tags).toContain("tool");
    expect(options.tags).toContain("convention");
    expect(options.metadata).toEqual({ source: "tool-test" });
  });

  it("deduplicates in-flight fact retains", async () => {
    const { engine, mockClient } = createEngine();
    await Promise.all([engine.retainFact("same"), engine.retainFact("same"), engine.retainFact("same")]);

    expect(mockClient.retain).toHaveBeenCalledTimes(1);
  });

  it("does not retain secrets", async () => {
    const { engine, mockClient } = createEngine();
    await engine.retainFact("token: sk-abc123");

    const [, content] = mockClient.retain.mock.calls[0];
    expect(content).not.toContain("sk-abc123");
  });

  it("does not retain injected memory tags", async () => {
    const { engine, mockClient } = createEngine();
    await engine.retainFact("answer: <hindsight_memories>old</hindsight_memories>done");

    const [, content] = mockClient.retain.mock.calls[0];
    expect(content).not.toContain("<hindsight_memories>");
  });

  it("retains facts from turns when enough user turns elapsed", async () => {
    const { engine, mockClient } = createEngine({ retainMode: "facts", retainEveryNTurns: 1 });
    const turns: Message[] = [
      { role: "user", content: "what is the test framework?" },
      { role: "assistant", content: "we use vitest" },
    ];

    const state: SessionState = { lastRetainedTurn: 0 };
    const next = await engine.retainTurns("sess-1", turns, state);

    expect(next.lastRetainedTurn).toBe(1);
    expect(mockClient.retain).toHaveBeenCalled();
    const [, content] = mockClient.retain.mock.calls[0];
    expect(content).toContain("vitest");
  });

  it("skips retention when not enough user turns elapsed", async () => {
    const { engine, mockClient } = createEngine({ retainMode: "facts", retainEveryNTurns: 3 });
    const turns: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    const state: SessionState = { lastRetainedTurn: 0 };
    const next = await engine.retainTurns("sess-1", turns, state);

    expect(next.lastRetainedTurn).toBe(0);
    expect(mockClient.retain).not.toHaveBeenCalled();
  });

  it("transcript mode upserts ONE document per session (no chunk lifecycle)", async () => {
    const { engine, mockClient } = createEngine({ retainMode: "transcript", retainEveryNTurns: 1 });
    const turns: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    let state: SessionState = { lastRetainedTurn: 0 };
    state = await engine.retainTurns("sess-1", turns, state);
    expect(state.lastRetainedTurn).toBe(1);

    const [bank, firstContent, firstOptions] = mockClient.retain.mock.calls[0];
    expect(bank).toBe("test-bank");
    expect(firstOptions.documentId).toBe("sess-1");
    expect(firstContent).toContain("hello");

    // A grown transcript upserts the SAME document — no chunks to delete.
    const turns2: Message[] = [
      ...turns,
      { role: "user", content: "next" },
      { role: "assistant", content: "ok" },
    ];
    state = await engine.retainTurns("sess-1", turns2, state);
    expect(mockClient.retain).toHaveBeenCalledTimes(2);
    expect(mockClient.retain.mock.calls[1][2].documentId).toBe("sess-1");
    expect(mockClient.deleteDocument).not.toHaveBeenCalled();
  });

  it("returns early when retainMode is none", async () => {
    const { engine, mockClient } = createEngine({ retainMode: "none" });
    const turns: Message[] = [{ role: "user", content: "hello" }];
    const state: SessionState = { lastRetainedTurn: 0 };
    const next = await engine.retainTurns("sess-1", turns, state);

    expect(next.lastRetainedTurn).toBe(0);
    expect(mockClient.retain).not.toHaveBeenCalled();
  });
});
