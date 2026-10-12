import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerHooks } from "../../src/hooks/index.js";
import type { MemoryManager } from "../../src/memory/manager.js";

function createMockMemory(): MemoryManager {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getCoreMemories: vi.fn().mockResolvedValue([{ text: "core fact" }]),
    recallForMessage: vi.fn().mockResolvedValue([{ text: "recalled fact" }]),
    recallByQuery: vi.fn().mockResolvedValue([{ text: "query result" }]),
    reflect: vi.fn().mockResolvedValue("reflected"),
    retainTurns: vi.fn().mockResolvedValue(undefined),
    retainFact: vi.fn().mockResolvedValue(undefined),
    forget: vi.fn().mockResolvedValue(false),
    onCompaction: vi.fn().mockResolvedValue(null),
  } as unknown as MemoryManager;
}

describe("registerHooks", () => {
  let sessionHooks: any[];
  let eventStreamController: AbortController | null = null;

  beforeEach(() => {
    sessionHooks = [];
  });

  function createCtx() {
    return {
      session: {
        hook: vi.fn((_name: string, cb: any) => {
          sessionHooks.push(cb);
          return Promise.resolve();
        }),
      },
      event: {
        subscribe: vi.fn((opts?: { signal?: AbortSignal }) => {
          eventStreamController = opts?.signal ? new AbortController() : null;
          const signal = opts?.signal;
          let yielded = false;
          const iterator = {
            next: async () => {
              if (yielded || signal?.aborted) return { done: true, value: undefined };
              yielded = true;
              return { done: false, value: { type: "session.idle", properties: { sessionID: "sess-1" }, messages: [{ role: "user", content: "hi" }], agent: { id: "reviewer" } } };
            },
            [Symbol.asyncIterator]: () => iterator,
          };
          return iterator;
        }),
      },
    };
  }

  it("registers a context hook that injects core + recalled memory", async () => {
    const memory = createMockMemory();
    const cleanup = await registerHooks(createCtx(), memory);

    expect(sessionHooks.length).toBe(1);

    const event = { messages: [{ role: "user", content: "hello" }], system: [], agent: { id: "reviewer" } };
    await sessionHooks[0](event);

    expect(memory.getCoreMemories).toHaveBeenCalledWith("reviewer");
    expect(memory.recallForMessage).toHaveBeenCalledWith("hello", [{ role: "user", content: "hello" }], "reviewer");
    expect(event.system.length).toBe(1);
    expect(event.system[0].type).toBe("text");
    expect(event.system[0].text).toContain("core fact");
    expect(event.system[0].text).toContain("recalled fact");

    cleanup();
  });

  it("extracts text from AI SDK content-part arrays (OpenCode 2.0.27 format)", async () => {
    const memory = createMockMemory();
    await registerHooks(createCtx(), memory);

    const event = {
      messages: [
        { role: "user", content: [{ type: "text", text: "what did we decide" }] },
      ],
      system: [],
      agent: "build",
    };
    await sessionHooks[0](event);

    expect(memory.getCoreMemories).toHaveBeenCalledWith("build");
    expect(memory.recallForMessage).toHaveBeenCalledWith(
      "what did we decide",
      [{ role: "user", content: "what did we decide" }],
      "build"
    );
    expect(event.system.length).toBe(1);
    expect(event.system[0].type).toBe("text");
  });

  it("skips recall when the user message has no extractable text", async () => {
    const memory = createMockMemory();
    await registerHooks(createCtx(), memory);

    const event = {
      messages: [{ role: "user", content: [{ type: "media", mediaType: "image/png", data: "..." }] }],
      system: [],
    };
    await sessionHooks[0](event);

    expect(memory.recallForMessage).not.toHaveBeenCalled();
    expect(event.system.length).toBe(1);
  });

  it("deduplicates recalled results that are already in core memory", async () => {
    const memory = createMockMemory();
    (memory as any).getCoreMemories.mockResolvedValue([{ text: "shared fact" }]);
    (memory as any).recallForMessage.mockResolvedValue([{ text: "shared fact" }, { text: "unique fact" }]);

    await registerHooks(createCtx(), memory);
    const event = { messages: [{ role: "user", content: "hello" }], system: [] };
    await sessionHooks[0](event);

    expect(event.system[0].text).toContain("shared fact");
    expect(event.system[0].text).toContain("unique fact");
    expect(event.system[0].text.match(/shared fact/g)?.length).toBe(1);
  });

  it("caches recall for the same user message", async () => {
    const memory = createMockMemory();
    await registerHooks(createCtx(), memory);

    const event = { messages: [{ role: "user", content: "hello" }], system: [] };
    await sessionHooks[0](event);
    await sessionHooks[0](event);

    expect(memory.recallForMessage).toHaveBeenCalledTimes(1);
  });

  it("handles errors in the context hook gracefully", async () => {
    const memory = createMockMemory();
    (memory as any).getCoreMemories.mockRejectedValue(new Error("boom"));

    await registerHooks(createCtx(), memory);
    const event = { messages: [{ role: "user", content: "hello" }], system: [] };

    await expect(sessionHooks[0](event)).resolves.not.toThrow();
    expect(event.system.length).toBe(0);
  });

  it("retains messages on session.idle events", async () => {
    const memory = createMockMemory();
    const cleanup = await registerHooks(createCtx(), memory);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(memory.retainTurns).toHaveBeenCalledWith("sess-1", [{ role: "user", content: "hi" }], "reviewer");
    cleanup();
  });
});
