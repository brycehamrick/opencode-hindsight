import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("HINDSIGHT_")) delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("applies defaults", () => {
    const config = loadConfig();
    expect(config.retainMode).toBe("facts");
    expect(config.recallBudget).toBe("mid");
    expect(config.autoRecall).toBe(true);
    expect(config.autoRetain).toBe(true);
    expect(config.maxRecallQueryTokens).toBe(500);
    expect(config.autoInject).toBe("reflect");
    expect(config.reflectTimeoutMs).toBe(20_000);
    expect(config.injectTimeoutMs).toBe(8_000);
    expect(config.injectFailureAttempts).toBe(2);
    expect(config.injectEmptyAttempts).toBe(5);
    expect(config.minReflectPromptChars).toBe(8);
    expect(config.coreRefreshPolicy).toBe("session");
  });

  it("maps an explicit autoRecall:false to autoInject 'none'", () => {
    const config = loadConfig({ autoRecall: false });
    expect(config.autoInject).toBe("none");
  });

  it("autoRecall:true upgrades to the once-per-session default", () => {
    const config = loadConfig({ autoRecall: true });
    expect(config.autoInject).toBe("reflect");
  });

  it("an explicit autoInject wins over autoRecall", () => {
    const config = loadConfig({ autoRecall: false, autoInject: "perMessage" });
    expect(config.autoInject).toBe("perMessage");
  });

  it("applies plugin options", () => {
    const config = loadConfig({ bankId: "my-project", recallBudget: "high" });
    expect(config.bankId).toBe("my-project");
    expect(config.recallBudget).toBe("high");
  });

  it("supports connection options in plugin options", () => {
    const configWithUrl = loadConfig({ hindsightApiUrl: "http://localhost:8888" });
    expect(configWithUrl.hindsightApiUrl).toBe("http://localhost:8888");
    expect(configWithUrl.hindsightApiToken).toBeNull();

    const configWithToken = loadConfig({
      hindsightApiUrl: "https://api.hindsight.vectorize.io",
      hindsightApiToken: "hz_secret",
    });
    expect(configWithToken.hindsightApiUrl).toBe("https://api.hindsight.vectorize.io");
    expect(configWithToken.hindsightApiToken).toBe("hz_secret");
  });

  it("applies environment variable overrides", () => {
    process.env.HINDSIGHT_BANK_ID = "env-bank";
    process.env.HINDSIGHT_AUTO_RECALL = "false";
    process.env.HINDSIGHT_RETAIN_EVERY_N_TURNS = "5";
    process.env.HINDSIGHT_RECALL_TAGS = "a,b,c";
    process.env.HINDSIGHT_MAX_RECALL_QUERY_TOKENS = "300";

    const config = loadConfig({ bankId: "opt-bank" });
    expect(config.bankId).toBe("env-bank");
    expect(config.autoRecall).toBe(false);
    expect(config.retainEveryNTurns).toBe(5);
    expect(config.recallTags).toEqual(["a", "b", "c"]);
    expect(config.maxRecallQueryTokens).toBe(300);
  });

  it("falls back invalid enum values", () => {
    const config = loadConfig({
      retainMode: "invalid",
      recallBudget: "huge",
      recallTagsMatch: "maybe",
    });
    expect(config.retainMode).toBe("facts");
    expect(config.recallBudget).toBe("mid");
    expect(config.recallTagsMatch).toBe("any");
  });

  it("falls back autoInject and coreRefreshPolicy on invalid values", () => {
    const config = loadConfig({
      autoInject: "sometimes" as never,
      coreRefreshPolicy: "always" as never,
    });
    expect(config.autoInject).toBe("reflect");
    expect(config.coreRefreshPolicy).toBe("session");
  });

  it("falls back inject tuning options on invalid values", () => {
    const config = loadConfig({
      reflectTimeoutMs: 0,
      injectTimeoutMs: Number.NaN,
      injectFailureAttempts: -1,
      injectEmptyAttempts: -3,
      minReflectPromptChars: -10,
    });
    expect(config.reflectTimeoutMs).toBe(20_000);
    expect(config.injectTimeoutMs).toBe(8_000);
    expect(config.injectFailureAttempts).toBe(2);
    expect(config.injectEmptyAttempts).toBe(5);
    expect(config.minReflectPromptChars).toBe(8);
  });

  it("treats zero attempt budgets and zero min-chars as deliberate settings", () => {
    const config = loadConfig({
      injectFailureAttempts: 0,
      injectEmptyAttempts: 0,
      minReflectPromptChars: 0,
    });
    expect(config.injectFailureAttempts).toBe(0);
    expect(config.injectEmptyAttempts).toBe(0);
    expect(config.minReflectPromptChars).toBe(0);
  });

  it("falls back maxRecallQueryTokens on invalid values", () => {
    const negative = loadConfig({ maxRecallQueryTokens: -1 });
    expect(negative.maxRecallQueryTokens).toBe(500);

    process.env.HINDSIGHT_MAX_RECALL_QUERY_TOKENS = "not-a-number";
    const fromEnv = loadConfig();
    expect(fromEnv.maxRecallQueryTokens).toBe(500);
  });
});
