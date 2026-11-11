#!/usr/bin/env node
/**
 * Injection benchmark + structural regression gate (MEMORY_PIPELINE_PLAN.md
 * WS7, Phase 5).
 *
 * Replays a scripted 20-turn session through the REAL built plugin
 * (dist/index.js) against a fake Hindsight HTTP server, once with the new
 * default (`autoInject: "reflect"`) and once with the legacy behavior
 * (`autoInject: "perMessage"`), and reports:
 *
 *   - distinct system-prompt hashes across all 20 turns  (1 == prefix-cache safe)
 *   - recall/reflect API calls to the server
 *   - injected blocks (synthetic messages) delivered
 *   - cumulative injected characters by turn 20
 *
 * The two structural invariants of the new default are asserted and the
 * script exits non-zero on violation, so it works as a CI gate:
 *   1. the assembled system prompt is byte-constant across the session
 *   2. memory API calls are bounded (≤ 3: core prefetch, cold probe, reflect)
 *
 * Usage: npm run build && npm run bench
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import plugin from "../dist/index.js";

const TURNS = 20;

// ── hermetic config: no ambient HINDSIGHT_* may steer the benchmark ─────────
for (const key of Object.keys(process.env)) {
  if (key.startsWith("HINDSIGHT_")) delete process.env[key];
}

// ── fake Hindsight server ────────────────────────────────────────────────────
const counts = { recall: 0, reflect: 0, retain: 0, other: 0 };

function resetCounts() {
  counts.recall = 0;
  counts.reflect = 0;
  counts.retain = 0;
  counts.other = 0;
}

let recallCounter = 0;

const server = createServer((req, res) => {
  const url = req.url ?? "";
  const respond = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  req.resume();
  req.on("end", () => {
    if (url.includes("/memories/recall")) {
      // Vary every response so per-message blocks genuinely differ turn to
      // turn (a constant answer collapses them via deliver-on-change).
      recallCounter++;
      respond({
        results: [
          {
            text: `benchmark fact #${recallCounter}: we settled on pnpm workspaces`,
            type: "world",
          },
        ],
      });
      counts.recall++;
    } else if (url.includes("/reflect")) {
      counts.reflect++;
      respond({ text: "We settled on pnpm workspaces; tests run through vitest." });
    } else if (url.includes("/memories")) {
      counts.retain++;
      respond({ status: "ok" });
    } else {
      counts.other++;
      respond({ status: "ok" });
    }
  });
});

// ── fake OpenCode host context ───────────────────────────────────────────────
function makeCtx(options) {
  const hooks = new Map(); // hook name -> callback
  const syntheticCalls = []; // { text, resume, description }
  const transcript = [];
  const storage = new Map();

  const ctx = {
    options,
    storage: {
      get: async (k) => storage.get(k),
      set: async (k, v) => storage.set(k, v),
    },
    logger: console,
    session: {
      hook: async (name, cb) => hooks.set(name, cb),
      get: async ({ sessionID }) => ({ id: sessionID, location: { directory: process.cwd() } }),
      context: async () => transcript.map((m) => ({ ...m })),
      synthetic: async (input) => {
        syntheticCalls.push(input);
        return {};
      },
    },
    event: {
      subscribe: (opts) => {
        const iterator = {
          next: async () => ({ done: true, value: undefined }),
          [Symbol.asyncIterator]: () => iterator,
        };
        return iterator;
      },
    },
    tool: {
      transform: async () => {},
    },
  };
  return { ctx, hooks, syntheticCalls, transcript };
}

const PROMPTS = Array.from(
  { length: TURNS },
  (_, i) =>
    `Turn ${i + 1}: how should the parser recover from malformed nested imports in module ${i + 1}, and what did we decide earlier?`
);

async function runSession(autoInject, apiUrl) {
  const { ctx, hooks, syntheticCalls, transcript } = makeCtx({
    bankId: "benchmark",
    hindsightApiUrl: apiUrl,
    hindsightApiToken: null,
    dynamicBankId: false,
    autoInject,
    autoRetain: false, // isolate the injection path; write-back has its own tests
    retainMode: "none",
    debug: false,
  });

  const cleanup = await plugin.setup(ctx);
  try {
    const systemHashes = new Set();
    for (let turn = 0; turn < TURNS; turn++) {
      const prompt = PROMPTS[turn];
      transcript.push({ role: "user", content: prompt });
      transcript.push({ role: "assistant", content: `Answer ${turn + 1}: handled.` });

      // Admission, then the model call the admitted prompt triggers.
      await hooks.get("prompt")({ sessionID: "ses-bench", prompt: { text: prompt }, agent: "build" });
      const event = {
        sessionID: "ses-bench",
        messages: transcript.map((m) => ({ ...m })),
        system: [],
        agent: "build",
        budget: { memory: 512 },
      };
      await hooks.get("context")(event);
      systemHashes.add(createHash("sha256").update(event.system.map((p) => p.text).join("\n")).digest("hex"));
    }
    return {
      mode: autoInject,
      systemHashes: systemHashes.size,
      apiCalls: counts.recall + counts.reflect,
      recall: counts.recall,
      reflect: counts.reflect,
      injectedBlocks: syntheticCalls.length,
      cumulativeInjectedChars: syntheticCalls.reduce((sum, c) => sum + c.text.length, 0),
    };
  } finally {
    cleanup();
  }
}

// ── run, report, assert ──────────────────────────────────────────────────────
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;

try {
  resetCounts();
  const reflect = await runSession("reflect", apiUrl);
  resetCounts();
  const perMessage = await runSession("perMessage", apiUrl);

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nInjection benchmark — ${TURNS}-turn session (real plugin, fake server)\n`);
  console.log(`${pad("metric", 34)}${pad("perMessage (legacy)", 20)}reflect (default)`);
  console.log("-".repeat(66));
  console.log(`${pad("distinct system-prompt hashes", 34)}${pad(perMessage.systemHashes, 20)}${reflect.systemHashes}`);
  console.log(`${pad("recall/reflect API calls", 34)}${pad(perMessage.apiCalls, 20)}${reflect.apiCalls}`);
  console.log(`${pad("injected blocks (synthetic msgs)", 34)}${pad(perMessage.injectedBlocks, 20)}${reflect.injectedBlocks}`);
  console.log(`${pad("cumulative injected chars @20", 34)}${pad(perMessage.cumulativeInjectedChars, 20)}${reflect.cumulativeInjectedChars}`);
  console.log("");

  const failures = [];
  // Structural invariants of the new default.
  if (reflect.systemHashes !== 1) {
    failures.push(`system prompt changed ${reflect.systemHashes} times across turns (expected 1 — prefix cache broken)`);
  }
  if (reflect.apiCalls > 3) {
    failures.push(`reflect mode made ${reflect.apiCalls} memory calls (expected <= 3: core prefetch, cold probe, reflect)`);
  }
  if (reflect.injectedBlocks > 2) {
    failures.push(`reflect mode delivered ${reflect.injectedBlocks} blocks (expected <= 2)`);
  }
  // The legacy mode is reported for comparison, with a loose sanity floor.
  if (perMessage.apiCalls < TURNS) {
    failures.push(`perMessage mode made only ${perMessage.apiCalls} calls (expected >= ${TURNS} — benchmark is not exercising legacy behavior)`);
  }
  if (perMessage.injectedBlocks < TURNS) {
    failures.push(`perMessage mode delivered only ${perMessage.injectedBlocks} blocks (expected ${TURNS} with varying results — benchmark is not exercising legacy behavior)`);
  }

  if (failures.length) {
    console.error("BENCHMARK FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log("BENCHMARK PASSED: system prompt constant, API calls bounded, single delivery.\n");
  }
} finally {
  server.close();
}
