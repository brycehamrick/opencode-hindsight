# Memory Pipeline Optimization Plan

Adopt the storage/retrieval/injection mechanics that make the official
`@vectorize-io/hindsight-coding-agents` plugin token-efficient, without giving up
what makes this plugin attractive: one `plugins` line in `opencode.jsonc` and it
works.

Companion documents: `PROJECT_PLAN.md` (original build plan), `CRITICAL_REVIEW.md`
(known limitations). This plan supersedes the injection/retention sections of both.

---

## 1. Why: the four mechanics the official plugin does better

Findings from reading the official package's `core/runtime.ts`, `core/hook.ts`,
`harness/opencode2.ts` (v0.8.7), against our `src/hooks/index.ts`.

| # | Mechanic | Official | Us today | Cost of the gap |
|---|----------|----------|----------|-----------------|
| 1 | **Injection channel** | Per-turn block delivered as a stored synthetic user message (`ctx.session.hook("prompt")` + `ctx.session.synthetic`), so the system prompt stays byte-identical all session (their #5914) | `ctx.session.hook("context")` pushes a fresh memory block into `event.system` every turn | **Every turn invalidates the provider prefix cache.** After each user message the whole conversation is re-billed as uncached input. On a 50-turn session this is the single largest token multiplier |
| 2 | **Injection cadence** | One reflect synthesis per session, injected exactly once on the turn it ran; further memory pulled explicitly via tools; roster refresh on a cadence | Recall + inject on **every** user message | 50 turns = 50 recall API calls and ~50 injected blocks. Injected-into-user-turn blocks persist in history, so per-turn injection doesn't just cost once — it compounds |
| 3 | **Failure semantics** | Tri-state injection cache (`answer` / `ran-empty` / `unresolved`) with attempt budgets: 2 turns for failures, 5 for empties; cold banks defer the first synthesis (their #4607, #5082) | Recall failure ⇒ empty block; no retry budget, no defer | A first-prompt timeout or an opener like "hi" can silently cost the whole session its memory, or burn the budget on a garbage query |
| 4 | **Write-back timing** | `session.idle` **refetches** the authoritative transcript (`ctx.session.context`) so the final assistant reply is always captured; only retains when the transcript actually grew; global event stream guarded by an `ownSessions` set (bank isolation) | Prefers `event.messages` from the idle event; acts on **any** session's idle event | Final exchange of every session can be lost (the event payload predates the reply), and a foreign project's idle event re-points our workspace directory mid-session — cross-project bank pollution |

Plus two smaller items, folded into the workstreams below: prompt hygiene
(`stripInjectedMemory` also removes host-tagged blocks like `<system-reminder>`
before the text becomes a recall query — their #6488) and byte-aware query
bounding (500-token cap that never trips the server's 400 — their #5476).

**What we are deliberately NOT adopting** (out of scope, listed so it's a
decision and not an omission): knowledge pages and page tools, git-log seeding /
codebase survey, the installer CLI, daemon management, per-harness config file,
toasts, conversation backfill, multi-harness abstraction.

## 2. Design principles

1. **Never touch the system prompt with per-turn-varying content.** Anything we
   inject must be byte-stable for the rest of the session once written.
2. **Inject once, pull on demand.** One synthesis per session; the
   `hindsight_*` tools are the pull channel for everything else.
3. **Failures are retryable, empties are answers.** A timeout is not "no
   memory"; a matched-nothing recall is not an error.
4. **Fail open everywhere.** Hindsight down ⇒ plain OpenCode, no noise.
5. **Keep the one-line install.** No config file required, no new required
   options; everything below defaults correctly.

## 3. Current architecture (what stays)

```
index.ts ──► config.ts ──► manager.ts ──► recall.ts / retain.ts / client.ts
                │              │
             state.ts       bank.ts / workspace.ts
                                │
                hooks/index.ts (context hook + event loop)
                tools/index.ts (5 native tools)
```

Stays as-is: config layering (options → `~/.hindsight/opencode.json` → env),
`ctx.storage` durable state, per-agent engine cache + dynamic bank derivation,
secret/base64 stripping, tool-trace extraction, the five native tools, the
per-message recall cache (reused by legacy mode).

## 4. Target architecture

```
index.ts ──► config.ts ──► manager.ts ──► recall.ts / retain.ts / client.ts
    │                         │
    │                      inject/engine.ts ──► inject/block.ts   (NEW)
    │                         │
    ├── hooks/prompt.ts      (NEW — admission hook + synthetic message)
    ├── hooks/lifecycle.ts   (idle/execution events, ownSessions, refetch)
    ├── hooks/compaction.ts  (NEW — dedicated compaction hook)
    ├── hooks/context.ts     (fallback path only, see WS1)
    ├── diag.ts              (NEW — JSONL diagnostics)
    └── tools/index.ts
```

The MemoryManager gains an `InjectionEngine` peer that owns everything
model-facing; recall/retain engines stay pure server-I/O.

---

## Workstream 1 — Prefix-cache-safe injection channel ✅ (Phase 2)

**Problem.** `hooks/index.ts` pushes `formatMemoryContext(...)` into
`event.system` on every `context` hook fire (which runs per model call, not just
per user message). The block varies per turn ⇒ the system prompt varies ⇒ the
provider's prefix cache is invalid from turn one onward.

**Change.** Register `ctx.session.hook("prompt", ...)`:

```ts
await ctx.session.hook("prompt", async (event) => {
  ownSessions.add(event.sessionID);                      // WS4 guard
  const raw = event.prompt.text ?? "";
  const prompt = stripInjectedMemory(raw).trim();        // WS3 hygiene
  if (!prompt) return;                                   // nothing to recall
  await injection.onPrompt(event.sessionID, event.agent, prompt);   // WS2
  const block = injection.getBlock(event.sessionID);
  if (block) {
    await ctx.session.synthetic({
      sessionID: event.sessionID,
      text: block,
      description: "Hindsight memory",
      resume: false,          // must not start its own model run
    });
  }
});
```

Verified facts this relies on (OpenCode v2 plugin docs + official adapter,
tested by them against beta-18743; we re-verify on v2.0.27):

- The `prompt` hook runs once at **admission** (not per model call), receives an
  owned mutable draft (`event.prompt.text`), and its edits become the canonical
  persisted user input.
- **Synthetic messages do not run the prompt hook** ⇒ no recursion from our own
  injection.
- The synthetic message is stored, model-facing, and lands just **before** the
  admitted prompt.
- Because it is stored in the turn it was made for, every later request repeats
  it byte-for-byte — paid once as a cache write, then read at cache-read price.

**Capability fallback.** If `typeof ctx.session.synthetic !== "function"` on the
host build, fall back to `hooks/context.ts`: push a **frozen** block (see WS2 —
the block string is computed once per session and never mutated), which is
prefix-cache-safe by construction. The fallback keeps the plugin functional on
older v2 builds at the cost of accumulating nothing in-history.

**Rejected alternative:** mutating `event.prompt.text` to prepend the block.
Works, but pollutes the user's persisted message (visible in the transcript and
in every downstream consumer), and couples us to attachment-mention offset
invariants the docs warn about. Synthetic message keeps user text pristine.

**Exit criteria**
- New integration test: across a simulated 20-turn session, the assembled system
  prompt hash is **constant**; injected blocks appear only on turns that have
  one; the final transcript contains the block exactly once. ✅
  (`tests/integration/channel.test.ts`; on the synthetic channel the system
  parts stay empty across all 20 turns and `ctx.session.synthetic` fires
  exactly once. Synthetic-before-prompt ordering on a live host — verified by
  the official plugin against beta-18743 — still wants one manual check.)

## Workstream 2 — Once-per-session auto-inject (reflect-first) ✅ (Phase 1)

**Problem.** We recall-and-inject every user message. Even with the recall cache
(identical text only), a real conversation makes ~1 recall call + 1 injected
block per turn.

**Change.** New `src/inject/engine.ts` — an `InjectionEngine` with the official
package's tri-state semantics, adapted to our config:

```ts
type InjectionState =
  | { status: "unresolved"; attempts: number }   // failed or not yet run — retry eligible
  | { status: "empty"; attempts: number }        // ran, matched nothing
  | { status: "answer"; text: string };          // ran, have a body

interface InjectionEngine {
  onPrompt(sessionId: string, agent: string, prompt: string): Promise<void>;
  getBlock(sessionId: string): string | undefined;  // this turn's block, or undefined
}
```

- **Modes** — new config `autoInject: "reflect" | "recall" | "perMessage" | "none"`,
  default `"reflect"`:
  - `reflect` *(new default)*: one `client.reflect()` per session using the first
    substantive prompt as the goal. Budget `"low"`, timeout `reflectTimeoutMs`.
  - `recall`: one recall per session (same once-only machinery, cheaper source).
  - `perMessage`: today's behavior, delivered through the new WS1 channel and
    still subject to dedupe/budget caps. Escape hatch for users who want
    mid-session topic-shift recall automated.
  - `none`: tools only.
- **Tri-state + budgets** — a failure leaves state `unresolved` and consumes one
  of `injectFailureAttempts` (default 2) turns; an empty result consumes one of
  `injectEmptyAttempts` (default 5). Budget spent ⇒ resolve to `empty` and stop
  asking. A permanent 4xx resolves to `empty` immediately (no retry burn).
- **Cold-bank defer** — if the bank probe (below) says the bank has nothing to
  reflect on, turn 1 does not consume the attempt; turn 2 stays eligible.
  *Bank probe:* we already prefetch core memories at session start; extend that
  call to record `bankCold = core.length === 0 && probeRecall.length === 0`
  (one extra tiny recall, cached per bank per process).
- **Trivial-prompt skip** — prompts shorter than `minReflectPromptChars`
  (default 8) are skipped **without consuming an attempt**, so an opener like
  "hi" doesn't burn the session's synthesis on a garbage query.
- **Inject exactly once** — the answer is injected on the turn it ran
  (`ranThisTurn` flag), never re-injected later. Re-injection mid-session reads
  as noise once the session drifts (explicitly documented by the official
  package); `hindsight_reflect` is the fresh-pass channel.
- **Per-session persistence** — state goes into
  `state.sessions[id].inject = { status, attempts, text }` so a plugin reload
  (host restart, `/reload`) doesn't re-synthesize or lose the budget count.

**Core memory under the new model.** Core memories move out of the system
prompt entirely:
- Fetched once at the session's first prompt, formatted once, and
  **byte-frozen** for the session (stored verbatim in session state).
- Rendered as the head section of the turn-1 synthetic block, after the
  reflect/recall body.
- Refresh policy `coreRefreshPolicy: "session" | "onInvalidate"` (default
  `"session"`): frozen until the next session. `"onInvalidate"` re-fetches when
  a `core`-tagged fact is retained mid-session (the invalidation hook already
  exists in `manager.retainFact`) and ships the delta on the next turn that
  carries a block.

**Block format** (unchanged tag names, so `stripMemoryTags` keeps protecting
retention):

```
<hindsight_memories>
[core] Stable preferences/conventions …        ← frozen section (may be absent)
[context] Synthesis of past decisions for "<goal excerpt>" …   ← once per session
(memory tools are available for deeper lookups: hindsight_recall / hindsight_reflect)
</hindsight_memories>
```

**Config migration.** `autoRecall: false` (explicit) ⇒ `autoInject: "none"`.
`autoRecall: true` or unset ⇒ `autoInject: "reflect"` — **a behavior change**
for existing users, which is the point; release as a minor version bump with a
README migration note.

## Workstream 3 — Prompt hygiene and query bounding ✅ (Phase 0)

**Changes in `memory/content.ts`:**

1. `stripInjectedMemory(text)` — superset of `stripMemoryTags` that also removes
   host-injected wrappers before the text is used as a reflect goal, recall
   query, or retained content:
   - `<system-reminder>…</system-reminder>` blocks (OpenCode and other plugins
     prepend these; left in, the head of every query is boilerplate)
   - `<context key="…">…</context>` blocks (v2 instructions entries)
   - existing `<hindsight_memories>` / `<relevant_memories>` handling
2. `boundQueryTokens(text, maxTokens = 500)` — byte-aware estimator replacing
   `chars/4` **on the query path**: ASCII ≈ 0.5 token/char, non-ASCII charged by
   UTF-8 byte length (a true ceiling per byte). Old servers 400 on recall
   queries over 500 tokens; long or non-Latin prompts silently lost their turn.
3. `estimateTokens` (used for *budget trimming* of results) stays `chars/4` —
   it's a cap, not a bill, and being conservative there is fine. Document the
   distinction in code.

Applied at: reflect goal construction, recall query composition (both auto and
tool paths), and retention sanitization.

## Workstream 4 — Write-back: idle refetch, growth gate, bank isolation ✅ (Phase 4)

**Changes in `hooks/lifecycle.ts` (extracted from `hooks/index.ts`):**

1. **Authoritative refetch.** On idle-family events, always refetch the
   transcript via `ctx.session.context({ sessionID })` instead of trusting
   `event.messages` — the event payload predates the reply that just finished.
   The refetched list feeds the existing normalizer + tool-trace extractor.
2. **Event set.** Subscribe with type filtering:
   `["session.idle", "session.execution.succeeded", "session.execution.failed",
   "session.execution.interrupted", "session.closed"]`. The `execution.*`
   signals cover one-shot `opencode run` sessions that exit before `idle`
   fires; `session.closed` keeps the final-flush role it has today.
3. **Growth gate.** Retain only when the refetched transcript actually grew
   past what was last written (compare retained turn count + content hash in
   session state). Idle can fire repeatedly for one exchange; `execution.*` +
   `idle` both firing for the same turn must cost one retain.
4. **Bank isolation guard (`ownSessions`).** `ctx.event.subscribe` is global
   across every project the v2 service hosts, and the event envelope carries no
   location. Today our idle handler calls `ensureSessionWorkspace()` for **any**
   session id — a foreign project's idle event re-points `currentDirectory`,
   clears the engine cache, and can file another project's transcript into the
   wrong bank. Fix: only session ids admitted by our own scoped `prompt` hook
   are eligible for retention. (Also stop calling `setWorkspaceDirectory` from
   the idle path at all; the prompt hook already resolved the workspace at
   admission.)
5. **Fire-and-forget retains with a bounded flush.** Retains never await inside
   the event loop; track them in an in-flight set and `Promise.race` it against
   a 10s timeout in the plugin cleanup function so the final retain survives a
   graceful host exit.
6. **Retention modes.**
   - `facts` (default, our differentiator): unchanged deterministic
     `fact-{hash}` document IDs + pendingRetains dedupe; the turn gate
     (`retainEveryNTurns`) and closed-flush stay.
   - `transcript`: already a single-document upsert (`documentId = sessionId`);
     delete the dead chunked branch in `retainTranscriptChunks` (unreachable
     since `retainFullWindow` is always true in this mode) and rely on the
     growth gate to avoid redundant upserts. No client-side batching windows —
     holding turns for a timer is how sessions get dropped.

## Workstream 5 — Reflect fallback chain ✅ (Phase 3)

**Problem.** If reflect times out or 5xx's, the session currently gets nothing.

**Change.** In `InjectionEngine`, on a *retryable* reflect failure, run a
retrieval-only fallback within a **shared deadline**
(`injectTimeoutMs`, default 8s, counted from the start of the fallback — the
same total budget the official package uses):

1. `client.recall()` with the bounded query (WS3), budget `mid`.
2. *(Stretch, gated)* page search via the Hindsight pages API — only if we
   upgrade `@vectorize-io/hindsight-client` to a pages-capable release
   (official uses `hindsight-all@0.10.x`). Capability-flagged like the client's
   `deleteDocument` fallback; absent ⇒ skip straight to recall.

A fallback body is cached exactly like a reflect answer (injected once, not
retried). A permanent 4xx skips reflect retries but still gets one fallback
recall. Client wrapper gains per-call `timeoutMs` (AbortSignal) so reflect and
fallback respect their deadlines instead of relying on server-side timeouts.

## Workstream 6 — Compaction hook ✅ (Phase 4)

The dedicated `ctx.session.hook("compaction", ...)` exists in current v2 builds
(resolves open question #3 in `CRITICAL_REVIEW.md`). Wire it:

```ts
await ctx.session.hook("compaction", async (event) => {
  const context = await memory.onCompaction(event.sessionID, normalize(event.messages), agentOf(event));
  if (context) event.system.push({ type: "text", text: context });
});
```

Compaction is its own request kind (not the primary agent loop), so a system
part here does not endanger the primary requests' prefix cache. Retain-pending-
turns-first behavior in `onCompaction` is already correct; keep it. Remove the
speculative compaction detection from the `context` hook.

## Workstream 7 — Diagnostics and token accounting

**`src/diag.ts`** — append-only JSONL at `~/.hindsight/diagnostics.log`
(override: `HINDSIGHT_DIAG_FILE`), rotated at ~1MB ✅ (module shipped in
Phase 0; `inject_*` events arrive with the Phase 1 engine):

```jsonc
{"t":"…","event":"inject_ok","session":"ses_…","chars":1180}
{"t":"…","event":"reflect_ok","ms":2140,"chars":860,"query":"<80-char preview>","answer":"<200-char preview>"}
{"t":"…","event":"reflect_failed","ms":20001,"error":"timeout","attempts":1}
{"t":"…","event":"retain_ok","ms":180,"turns":6,"trigger":"idle","doc":"ses_…"}
```

Every outcome is recorded — a memory-less session must be distinguishable from
a healthy one in the log (their #3443 lesson). Events: `inject_ok/empty/failed`,
`reflect_ok/empty/failed/deferred`, `recall_*`, `retain_ok/failed`,
`core_refresh`, `compaction_inject`. `hindsight_status` gains the diag path and
last-24h counters.

**Benchmark harness** ✅ — `scripts/benchmark-session.mjs`: replays a scripted
20-turn session through the real built plugin against a fake Hindsight HTTP
server, and asserts:

| Metric | Legacy (`perMessage`) | Target (new default) |
|---|---|---|
| System-prompt hashes across 20 turns | ~20 distinct | **1** |
| Recall/reflect API calls | ~20 | ≤ 3 |
| Injected blocks per session | ~20 | 1–2 |
| Cumulative injected chars at turn 20 | grows every turn | ~fixed after turn 1 |

Run in CI as a regression gate for the two structural invariants (constant
system hash; bounded calls).

---

## 5. Configuration changes

| Option | Default | Notes |
|---|---|---|
| `autoInject` | `"reflect"` | `reflect` \| `recall` \| `perMessage` \| `none`; `autoRecall` honored as migration input (see WS2) |
| `reflectTimeoutMs` | `20000` | auto-reflect only; explicit `hindsight_reflect` tool keeps today's unbounded/high path |
| `injectTimeoutMs` | `8000` | shared retrieval budget for the fallback chain |
| `injectFailureAttempts` | `2` | turns a failing source may retry |
| `injectEmptyAttempts` | `5` | turns an empty source may retry |
| `minReflectPromptChars` | `8` | shorter prompts skip without consuming an attempt |
| `maxRecallQueryTokens` | `500` | byte-aware bound (WS3) on all recall queries |
| `coreRefreshPolicy` | `"session"` | `session` \| `onInvalidate` |

Removed: nothing. Deprecated: `autoRecall` (mapped, documented), `recallMaxQueryChars`
(superseded by the token bound, kept for one release).

## 6. State schema (ctx.storage, key `hindsight:state`)

```ts
interface SessionState {
  // existing
  lastRetainedTurn?: number;
  lastFinalFlushTurn?: number;
  lastTranscriptDocumentId?: string;
  // new
  startedAt?: string;
  turns?: number;                       // admitted prompts seen
  inject?: {
    status: "unresolved" | "empty" | "answer";
    attempts: number;
    text?: string;                      // frozen answer body
  };
  coreBlock?: string | null;            // frozen core-memory section
  retainedTurnCount?: number;           // growth gate (WS4)
  retainedContentHash?: string;
}
```

*Shipped note:* the growth gate stores the two WS4 fields as one combined
`retainedFingerprint` (`"<messageCount>:<hash>"`) — same semantics, one field.

Writes stay behind the existing `saveState` (cheap JSON, once per turn
transition).

## 7. Implementation phases

Each phase is independently shippable and keeps the test suite green.

| Phase | Contents | Behavior change |
|---|---|---|
| **0** ✅ | WS3 hygiene + query bounding, WS7 diag foundation | none (pure hardening) |
| **1** ✅ | WS2 InjectionEngine + core freeze, delivered via the **existing** context hook but as a **frozen** block | recall cadence: per-message → per-session; system block becomes byte-stable (prefix cache already preserved) |
| **2** ✅ | WS1 channel switch (prompt hook + synthetic message) with capability fallback to Phase-1 mode | injection moves out of the system prompt entirely (system parts stay empty; 20-turn structural test asserts one delivery + constant system) — live-verify synthetic-before-prompt ordering on the real host |
| **3** ✅ | WS5 reflect fallback chain + client `timeoutMs` | reflect failures degrade to recall instead of nothing; timeouts owned by the client wrapper (TimeoutError, never transport-retried). Real wire-level abort waits on the pages-capable SDK upgrade (decision §10.3) |
| **4** ✅ | WS4 write-back rework + WS6 compaction hook | final replies always retained (idle refetch via `ctx.session.context`); `session.execution.*` covers one-shot runs; bank isolation via `ownSessions` admission; growth gate (turn count + content fingerprint, stored as `retainedFingerprint`) makes repeated signals free; transcript mode is a single-doc upsert (chunk/delete paths removed); retains fire-and-forget with bounded 10s flush on cleanup |
| **5** ✅ | Benchmark harness, README/migration notes, release | `scripts/benchmark-session.mjs` drives the real built plugin against a fake Hindsight server: 20 turns, perMessage = 22 API calls / 20 blocks / 5195 cumulative chars vs reflect = **3 / 1 / 438**; system-prompt hash constant in both; CI runs it as a gate (`npm run bench`, also in `prepublishOnly`). Released as 0.4.0 |

**All phases complete.** Outstanding items before publishing: one live-host
check that the synthetic message lands before the admitted prompt (Phase 2
note), and the §10 decisions if the defaults should change.

## 8. Testing plan

- **Unit** (new): tri-state resolution and both attempt budgets; permanent-4xx
  immediate resolve; trivial-prompt skip; cold-bank defer; `boundQueryTokens`
  byte math (ASCII/CJK/emoji); `stripInjectedMemory` host-tag cases; block
  formatting stability (same inputs ⇒ byte-identical block); growth gate.
- **Integration** (fake ctx): 20-turn session assertions (system hash constant,
  calls bounded, block count); synthetic unavailable ⇒ frozen-system fallback;
  foreign idle event ⇒ no retain, no workspace re-point; idle refetch captures
  the final assistant reply; `execution.succeeded`-only sessions retain;
  compaction hook injects and retains pending turns first; reload mid-session
  preserves inject state (no double synthesis).
- **E2E** (local Hindsight, manual or CI-service): cross-session memory still
  works end-to-end; reflect answer actually grounded in retained facts; secret
  stripping still effective on the refetched transcript path.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `session.synthetic` ordering/availability differs on v2.0.27 vs the official's tested beta build | Phase 2 is capability-gated with the Phase-1 frozen-system fallback; verify ordering with a live session before flipping the default |
| Once-per-session recall misses mid-session topic shifts | `perMessage` escape hatch; tools remain; benchmark compares recall hit quality, not just cost |
| First-turn reflect latency (up to `reflectTimeoutMs`) on the prompt-admission path | budget `"low"`; cold-bank defer; attempt budget caps total wasted time at 2 × timeout per session; prompt hook is async and admission-scoped |
| Users depend on per-message system injection (e.g., other tooling reading `event.system`) | Migration note + `autoInject: "perMessage"` |
| Single-doc transcript upsert re-sends the full transcript each idle | growth gate makes it once per grown exchange; sessions are bounded by `maxRetainedMessageLength` per message |

## 10. Open decisions

1. **Ship `autoInject: "reflect"` as the default** (behavior change for
   existing per-message users) — recommended, with a README migration note and
   the `perMessage` escape hatch. Confirm before Phase 1 release.
2. **Core refresh policy default** — `"session"` (recommended: cheapest, fully
   cache-stable) vs `"onInvalidate"` (fresher, one extra block mid-session).
3. **Hindsight client upgrade** for the pages API (WS5 stretch) — needed only if
   we want page search in the fallback chain; otherwise skip and keep
   `hindsight-client@0.5.x`.
4. **Fallback channel if synthetic misbehaves on the pinned host** — frozen
   system block (planned) vs prepending to `event.prompt.text` (rejected for
   now; revisit only if the frozen block proves inadequate).
