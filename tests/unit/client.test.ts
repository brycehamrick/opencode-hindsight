import { describe, it, expect, vi, beforeEach } from "vitest";
import { HindsightClientWrapper, TimeoutError } from "../../src/memory/client.js";
import { DefaultLogger } from "../../src/logger.js";

describe("HindsightClientWrapper", () => {
  const logger = new DefaultLogger(false);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses client.deleteDocument when available", async () => {
    const mockClient = {
      deleteDocument: vi.fn().mockResolvedValue(undefined),
    };

    const wrapper = new HindsightClientWrapper({
      baseUrl: "http://localhost:8888",
      apiKey: null,
      logger,
    });
    (wrapper as any).client = mockClient;

    const result = await wrapper.deleteDocument("test-bank", "doc-1");
    expect(result).toBe(true);
    expect(mockClient.deleteDocument).toHaveBeenCalledWith("test-bank", "doc-1");
  });

  it("falls back to fetch when client.deleteDocument is unavailable", async () => {
    const mockClient = {};
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = new HindsightClientWrapper({
      baseUrl: "http://localhost:8888/",
      apiKey: "hz_secret",
      logger,
    });
    (wrapper as any).client = mockClient;

    const result = await wrapper.deleteDocument("test-bank", "doc-1");
    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8888/v1/default/banks/test-bank/documents/doc-1",
      expect.objectContaining({
        method: "DELETE",
        headers: { Authorization: "Bearer hz_secret" },
      })
    );
  });

  it("throws when fetch fallback returns non-ok", async () => {
    const mockClient = {};
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "not found" });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = new HindsightClientWrapper({
      baseUrl: "http://localhost:8888",
      apiKey: null,
      logger,
    });
    (wrapper as any).client = mockClient;

    await expect(wrapper.deleteDocument("test-bank", "doc-1")).rejects.toThrow("deleteDocument failed");
  });

  it("rejects with TimeoutError when a call exceeds its deadline", async () => {
    const mockClient = {
      reflect: vi.fn(() => new Promise(() => {})), // never settles
    };
    const wrapper = new HindsightClientWrapper({
      baseUrl: "http://localhost:8888",
      apiKey: null,
      logger,
    });
    (wrapper as any).client = mockClient;

    await expect(
      wrapper.reflect("test-bank", "query", { budget: "low", timeoutMs: 20 })
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("passes timeoutMs through nowhere (the SDK takes no signal) and still succeeds when fast", async () => {
    const mockClient = {
      recall: vi.fn().mockResolvedValue({ results: [{ text: "fact" }] }),
    };
    const wrapper = new HindsightClientWrapper({
      baseUrl: "http://localhost:8888",
      apiKey: null,
      logger,
    });
    (wrapper as any).client = mockClient;

    const response = await wrapper.recall("test-bank", "query", {
      budget: "mid",
      timeoutMs: 1000,
    });
    expect(response.results[0].text).toBe("fact");
    // The deadline is wrapper-owned: the SDK call receives no timeout field.
    const passedOptions = mockClient.recall.mock.calls[0][2];
    expect(passedOptions.timeoutMs).toBeUndefined();
    expect(passedOptions.queryTimestamp).toBeDefined();
  });
});
