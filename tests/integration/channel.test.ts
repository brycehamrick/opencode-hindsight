/**
 * Channel integration tests (MEMORY_PIPELINE_PLAN.md WS1, Phase 2 exit
 * criteria): across a simulated multi-turn session on the synthetic channel,
 * the assembled system prompt stays constant (empty), the block is delivered
 * exactly once as a stored synthetic message, and the once-per-session source
 * runs exactly once.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { registerHooks } from "../../src/hooks/index.js";
import { createMemoryManager } from "../../src/memory/manager.js";
import { DefaultLogger } from "../../src/logger.js";
import type { HindsightConfig } from "../../src/config.js";

const mockClient = {
  createBank: vi.fn().mockResolvedValue({}),
  recall: vi.fn().mockImplementation(async (_bankId: string, query: string) => {
    if (String(query).includes("core memories")) {
      return { results: [{ text: "user prefers TypeScript", type: "world" }] };
    }
    return { results: [] };
  }),
  retain: vi.fn().mockResolvedValue({}),
  reflect: vi.fn().mockResolvedValue({ text: "We settled on pnpm workspaces." }),
  deleteDocument: vi.fn().mockResolvedValue({}),
};

vi.mock("../../src/memory/client.js", () => ({
  createHindsightClientWrapper: vi.fn(() => mockClient),
  errorStatus: () => undefined,
}));

function config(): HindsightConfig {
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
    recallPromptPreamble: "preamble",
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
    retainEveryNTurns: 100, // keep the retention gate out of the way
    retainOverlapTurns: 0,
    retainTags: [],
    retainMetadata: {},
    stripSecrets: true,
    stripBase64: true,
    maxRetainedMessageLength: 1000,
    debug: false,
  };
}

function createManager() {
  return createMemoryManager({
    config: config(),
    state: { missions: [], sessions: {} },
    directory: "/work/proj-a",
    logger: new DefaultLogger(false),
    storage: {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    },
  });
}

interface FakeCtx {
  hooks: Map<string, (event: any) => Promise<void>>;
  synthetic: ReturnType<typeof vi.fn>;
  ctx: Record<string, unknown>;
}

function createCtx(withSynthetic: boolean): FakeCtx {
  const hooks = new Map<string, (event: any) => Promise<void>>();
  const fake: FakeCtx = {
    hooks,
    synthetic: vi.fn().mockResolvedValue({}),
    ctx: {},
  };
  fake.ctx = {
    session: {
      hook: vi.fn(async (name: string, cb: (event: any) => Promise<void>) => {
        hooks.set(name, cb);
      }),
      get: vi.fn().mockResolvedValue({ location: { directory: "/work/proj-a" } }),
      ...(withSynthetic ? { synthetic: fake.synthetic } : {}),
    },
    event: {
      subscribe: vi.fn(() => {
        const iterator = {
          next: async () => ({ done: true, value: undefined }),
          [Symbol.asyncIterator]: () => iterator,
        };
        return iterator;
      }),
    },
  };
  return fake;
}

async function admitPrompt(fake: FakeCtx, text: string, sessionId = "ses-chan") {
  await fake.hooks.get("prompt")!({ sessionID: sessionId, prompt: { text }, agent: "build" });
}

async function modelCall(fake: FakeCtx, texts: string[], sessionId = "ses-chan") {
  const event = {
    sessionID: sessionId,
    messages: texts.map((t) => ({ role: "user", content: t })),
    system: [],
    agent: "build",
    budget: { memory: 512 },
  };
  await fake.hooks.get("context")!(event);
  return event.system.map((p: any) => p.text).join("\n");
}

describe("injection channel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("synthetic channel: 20 turns, constant system prompt, one delivery, one reflect", async () => {
    const memory = createManager();
    await memory.initialize();
    const fake = createCtx(true);
    await registerHooks(fake.ctx, memory);

    expect(fake.hooks.has("prompt")).toBe(true);
    expect(fake.hooks.has("context")).toBe(true);

    const systemHashes = new Set<string>();
    for (let turn = 1; turn <= 20; turn++) {
      const prompt = `question ${turn} about the parser refactor, long enough`;
      await admitPrompt(fake, prompt);
      const system = await modelCall(fake, [prompt]);
      systemHashes.add(createHash("sha256").update(system).digest("hex"));
    }

    // The system prompt never carries the block — it is delivered as a stored
    // synthetic message instead, exactly once (the block never changes).
    expect(systemHashes.size).toBe(1);
    expect(fake.synthetic).toHaveBeenCalledTimes(1);
    const delivered = fake.synthetic.mock.calls[0][0];
    expect(delivered.resume).toBe(false);
    expect(delivered.description).toBe("Hindsight memory");
    expect(delivered.text).toContain("We settled on pnpm workspaces.");
    expect(delivered.text).toContain("user prefers TypeScript");
    expect(delivered.text).toContain("<hindsight_memories>");

    // The once-per-session source ran exactly once, at budget "low".
    expect(mockClient.reflect).toHaveBeenCalledTimes(1);
    expect(mockClient.reflect.mock.calls[0][2].budget).toBe("low");
  });

  it("falls back to the system channel after repeated synthetic failures", async () => {
    const memory = createManager();
    await memory.initialize();
    const fake = createCtx(true);
    fake.synthetic.mockRejectedValue(new Error("unsupported"));
    await registerHooks(fake.ctx, memory);

    // Two failing admissions trip the circuit breaker.
    await admitPrompt(fake, "first question, long enough");
    await admitPrompt(fake, "second question, also long");
    expect(fake.synthetic).toHaveBeenCalledTimes(2);

    // From here the context-hook channel serves the frozen block.
    const system = await modelCall(fake, ["second question, also long"]);
    expect(system).toContain("We settled on pnpm workspaces.");
  });

  it("hosts without ctx.session.synthetic stay on the system channel", async () => {
    const memory = createManager();
    await memory.initialize();
    const fake = createCtx(false);
    await registerHooks(fake.ctx, memory);

    expect(fake.hooks.has("prompt")).toBe(false);

    const prompt = "a plain question that is long enough";
    const s1 = await modelCall(fake, [prompt]);
    const s2 = await modelCall(fake, [prompt]);
    expect(s1).toContain("<hindsight_memories>");
    expect(s2).toBe(s1); // frozen: byte-stable across model calls
  });
});
