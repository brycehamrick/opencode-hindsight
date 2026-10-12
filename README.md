# @brycehamrick/opencode-hindsight

A best-in-class, token-efficient long-term memory plugin for [OpenCode](https://opencode.ai).

## Features

- **Per-message recall** — memories are fetched for the *current* user message, not just at session start.
- **Core memory** — a small, always-injected block of high-stability facts (preferences, conventions).
- **Per-agent scoping** — different OpenCode agents can have isolated memory banks.
- **Smart retention** — defaults to retaining atomic facts instead of full transcripts.
- **Token budgets** — caps injected memory per turn to avoid wasting tokens.
- **Safety** — strips secrets, API keys, base64 blobs, and large tool outputs before retention.
- **Durable state** — plugin state survives restarts via `ctx.storage`.
- **Explicit tools** — `hindsight_retain`, `hindsight_recall`, `hindsight_reflect`, `hindsight_forget`.
- **Self-hosted or hosted** — works with your own Hindsight instance or Hindsight Cloud.

## Installation

Install the plugin from npm:

```bash
npm install -g @brycehamrick/opencode-hindsight
```

> **Renamed:** this package was previously published as `@brycehamrick/opencode-v2-hindsight`. If your config references the old name, update it to `@brycehamrick/opencode-hindsight`.

OpenCode resolves the `"package"` field in `opencode.jsonc` against npm by default, so you can reference the package by name.

### 1. Add to your OpenCode config

OpenCode reads config from the global config location (commonly `~/.config/opencode/opencode.jsonc`) and from project configs such as `.opencode/opencode.jsonc` or `opencode.jsonc` in the project directory. Project configs override global ones. The exact global path can vary by OS/OpenCode version — check `opencode --help` or the OpenCode docs if the file does not exist.

#### Option A: Global config

Edit your global OpenCode config (commonly `~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@brycehamrick/opencode-hindsight",
      "options": {
        "dynamicBankId": true,
        "dynamicBankGranularity": ["agent", "gitProject"]
      }
    }
  ]
}
```

#### Option B: Per-project config

Create `.opencode/opencode.jsonc` in your project root:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@brycehamrick/opencode-hindsight",
      "options": {
        "bankId": "my-project",
        "dynamicBankId": true,
        "dynamicBankGranularity": ["agent", "gitProject"]
      }
    }
  ]
}
```

> Plugin options from a project `opencode.jsonc` merge over the global config. Later entries in the `plugins` array override earlier ones.

### 2. Set your Hindsight credentials

You can set the connection options in `opencode.jsonc` **or** via environment variables. The plugin config is usually cleaner.

#### Self-hosted Hindsight

In `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "@brycehamrick/opencode-hindsight",
      "options": {
        "hindsightApiUrl": "http://localhost:8888"
      }
    }
  ]
}
```

Or via environment variable:

```bash
export HINDSIGHT_API_URL="http://localhost:8888"
```

No API token is required for unauthenticated self-hosted instances, so `hindsightApiToken` can be left unset (it defaults to `null`).

#### Hindsight Cloud (hosted)

In `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "@brycehamrick/opencode-hindsight",
      "options": {
        "hindsightApiUrl": "https://api.hindsight.vectorize.io",
        "hindsightApiToken": "hz_..."
      }
    }
  ]
}
```

Or via environment variables:

```bash
export HINDSIGHT_API_TOKEN="hz_..."
# Optional: override the endpoint
export HINDSIGHT_API_URL="https://api.hindsight.vectorize.io"
```

### 3. Restart OpenCode

OpenCode loads plugins at startup. Restart it after changing `opencode.jsonc`.

## Global config + per-project overrides

The recommended setup is:

1. **Globally** enable the plugin with base options in `~/.config/opencode/opencode.jsonc`.
2. **Per project**, create `.opencode/opencode.jsonc` to override only what needs to differ.

Example global config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@brycehamrick/opencode-hindsight",
      "options": {
        "dynamicBankId": true,
        "dynamicBankGranularity": ["agent", "gitProject"],
        "retainMode": "facts"
      }
    }
  ]
}
```

Example per-project override:

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

The project config replaces the global plugin options for that workspace. If you want both global and project options merged, list the plugin once in the global config and again in the project config with the overrides.

> The plugin also reads `~/.hindsight/opencode.json` for persistent defaults (see Configuration priority below). This is useful for credentials and settings you don't want to commit to a repo.

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
| `autoRecall` | `true` | Recall memories per user message |
| `autoRetain` | `true` | Retain conversation automatically |
| `retainMode` | `"facts"` | `"facts"`, `"transcript"`, or `"none"` |
| `coreMemoryMaxTokens` | `256` | Max tokens for always-injected core memory |
| `perMessageRecallMaxTokens` | `512` | Max tokens recalled per user message |
| `compactionRecallMaxTokens` | `512` | Max tokens recalled during compaction |
| `extractionMaxTokens` | `256` | Max tokens for extracted facts |
| `recallBudget` | `"mid"` | Hindsight recall budget (`low`/`mid`/`high`) |
| `recallContextTurns` | `2` | User turns included in recall query context |
| `recallMaxQueryChars` | `800` | Max characters in composed recall query |
| `recallPromptPreamble` | (see source) | Preamble prepended to injected memory context |
| `recallTypes` | `["world", "experience"]` | Memory types to recall |
| `recallTags` | `[]` | Tags to filter recall |
| `recallTagsMatch` | `"any"` | Tag matching mode |
| `retainContext` | `"opencode"` | Default context for retained memories |
| `retainEveryNTurns` | `3` | Retain every N user turns |
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

## Status

This plugin requires OpenCode v2.0 or newer and is **not** compatible with OpenCode V1. Built for and tested against opencode v2.0.27.

## License

MIT
