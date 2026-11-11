# @brycehamrick/opencode-hindsight

A best-in-class, token-efficient long-term memory plugin for [OpenCode](https://opencode.ai).

## Why this plugin

Memory that helps is also context you pay for on every turn. This plugin is
built around token and memory efficiency — measured, not assumed. The
benchmark below ships in the repo (`npm run bench`) and runs as a release
gate:

| 20-turn session (measured) | Per-message recall (the common pattern) | This plugin (default) |
|---|---|---|
| Memory API calls | 22 | **3** |
| Injected memory blocks | 20 | **1** |
| Cumulative injected characters | 5,195 | **438** |
| System-prompt changes across the session | every turn | **0 — byte-constant** |

What that buys you, and what sets it apart from other memory integrations:

- **Prefix-cache-safe injection.** Memory is delivered as one stored synthetic
  user message — once per session, on change only — never as per-turn system
  prompt additions. A system prompt that changes turn to turn silently
  re-bills the whole conversation as uncached input on every request; here it
  stays byte-identical for the session.
- **Once-per-session reflect.** One synthesis answers "what do we already know
  about this?"; deeper memory is pulled on demand through tools instead of
  pushed at every message. A failed synthesis falls back to recall rather than
  costing the session its memory.
- **Frozen core memory.** A small block of high-stability facts (preferences,
  conventions) is fetched once and byte-frozen for the session — always
  present, never re-billed as cache-invalidating churn.
- **Budgets on everything.** Caps on injected tokens, a byte-aware ceiling on
  outgoing queries, and attempt budgets on retries — waste is bounded by
  construction.
- **Per-agent memory scoping.** Different OpenCode agents can have isolated
  memory banks (`reviewer::my-project` vs `debugger::my-project`).
- **Lean retention.** Defaults to atomic facts instead of full transcripts,
  with secrets, API keys, base64 blobs, and large tool outputs stripped before
  anything is stored.
- **Diagnostics.** Every recall/reflect/inject/retain outcome logged to
  `~/.hindsight/diagnostics.log` — a memory-less session never looks like a
  healthy one.
- **One-line install.** No installer CLI, no extra config files — just the
  plugin entry in your OpenCode config.

Also: durable state via `ctx.storage`, self-hosted or Hindsight Cloud, and
explicit `hindsight_retain` / `hindsight_recall` / `hindsight_reflect` /
`hindsight_forget` tools.

## Installation

OpenCode resolves the `"package"` field against npm, so there is nothing to
install — add the plugin to your OpenCode config and you're done:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@brycehamrick/opencode-hindsight",
      "options": {
        "dynamicBankId": true,
        "dynamicBankGranularity": ["agent", "gitProject"],
        "hindsightApiUrl": "http://localhost:8888"
      }
    }
  ]
}
```

Connection settings, in brief:

- **Self-hosted Hindsight** (shown above): set `hindsightApiUrl` to your
  server. No token is needed unless the server enforces auth
  (`hindsightApiToken` defaults to `null`).
- **Hindsight Cloud**: set `"hindsightApiToken": "hz_..."` and leave
  `hindsightApiUrl` at its default.
- Credentials may also come from the environment (`HINDSIGHT_API_URL`,
  `HINDSIGHT_API_TOKEN`), which take priority over plugin options.

The full option set — injection modes, token budgets, retention behavior — is
in [Configuration](#configuration). Config file locations and reload behavior
are documented by [OpenCode](https://opencode.ai/docs/config) itself.

> **Renamed:** this package was previously published as
> `@brycehamrick/opencode-v2-hindsight`. If your config references the old
> name, update it to `@brycehamrick/opencode-hindsight`.

## Per-project overrides

A common pattern: enable dynamic per-repo banks globally, then pin one
project to a static bank ID in its project config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@brycehamrick/opencode-hindsight",
      "options": {
        "bankId": "legacy-monolith",
        "dynamicBankId": false,
        "retainMode": "transcript"
      }
    }
  ]
}
```

> The plugin also reads `~/.hindsight/opencode.json` for persistent defaults
> (see Configuration priority below) — useful for credentials and settings you
> don't want to commit to a repo.

## Per-agent scoping

OpenCode supports multiple agents. To give each agent its own memory bank, enable dynamic bank IDs and include `agent` in the granularity:

```jsonc
{
  "plugins": [
    {
      "package": "@brycehamrick/opencode-hindsight",
      "options": {
        "dynamicBankId": true,
        "dynamicBankGranularity": ["agent", "project"]
      }
    }
  ]
}
```

With this config a session running the `reviewer` agent gets bank `reviewer::my-project`, while a session running the `debugger` agent gets `debugger::my-project`. Memories never leak across agents.

The agent name is resolved in this order:
1. The active agent from the OpenCode session/event (`event.agent.id` or `event.session.agent.id`)
2. `ctx.agent.default.id` at plugin setup
3. The `agentName` plugin option
4. Fallback `"opencode"`

All explicit tools accept an optional `agent` parameter to target a specific agent's bank.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `hindsightApiUrl` | `https://api.hindsight.vectorize.io` | Hindsight API base URL |
| `hindsightApiToken` | `null` | API token (`null` for self-hosted) |
| `bankId` | `null` | Static bank ID |
| `bankIdPrefix` | `""` | Prefix added to derived bank IDs |
| `dynamicBankId` | `false` | Derive bank ID from agent/project/etc. |
| `dynamicBankGranularity` | `["agent", "project"]` | Fields for dynamic bank ID |
| `agentName` | `"opencode"` | Default agent name fallback |
| `bankMission` | `""` | Mission set when creating a bank |
| `retainMission` | `null` | Retain mission for the bank |
| `autoRecall` | `true` | Legacy switch: `false` maps to `autoInject: "none"` |
| `autoInject` | `"reflect"` | `"reflect"` — one reflect synthesis per session; `"recall"` — one recall per session; `"perMessage"` — per-message recall (legacy behavior); `"none"` — tools only |
| `reflectTimeoutMs` | `20000` | Timeout for the once-per-session auto reflect (the `hindsight_reflect` tool is unaffected) |
| `injectTimeoutMs` | `8000` | Timeout for the once-per-session recall source and the cold-bank probe |
| `injectFailureAttempts` | `2` | Turns a failing auto-inject source may retry before giving up |
| `injectEmptyAttempts` | `5` | Turns an empty auto-inject source may retry before giving up |
| `minReflectPromptChars` | `8` | Prompts shorter than this skip auto-inject without consuming an attempt |
| `coreRefreshPolicy` | `"session"` | `"session"` — core memory frozen for the session; `"onInvalidate"` — refetched after a core-tagged retain |
| `autoRetain` | `true` | Retain conversation automatically |
| `retainMode` | `"facts"` | `"facts"`, `"transcript"`, or `"none"` |
| `coreMemoryMaxTokens` | `256` | Max tokens for always-injected core memory |
| `perMessageRecallMaxTokens` | `512` | Max tokens recalled per user message |
| `compactionRecallMaxTokens` | `512` | Max tokens recalled during compaction |
| `extractionMaxTokens` | `256` | Max tokens for extracted facts |
| `recallBudget` | `"mid"` | Hindsight recall budget (`low`/`mid`/`high`) |
| `recallContextTurns` | `2` | User turns included in recall query context |
| `recallMaxQueryChars` | `800` | Max characters in composed recall query |
| `maxRecallQueryTokens` | `500` | Byte-aware token ceiling on recall/reflect queries (servers reject queries over ~500 tokens) |
| `recallPromptPreamble` | (see source) | Preamble prepended to injected memory context |
| `recallTypes` | `["world", "experience"]` | Memory types to recall |
| `recallTags` | `[]` | Tags to filter recall |
| `recallTagsMatch` | `"any"` | Tag matching mode |
| `retainContext` | `"opencode"` | Default context for retained memories |
| `retainEveryNTurns` | `3` | Retain every N user turns (partial final window is flushed on session close) |
| `retainOverlapTurns` | `2` | Overlap turns between retention windows |
| `retainTags` | `[]` | Tags added to retained memories |
| `retainMetadata` | `{}` | Metadata added to retained memories |
| `stripSecrets` | `true` | Remove secrets before retention |
| `stripBase64` | `true` | Collapse large base64 blobs |
| `maxRetainedMessageLength` | `4000` | Max characters of any retained message |
| `debug` | `false` | Enable debug logging |

Environment variables override plugin options: `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN`, `HINDSIGHT_BANK_ID`, `HINDSIGHT_AGENT_NAME`, `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_RETAIN_MODE`, etc.

Configuration priority (later wins):
1. Built-in defaults
2. `~/.hindsight/opencode.json`
3. Plugin options from `opencode.jsonc`
4. Environment variables

## Tools

- `hindsight_retain(content, context?, tags?, agent?)` — store a fact or decision.
- `hindsight_recall(query, maxTokens?, agent?)` — search memory.
- `hindsight_reflect(query, context?, agent?)` — synthesize an answer from memory.
- `hindsight_forget(documentId?, query?, agent?)` — remove a memory by document ID.
- `hindsight_status(agent?)` — resolved workspace, bank, and diagnostics-log path.

## How memory is injected

Memory is delivered through a **stored synthetic user message**, not the system
prompt. The plugin registers the prompt-admission hook (`ctx.session.hook("prompt")`),
which runs once per admitted user prompt: it recalls/synthesizes the block and
sends it via `ctx.session.synthetic({ resume: false })`, so it lands just before
your message, persists in the transcript, and is paid for once — every later
request repeats it byte-for-byte at cache-read price while the system prompt
(and therefore the provider's prefix cache) stays untouched. The block is
delivered **on change only**: typically exactly one memory message per session.

Hosts without `ctx.session.synthetic` (older v2 builds) fall back to the
context-hook channel: the same frozen block is attached as a system part on
every model call, byte-stable for the session, so the prefix cache is preserved
either way. If synthetic delivery fails twice on the host, the plugin trips a
circuit breaker and switches to that fallback for the rest of the process. The
active channel is recorded in the diagnostics log (`inject_channel`).

By default (`autoInject: "reflect"`), the block contains **one reflect
synthesis per session** from the first substantive prompt, plus a frozen
core-memory section. A failed synthesis does not cost the session its memory:
one retrieval-only recall runs as a fallback (within `injectTimeoutMs`) and its
result is injected exactly like a reflect answer; the failure still retries on
later turns (at most `injectFailureAttempts` times), while a synthesis that
matches nothing retries at most `injectEmptyAttempts` times. A permanent 4xx on
reflect skips its retries but still gets the one fallback recall. Every step is
recorded in the diagnostics log (`reflect_fallback*`, `inject_*`). A brand-new
(cold) bank defers the first attempt
once, and prompts shorter than `minReflectPromptChars` are skipped without
consuming an attempt. Deeper memory is pulled on demand through the
`hindsight_recall` / `hindsight_reflect` tools.

If you prefer the older per-message recall (a fresh recall on every user
message), set `autoInject: "perMessage"` — each turn's block is delivered as its
own synthetic message, so context accumulates over the session (that is the
cost of per-turn injection on a stored-message channel; the tools are usually
the better pull channel). To disable all automatic injection and rely on the
tools alone, set `autoInject: "none"` (also implied by `autoRecall: false`).

## Session write-back

When the assistant finishes a turn (`session.idle`, plus the
`session.execution.*` signals that cover one-shot `opencode run` sessions), the
plugin **refetches the session's transcript from the host** and retains it —
the event payload predates the reply, so trusting it would lose every
session's final exchange. Repeated signals for an unchanged transcript cost
nothing (a fingerprint gate skips them), and only sessions this plugin
instance admitted are ever written back — OpenCode's event stream is global
across projects, and the admission guard keeps another project's idle event
from touching your bank. On `session.closed`, the partial window the turn gate
hasn't reached is flushed. Retention modes: `facts` (default — atomic
fact-hash documents), `transcript` (a single document per session, upserted),
or `none`. Compaction requests get a short memory-recall injection so
summaries keep the session's context.

## Diagnostics

The plugin appends a JSONL event log to `~/.hindsight/diagnostics.log`
(override with `HINDSIGHT_DIAG_FILE`; rotated to `.1` at ~1MB). Every memory
outcome is recorded — `recall_ok` / `recall_failed`, `reflect_ok` /
`reflect_failed`, `retain_ok` / `retain_failed`, `core_refresh` — with latency,
result counts, and short query previews, so a memory-less session is
distinguishable from a healthy one in the log. `hindsight_status` prints the
path.

## Development

To build and test from source:

```bash
git clone https://github.com/brycehamrick/opencode-hindsight.git
cd opencode-hindsight
npm install
npm test
npm run build
```

To use a local build in OpenCode, run `npm run build`, then point the `"package"` field at the `dist` directory (local plugin targets must be directories): `"/absolute/path/to/opencode-hindsight/dist"`.

## Example configs

See `examples/opencode.jsonc` and `examples/global-opencode.jsonc`.

## Upgrading from 0.3.x

0.4.0 rebuilds the memory pipeline (see
[`MEMORY_PIPELINE_PLAN.md`](./MEMORY_PIPELINE_PLAN.md)). Things to know:

- **Injection is now once per session by default.** One reflect synthesis is
  injected as a stored synthetic user message instead of a fresh recall block
  in the system prompt on every message. This keeps the provider's prefix
  cache valid — the system prompt no longer changes turn to turn — and cuts
  memory API calls from one per message to a handful per session.
- **Prefer the old behavior?** Set `"autoInject": "perMessage"` (fresh recall
  per message) or `"autoInject": "none"` (tools only). `autoRecall: false`
  still disables all automatic injection.
- **Retention is safer.** Session close now flushes the final partial window,
  completed replies are captured by refetching the transcript on idle, and
  only sessions this plugin instance admitted are written back (OpenCode's
  event stream is global across projects).
- Existing banks and documents keep working; the new per-session state is
  additive. A `hindsight_status` call prints the resolved bank and the
  diagnostics log path, and `~/.hindsight/diagnostics.log` records every
  recall/reflect/inject/retain outcome if anything looks off.

## Status

Requires OpenCode v2.0 or newer; not compatible with OpenCode V1. Built for
and tested against opencode v2.0.27. The 0.4.x pipeline (once-per-session
reflect injection, synthetic-message channel, fallback chain, idle-refetch
write-back) is verified by 154 tests plus a structural benchmark
(`npm run bench`) that gates the prefix-cache invariant on every release
(`prepublishOnly`).

## License

MIT
