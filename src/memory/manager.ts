import type { HindsightConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { Message, PluginState, RecallResult } from "../types.js";
import { saveState, type StorageContext } from "../state.js";
import { deriveBankId } from "../bank.js";
import { createHindsightClientWrapper } from "./client.js";
import { createRecallEngine, type RecallEngine } from "./recall.js";
import { createRetentionEngine, type RetentionEngine } from "./retain.js";
import { formatMemoryContext, formatCurrentTime } from "./content.js";

export interface MemoryManager {
  initialize(agentName?: string): Promise<void>;
  shutdown(): Promise<void>;
  setWorkspaceDirectory(directory: string): void;
  getCoreMemories(agentName?: string): Promise<RecallResult[]>;
  recallForMessage(message: string, recentMessages: Message[], agentName?: string): Promise<RecallResult[]>;
  recallByQuery(query: string, maxTokens?: number, agentName?: string): Promise<RecallResult[]>;
  reflect(query: string, context?: string, agentName?: string): Promise<string>;
  retainTurns(sessionId: string, turns: Message[], agentName?: string): Promise<void>;
  retainFact(fact: string, context?: string, metadata?: Record<string, string>, tags?: string[], agentName?: string): Promise<void>;
  forget(documentId?: string, query?: string, agentName?: string): Promise<boolean>;
  onCompaction(sessionId: string, turns?: Message[], agentName?: string): Promise<string | null>;
  getDiagnostics(agentName?: string): { directory: string; bankId: string; agent: string };
}

export interface MemoryManagerDependencies {
  config: HindsightConfig;
  state: PluginState;
  directory: string;
  logger: Logger;
  storage?: StorageContext;
  defaultAgentName?: string;
}

interface AgentEngines {
  bankId: string;
  recall: RecallEngine;
  retention: RetentionEngine;
  coreMemoryPromise: Promise<RecallResult[]> | null;
  bankMissionPromise: Promise<void> | null;
}

export function createMemoryManager(deps: MemoryManagerDependencies): MemoryManager {
  const { config, state, logger, storage } = deps;
  const defaultAgentName = deps.defaultAgentName ?? config.agentName ?? "opencode";

  // The workspace directory is resolved per session (each OpenCode session
  // knows its own location.directory); the value passed at construction is
  // only the initial/default guess until the first session reports in.
  let currentDirectory = deps.directory;

  const client = createHindsightClientWrapper({
    baseUrl: config.hindsightApiUrl,
    apiKey: config.hindsightApiToken,
    logger,
  });

  const enginesByAgent = new Map<string, AgentEngines>();
  let initialized = false;

  function getEngines(agentName = defaultAgentName): AgentEngines {
    const existing = enginesByAgent.get(agentName);
    if (existing) return existing;

    const bankId = deriveBankId(
      {
        bankId: config.bankId,
        bankIdPrefix: config.bankIdPrefix,
        dynamicBankId: config.dynamicBankId,
        dynamicBankGranularity: config.dynamicBankGranularity,
        agentName,
      },
      currentDirectory
    );

    const engines: AgentEngines = {
      bankId,
      recall: createRecallEngine(client, bankId, config, logger),
      retention: createRetentionEngine(client, bankId, config, logger),
      coreMemoryPromise: null,
      bankMissionPromise: null,
    };

    enginesByAgent.set(agentName, engines);
    return engines;
  }

  async function persistState(): Promise<void> {
    if (storage) {
      await saveState(storage, state);
    }
  }

  /**
   * Update the workspace directory used for bank derivation. Called when a
   * session reports its own location (OpenCode's background service hosts
   * sessions from many directories in one process, so the directory cannot
   * be resolved once at setup time).
   */
  function setWorkspaceDirectory(directory: string): void {
    if (typeof directory !== "string" || !directory.trim()) return;
    if (directory === currentDirectory) return;
    currentDirectory = directory;
    // Bank IDs depend on the directory, so stale engines must be rebuilt.
    enginesByAgent.clear();
    logger.info("Hindsight workspace directory updated", { directory });
  }

  async function initialize(agentName?: string): Promise<void> {
    if (initialized) return;

    const engines = getEngines(agentName ?? defaultAgentName);

    logger.info("Hindsight plugin initializing", {
      api: config.hindsightApiUrl,
      bank: engines.bankId,
      agent: agentName ?? defaultAgentName,
      authenticated: Boolean(config.hindsightApiToken),
      autoRecall: config.autoRecall,
      autoRetain: config.autoRetain,
      retainMode: config.retainMode,
    });

    if (config.bankMission.trim()) {
      await ensureBankMission(agentName ?? defaultAgentName);
    }

    // Pre-fetch core memory so first recall is fast.
    engines.coreMemoryPromise = engines.recall.recallCoreMemories();

    initialized = true;
  }

  async function ensureBankMission(agentName = defaultAgentName): Promise<void> {
    const engines = getEngines(agentName);
    if (!config.bankMission.trim() || state.missions.includes(engines.bankId)) return;
    if (engines.bankMissionPromise) return engines.bankMissionPromise;

    engines.bankMissionPromise = (async () => {
      try {
        await client.createBank(engines.bankId, {
          reflectMission: config.bankMission,
          retainMission: config.retainMission || undefined,
        });
        state.missions.push(engines.bankId);
        // Cap tracked missions
        if (state.missions.length > 10000) {
          state.missions = state.missions.slice(state.missions.length - 5000);
        }
        await persistState();
        logger.debug("Set bank mission", { bankId: engines.bankId, agent: agentName });
      } catch (error) {
        logger.debug("Could not set bank mission", {
          bankId: engines.bankId,
          agent: agentName,
          error: String(error),
        });
      } finally {
        engines.bankMissionPromise = null;
      }
    })();

    return engines.bankMissionPromise;
  }

  async function shutdown(): Promise<void> {
    await persistState();
  }

  async function getCoreMemories(agentName?: string): Promise<RecallResult[]> {
    if (!config.autoRecall) return [];
    const engines = getEngines(agentName ?? defaultAgentName);
    if (!engines.coreMemoryPromise) {
      engines.coreMemoryPromise = engines.recall.recallCoreMemories();
    }
    return await engines.coreMemoryPromise;
  }

  async function recallForMessage(
    message: string,
    recentMessages: Message[],
    agentName?: string
  ): Promise<RecallResult[]> {
    if (!config.autoRecall) return [];
    const engines = getEngines(agentName ?? defaultAgentName);
    return await engines.recall.recallForMessage(message, recentMessages);
  }

  async function recallByQuery(
    query: string,
    maxTokens?: number,
    agentName?: string
  ): Promise<RecallResult[]> {
    const engines = getEngines(agentName ?? defaultAgentName);
    return await engines.recall.recallByQuery(query, maxTokens);
  }

  async function reflect(
    query: string,
    context?: string,
    agentName?: string
  ): Promise<string> {
    const engines = getEngines(agentName ?? defaultAgentName);
    try {
      const response = await client.reflect(engines.bankId, query, {
        context,
        budget: config.recallBudget,
      });
      return response.text || "No relevant information found to reflect on.";
    } catch (error) {
      logger.error("Reflect failed", { error: String(error), query });
      return "Unable to reflect on long-term memory right now.";
    }
  }

  async function retainTurns(
    sessionId: string,
    turns: Message[],
    agentName?: string
  ): Promise<void> {
    if (!config.autoRetain || config.retainMode === "none") return;

    const engines = getEngines(agentName ?? defaultAgentName);
    state.sessions[sessionId] ??= { lastRetainedTurn: 0 };
    const previousState = state.sessions[sessionId];
    const nextState = await engines.retention.retainTurns(sessionId, turns, previousState);
    state.sessions[sessionId] = nextState;
    await persistState();
  }

  async function retainFact(
    fact: string,
    context?: string,
    metadata?: Record<string, string>,
    tags?: string[],
    agentName?: string
  ): Promise<void> {
    const engines = getEngines(agentName ?? defaultAgentName);
    await engines.retention.retainFact(fact, context, metadata, tags);
  }

  async function forget(
    documentId?: string,
    query?: string,
    agentName?: string
  ): Promise<boolean> {
    const engines = getEngines(agentName ?? defaultAgentName);
    if (documentId) {
      return await engines.retention.deleteByDocumentId(documentId);
    }
    if (query) {
      return await engines.retention.deleteByQuery(query);
    }
    return false;
  }

  async function onCompaction(
    sessionId: string,
    turns: Message[] = [],
    agentName?: string
  ): Promise<string | null> {
    // Retain any pending turns before compaction.
    if (config.autoRetain && config.retainMode !== "none" && turns.length) {
      await retainTurns(sessionId, turns, agentName);
    }

    // Then recall relevant memories for compaction context.
    const lastUser = [...turns].reverse().find((m) => m.role === "user");
    if (!config.autoRecall || !lastUser) return null;

    const engines = getEngines(agentName ?? defaultAgentName);
    const results = await engines.recall.recallByQuery(
      lastUser.content,
      config.compactionRecallMaxTokens
    );
    if (!results.length) return null;

    const context = formatMemoryContext(results, {
      preamble:
        config.recallPromptPreamble + `\nCurrent time: ${formatCurrentTime()} UTC`,
      maxTokens: config.compactionRecallMaxTokens,
    });

    return context;
  }

  function getDiagnostics(agentName?: string): { directory: string; bankId: string; agent: string } {
    const name = agentName ?? defaultAgentName;
    const engines = getEngines(name);
    return { directory: currentDirectory, bankId: engines.bankId, agent: name };
  }

  return {
    initialize,
    shutdown,
    setWorkspaceDirectory,
    getCoreMemories,
    recallForMessage,
    recallByQuery,
    reflect,
    retainTurns,
    retainFact,
    forget,
    onCompaction,
    getDiagnostics,
  };
}
