/**
 * Hindsight OpenCode V2 Plugin
 *
 * Token-efficient long-term memory for OpenCode agents.
 *
 * This module intentionally does NOT import `@opencode-ai/plugin` at runtime.
 * OpenCode loads plugins inside its host process where the `effect` dependency
 * resolves against the version embedded in the opencode binary. The SDK builds
 * published to npm can lag the host: opencode v2.0.27 bundles effect 4.0.1
 * (where `Schema.isStartsWith` was renamed to `Schema.isStartingWith`), while
 * the SDK betas still execute `Schema.isStartsWith("wrk")` at module scope in
 * `@opencode-ai/schema`, which crashed plugin loading with
 * "Schema.isStartsWith is not a function" before `setup()` could run.
 *
 * The plugin contract only requires a default export of `{ id, setup }`
 * (`Plugin.define` in the SDK is an identity function), so we define the
 * plugin locally and keep the SDK as a dev-only type source. The bundled
 * output has no runtime dependencies outside node builtins, making it immune
 * to host/SDK version skew.
 */

import { loadConfig, type HindsightPluginOptions } from "./config.js";
import { createMemoryManager } from "./memory/manager.js";
import { loadState, type StorageContext } from "./state.js";
import { registerTools } from "./tools/index.js";
import { registerHooks } from "./hooks/index.js";
import { resolveWorkspaceDirectory } from "./workspace.js";

/**
 * Minimal shape of the OpenCode V2 plugin context used by this plugin.
 * Kept intentionally permissive: OpenCode evolves the context between
 * releases, and every optional field below already has a fallback.
 */
export interface PluginContext {
  readonly options?: HindsightPluginOptions;
  readonly storage?: StorageContext;
  readonly agent?: unknown;
  readonly logger?: unknown;
  readonly [key: string]: unknown;
}

/** OpenCode V2 promise-plugin definition. */
export interface HindsightPluginDefinition {
  readonly id: string;
  setup(ctx: PluginContext): Promise<(() => void) | void>;
}

export default {
  id: "hindsight",
  async setup(ctx: PluginContext) {
    const rawOptions = (ctx.options ?? {}) as HindsightPluginOptions;
    const config = loadConfig(rawOptions);
    const state = await loadState(ctx.storage);

    const directory = resolveWorkspaceDirectory(ctx);

    // Resolve the default agent name. OpenCode V2 exposes ctx.agent; fall back
    // to the configured agentName (or "opencode") when it is unavailable.
    const agent = ctx.agent as
      | { default?: { id?: string }; get?: (id: string) => { id?: string } | undefined }
      | undefined;
    const defaultAgentName =
      agent?.default?.id ?? agent?.get?.("default")?.id ?? config.agentName ?? "opencode";

    const memory = createMemoryManager({
      config,
      state,
      directory,
      logger: (ctx.logger as Console | undefined) ?? console,
      storage: ctx.storage,
      defaultAgentName,
    });

    await memory.initialize(defaultAgentName);

    await registerTools(ctx as never, memory);
    const cleanupHooks = await registerHooks(ctx as never, memory);

    return () => {
      cleanupHooks?.();
      void memory.shutdown();
    };
  },
} as const satisfies HindsightPluginDefinition;
