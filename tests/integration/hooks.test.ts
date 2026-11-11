import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerHooks } from "../../src/hooks/index.js";
import type { MemoryManager } from "../../src/memory/manager.js";
import type { InjectionEngine } from "../../src/inject/engine.js";

const BLOCK = "<hindsight_memories>\n[core] stable fact\n[context] synthesis\n</hindsight_memories>";

function createMockMemory(): MemoryManager {
  const injection = {
    onModelCall: vi.fn().mockResolvedValue(BLOCK),
    invalidateCore: vi.fn(),
  } as unknown as InjectionEngine;
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    setWorkspaceDirectory: vi.fn(),
    injection,
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

  beforeEach(() => {
    sessionHooks = [];
  });

  function createCtx(events?: any[], opts?: { noContext?: boolean }) {
    // Queue-based event stream: registration happens before any session
    // activity, exactly like the real host — events are pushed after the
    // session has been admitted.
    const queue: any[] = events ? [...events] : [];
    let waiter: (() => void) | null = null;
    const wake = () => {
      const w = waiter;
      waiter = null;
      w?.();
    };

    const ctx = {
      session: {
        hook: vi.fn((_name: string, cb: any) => {
          sessionHooks.push(cb);
          return Promise.resolve();
        }),
        get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID,
          location: { directory: "/work/proj-a" },
        })),
        // Authoritative transcript refetch (WS4): includes the final reply
        // the idle-event payload predates.
        ...(opts?.noContext
          ? {}
          : {
              context: vi.fn(async ({ sessionID }: { sessionID: string }) => {
                if (sessionID === "sess-1") {
                  return [
                    { role: "user", content: "hi" },
                    { role: "assistant", content: "the refetched reply" },
                  ];
                }
                return [];
              }),
            }),
      },
      event: {
        subscribe: vi.fn((subscribeOpts?: { signal?: AbortSignal }) => {
          const signal = subscribeOpts?.signal;
          signal?.addEventListener("abort", wake);
          const iterator = {
            next: async () => {
              while (!queue.length && !signal?.aborted) {
                await new Promise<void>((resolve) => {
                  waiter = resolve;
                });
              }
              if (queue.length) return { done: false, value: queue.shift() };
              return { done: true, value: undefined };
            },
            [Symbol.asyncIterator]: () => iterator,
          };
          return iterator;
        }),
      },
    };

    return {
      ctx,
      push: (event: any) => {
        queue.push(event);
        wake();
      },
    };
  }

  async function admit(sessionId: string) {
    // The context hook (index 0) registers the session with the
    // bank-isolation guard's admission set.
    await sessionHooks[0]({ sessionID: sessionId, messages: [], system: [] });
  }

  it("registers a context hook that delegates to the injection engine and pushes its block", async () => {
    const memory = createMockMemory();
    await registerHooks(createCtx().ctx, memory);

    // context + compaction hooks are registered (no prompt hook: no synthetic
    // support in this fake host).
    expect(sessionHooks.length).toBe(2);

    const event = { sessionID: "ses-1", messages: [{ role: "user", content: "hello" }], system: [], agent: { id: "reviewer" }, budget: { memory: 512 } };
    await sessionHooks[0](event);

    expect(memory.setWorkspaceDirectory).toHaveBeenCalledWith("/work/proj-a");
    expect(memory.injection.onModelCall).toHaveBeenCalledWith({
      sessionId: "ses-1",
      agent: "reviewer",
      prompt: "hello",
      messages: [{ role: "user", content: "hello" }],
      budgetTokens: 512,
    });
    expect(event.system.length).toBe(1);
    expect(event.system[0].type).toBe("text");
    expect(event.system[0].text).toBe(BLOCK);
  });

  it("extracts text from AI SDK content-part arrays (OpenCode 2.0.27 format)", async () => {
    const memory = createMockMemory();
    await registerHooks(createCtx().ctx, memory);

    const event = {
      messages: [
        { role: "user", content: [{ type: "text", text: "what did we decide" }] },
      ],
      system: [],
      agent: "build",
    };
    await sessionHooks[0](event);

    expect(memory.injection.onModelCall).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "build",
        prompt: "what did we decide",
        messages: [{ role: "user", content: "what did we decide" }],
      })
    );
  });

  it("passes an undefined prompt when the user message has no extractable text", async () => {
    const memory = createMockMemory();
    (memory.injection as any).onModelCall.mockResolvedValue(undefined);
    await registerHooks(createCtx().ctx, memory);

    const event = {
      messages: [{ role: "user", content: [{ type: "media", mediaType: "image/png", data: "..." }] }],
      system: [],
    };
    await sessionHooks[0](event);

    expect(memory.injection.onModelCall).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: undefined })
    );
    expect(event.system.length).toBe(0);
  });

  it("calls the engine once per model call (caching is the engine's job)", async () => {
    const memory = createMockMemory();
    await registerHooks(createCtx().ctx, memory);

    const event = { messages: [{ role: "user", content: "hello" }], system: [] };
    await sessionHooks[0](event);
    await sessionHooks[0](event);

    expect(memory.injection.onModelCall).toHaveBeenCalledTimes(2);
  });

  it("pushes nothing when the engine returns no block", async () => {
    const memory = createMockMemory();
    (memory.injection as any).onModelCall.mockResolvedValue(undefined);

    await registerHooks(createCtx().ctx, memory);
    const event = { messages: [{ role: "user", content: "hello" }], system: [] };
    await sessionHooks[0](event);

    expect(event.system.length).toBe(0);
  });

  it("handles errors in the context hook gracefully", async () => {
    const memory = createMockMemory();
    (memory.injection as any).onModelCall.mockRejectedValue(new Error("boom"));

    await registerHooks(createCtx().ctx, memory);
    const event = { messages: [{ role: "user", content: "hello" }], system: [] };

    await expect(sessionHooks[0](event)).resolves.not.toThrow();
    expect(event.system.length).toBe(0);
  });

  it("retains messages on session.idle events via the refetched transcript", async () => {
    const memory = createMockMemory();
    const { ctx, push } = createCtx();
    const cleanup = await registerHooks(ctx, memory);

    await admit("sess-1");
    push({
      type: "session.idle",
      properties: { sessionID: "sess-1" },
      agent: { id: "reviewer" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(memory.retainTurns).toHaveBeenCalledWith(
      "sess-1",
      [{ role: "user", content: "hi" }, { role: "assistant", content: "the refetched reply" }],
      "reviewer",
      { finalFlush: false }
    );
    cleanup();
  });

  it("ignores idle events from sessions it never admitted (bank isolation)", async () => {
    const memory = createMockMemory();
    const { ctx, push } = createCtx();
    const cleanup = await registerHooks(ctx, memory);

    await admit("sess-1"); // only THIS session is admitted
    push({
      type: "session.idle",
      properties: { sessionID: "sess-foreign" },
      messages: [{ role: "user", content: "other project" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // No retain, and the foreign transcript was never even fetched.
    expect(memory.retainTurns).not.toHaveBeenCalled();
    expect(ctx.session.context).not.toHaveBeenCalled();
    cleanup();
  });

  it("retains on session.execution.succeeded (one-shot run sessions)", async () => {
    const memory = createMockMemory();
    const { ctx, push } = createCtx();
    const cleanup = await registerHooks(ctx, memory);

    await admit("sess-1");
    push({ type: "session.execution.succeeded", properties: { sessionID: "sess-1" } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(memory.retainTurns).toHaveBeenCalledWith(
      "sess-1",
      [{ role: "user", content: "hi" }, { role: "assistant", content: "the refetched reply" }],
      undefined,
      { finalFlush: false }
    );
    cleanup();
  });

  it("session.closed triggers a final flush", async () => {
    const memory = createMockMemory();
    const { ctx, push } = createCtx();
    const cleanup = await registerHooks(ctx, memory);

    await admit("sess-1");
    push({ type: "session.closed", properties: { sessionID: "sess-1" } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(memory.retainTurns).toHaveBeenCalledWith(
      "sess-1",
      expect.any(Array),
      undefined,
      { finalFlush: true }
    );
    cleanup();
  });

  it("falls back to the event payload when no transcript API exists", async () => {
    const memory = createMockMemory();
    const { ctx, push } = createCtx(undefined, { noContext: true });
    const cleanup = await registerHooks(ctx, memory);

    await admit("sess-1");
    push({
      type: "session.idle",
      properties: { sessionID: "sess-1" },
      messages: [{ role: "user", content: "from event" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(memory.retainTurns).toHaveBeenCalledWith(
      "sess-1",
      [{ role: "user", content: "from event" }],
      undefined,
      { finalFlush: false }
    );
    cleanup();
  });

  it("registers a compaction hook that injects recalled memory context", async () => {
    const memory = createMockMemory();
    (memory.onCompaction as any).mockResolvedValue("compaction memory context");
    await registerHooks(createCtx().ctx, memory);

    // context hook is index 0, compaction hook index 1.
    const event = {
      sessionID: "sess-1",
      messages: [{ role: "user", content: "summarize this" }],
      system: [],
    };
    await sessionHooks[1](event);

    expect(memory.onCompaction).toHaveBeenCalledWith(
      "sess-1",
      [{ role: "user", content: "summarize this" }],
      undefined
    );
    expect(event.system.length).toBe(1);
    expect(event.system[0].text).toBe("compaction memory context");
  });

  it("compaction hook fails open on errors", async () => {
    const memory = createMockMemory();
    (memory.onCompaction as any).mockRejectedValue(new Error("boom"));
    await registerHooks(createCtx().ctx, memory);

    const event = {
      sessionID: "sess-1",
      messages: [{ role: "user", content: "summarize this" }],
      system: [],
    };
    await expect(sessionHooks[1](event)).resolves.not.toThrow();
    expect(event.system.length).toBe(0);
  });
});
