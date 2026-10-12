import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemoryManager } from "../../src/memory/manager.js";
import { DefaultLogger } from "../../src/logger.js";
import type { HindsightConfig } from "../../src/config.js";
import type { PluginState, Message } from "../../src/types.js";

const mockClient = {
  createBank: vi.fn().mockResolvedValue({}),
  recall: vi.fn().mockResolvedValue({ results: [] }),
  retain: vi.fn().mockResolvedValue({}),
  reflect: vi.fn().mockResolvedValue({ text: "reflected answer" }),
  deleteDocument: vi.fn().mockResolvedValue({}),
};

vi.mock("../../src/memory/client.js", () => ({
  createHindsightClientWrapper: vi.fn(() => mockClient),
}));

function createManager(overrides: Partial<HindsightConfig> = {}) {
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
    recallPromptPreamble: "prompt",
    recallTypes: ["world", "experience"],
    recallTags: [],
    recallTagsMatch: "any",
    retainContext: "opencode",
    retainEveryNTurns: 1,
    retainOverlapTurns: 0,
    retainTags: [],
    retainMetadata: {},
    stripSecrets: true,
    stripBase64: true,
    maxRetainedMessageLength: 1000,
    debug: false,
    ...overrides,
  };

  const logger = new DefaultLogger(config.debug);

  return createMemoryManager({
    config,
    state: { missions: [], sessions: {} },
    directory: "/tmp/test",
    logger,
    storage: {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    },
  });
}

describe("MemoryManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives dynamic bank IDs per workspace directory as sessions report in", () => {
    const manager = createManager({
      dynamicBankId: true,
      dynamicBankGranularity: ["agent", "gitProject"],
    });

    // Initial directory (setup-time guess) drives the first bank.
    expect(manager.getDiagnostics("build").bankId).toBe("build::test");

    // A session reporting a different directory re-derives the bank.
    manager.setWorkspaceDirectory("/work/other-repo");
    expect(manager.getDiagnostics("build").bankId).toBe("build::other-repo");
    expect(manager.getDiagnostics().directory).toBe("/work/other-repo");

    // Same directory again is a no-op; empty strings are ignored.
    manager.setWorkspaceDirectory("/work/other-repo");
    manager.setWorkspaceDirectory("");
    expect(manager.getDiagnostics().directory).toBe("/work/other-repo");
  });

  it("initializes and creates bank mission", async () => {
    const manager = createManager({ bankMission: "test mission" });

    await manager.initialize();

    expect(mockClient.createBank).toHaveBeenCalledWith("test-bank", {
      reflectMission: "test mission",
      retainMission: undefined,
    });
  });

  it("recalls core memories", async () => {
    mockClient.recall.mockResolvedValueOnce({
      results: [{ text: "user prefers TypeScript", type: "core" }],
    });

    const manager = createManager();
    await manager.initialize();
    const core = await manager.getCoreMemories();

    expect(core.length).toBe(1);
    expect(core[0].text).toBe("user prefers TypeScript");
  });

  it("recalls for message", async () => {
    mockClient.recall.mockImplementation(async (_bankId: string, query: string) => {
      if (query.includes("core")) return { results: [] };
      return { results: [{ text: "we use vitest", type: "fact" }] };
    });

    const manager = createManager();
    await manager.initialize();
    const messages: Message[] = [{ role: "user", content: "how do we test?" }];
    const recalled = await manager.recallForMessage("how do we test?", messages);

    expect(recalled.length).toBe(1);
    expect(recalled[0].text).toBe("we use vitest");
  });

  it("retains facts from tool", async () => {
    const manager = createManager();
    await manager.initialize();

    await manager.retainFact("use pnpm", "project setup", { source: "tool" }, ["convention"]);

    expect(mockClient.retain).toHaveBeenCalled();
    const call = mockClient.retain.mock.calls[0];
    expect(call[0]).toBe("test-bank");
    expect(call[1]).toContain("use pnpm");
    expect(call[2].tags).toContain("convention");
  });

  it("does not retain secrets", async () => {
    const manager = createManager();
    await manager.initialize();

    await manager.retainFact("token: sk-abc123", "setup");

    const call = mockClient.retain.mock.calls[0];
    expect(call[1]).not.toContain("sk-abc123");
  });

  it("scopes memory to different agents", async () => {
    mockClient.recall.mockImplementation(async (bankId: string, query: string) => {
      if (query.includes("core")) return { results: [] };
      // Return different memories per agent bank.
      if (bankId.includes("reviewer")) return { results: [{ text: "reviewer memory" }] };
      if (bankId.includes("debugger")) return { results: [{ text: "debugger memory" }] };
      return { results: [{ text: "default memory" }] };
    });

    const manager = createManager({ dynamicBankId: true, dynamicBankGranularity: ["agent", "project"] });
    await manager.initialize();

    const defaultResults = await manager.recallForMessage("hello", [], undefined);
    expect(defaultResults[0].text).toBe("default memory");

    const reviewerResults = await manager.recallForMessage("hello", [], "reviewer");
    expect(reviewerResults[0].text).toBe("reviewer memory");

    const debuggerResults = await manager.recallForMessage("hello", [], "debugger");
    expect(debuggerResults[0].text).toBe("debugger memory");
  });

  it("reflects on memory", async () => {
    const manager = createManager();
    await manager.initialize();

    const answer = await manager.reflect("what do we know?");
    expect(answer).toBe("reflected answer");
  });
});
