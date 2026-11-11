import { HindsightClient } from "@vectorize-io/hindsight-client";
import type { Logger } from "../logger.js";
import type { RecallBudget } from "./tokens.js";

export interface HindsightClientConfig {
  baseUrl: string;
  apiKey: string | null;
  logger: Logger;
}

export interface RecallOptions {
  budget: RecallBudget;
  maxTokens?: number;
  types?: string[];
  tags?: string[];
  tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
  /** Sent automatically as the current time when unset (see recall below). */
  queryTimestamp?: string;
  /** Per-call deadline in ms. Rejects with a TimeoutError (not retried). */
  timeoutMs?: number;
}

export interface RetainOptions {
  context?: string;
  documentId?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  async?: boolean;
}

export interface ReflectOptions {
  context?: string;
  budget?: RecallBudget;
  /** Per-call deadline in ms. Rejects with a TimeoutError (not retried). */
  timeoutMs?: number;
}

/**
 * A per-call deadline expired. Deliberately shaped so withRetry will NOT
 * retry it (no status, no retryable code) — retry budgets belong to the
 * injection engine, not the transport.
 *
 * The underlying SDK (hindsight-client 0.5.x) accepts no AbortSignal, so the
 * request itself keeps draining; the wrapper simply stops waiting. Real
 * wire-level cancellation arrives with a pages-capable client upgrade.
 */
export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timeout after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

/** Race an operation against a deadline; ignore a late resolution. */
function raceTimeout<T>(operation: () => Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) return operation();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
    operation().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export interface RecallResponse {
  results: { text: string; type?: string | null; mentioned_at?: string | null; metadata?: Record<string, string> | null }[];
}

export interface ReflectResponse {
  text: string | null;
}

/** Delays for HTTP 429 (rate limit) retries.
 *
 * Aligned with typical edge rate-limit block windows (e.g. a Cloudflare
 * "block 10s" rule in front of a self-hosted Hindsight): retrying sooner
 * than the block window just burns attempts. */
const RATE_LIMIT_DELAYS_MS = [10_000, 20_000, 40_000];

async function withRetry<T>(
  operation: () => Promise<T>,
  logger: Logger,
  retries = 3,
  baseDelayMs = 250
): Promise<T> {
  let lastError: unknown;
  let rateLimitAttempt = 0;
  for (let attempt = 0; attempt < retries + RATE_LIMIT_DELAYS_MS.length; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const rateLimited = errorStatus(error) === 429;
      if (!rateLimited && !isRetryableError(error)) break;

      let delay: number;
      if (rateLimited) {
        if (rateLimitAttempt >= RATE_LIMIT_DELAYS_MS.length) break;
        delay = RATE_LIMIT_DELAYS_MS[rateLimitAttempt++];
      } else {
        if (attempt >= retries - 1) break;
        delay = baseDelayMs * 2 ** attempt;
      }
      logger.debug("Hindsight API call failed, retrying", {
        attempt: attempt + 1,
        delay,
        rateLimited,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/** Best-effort HTTP status off a thrown client error (used to classify
 * auto-inject failures: 4xx is permanent, everything else retries). */
export function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const status = (error as { status?: number }).status;
    if (typeof status === "number") return status;
    // fetch()-style errors expose the Response itself
    const response = (error as { response?: { status?: number } }).response;
    if (response && typeof response.status === "number") return response.status;
  }
  return undefined;
}

function isRetryableError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = errorStatus(error);
    if (status === 429 || (status !== undefined && status >= 500)) return true;
    const code = (error as { code?: string }).code;
    if (code && ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED"].includes(code)) return true;
  }
  return false;
}

export function createHindsightClientWrapper(config: HindsightClientConfig): HindsightClientWrapper {
  return new HindsightClientWrapper(config);
}

export class HindsightClientWrapper {
  private readonly client: HindsightClient;
  private readonly logger: Logger;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;

  constructor(config: HindsightClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey || null;
    this.client = new HindsightClient({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey || undefined,
    });
    this.logger = config.logger;
  }

  async createBank(
    bankId: string,
    options: { reflectMission?: string; retainMission?: string } = {}
  ): Promise<void> {
    await withRetry(
      () => this.client.createBank(bankId, options),
      this.logger
    );
  }

  async recall(bankId: string, query: string, options: RecallOptions): Promise<RecallResponse> {
    const { timeoutMs, ...callOptions } = options;
    return await raceTimeout(
      () =>
        withRetry(
          () =>
            this.client.recall(bankId, query, {
              ...callOptions,
              // Temporal retrieval keys off this; a missing timestamp degrades
              // recency-sensitive queries. Always send "now" unless overridden.
              queryTimestamp: callOptions.queryTimestamp ?? new Date().toISOString(),
            }),
          this.logger
        ),
      timeoutMs
    );
  }

  async retain(bankId: string, content: string, options: RetainOptions = {}): Promise<void> {
    await withRetry(
      () =>
        this.client.retain(bankId, content, {
          context: options.context,
          documentId: options.documentId,
          tags: options.tags,
          metadata: options.metadata,
          async: options.async,
        }),
      this.logger
    );
  }

  async reflect(bankId: string, query: string, options: ReflectOptions = {}): Promise<ReflectResponse> {
    const { timeoutMs, ...callOptions } = options;
    return await raceTimeout(
      () =>
        withRetry(
          () =>
            this.client.reflect(bankId, query, {
              context: callOptions.context,
              budget: callOptions.budget,
            }),
          this.logger
        ),
      timeoutMs
    );
  }

  async deleteDocument(bankId: string, documentId: string): Promise<boolean> {
    const clientDelete = (this.client as any).deleteDocument;
    if (typeof clientDelete === "function") {
      await withRetry(() => clientDelete.call(this.client, bankId, documentId), this.logger);
      return true;
    }

    // Fallback to a direct REST call if the installed client version does not
    // expose deleteDocument (e.g. older hindsight-client packages).
    await withRetry(() => this.deleteDocumentViaFetch(bankId, documentId), this.logger);
    return true;
  }

  private async deleteDocumentViaFetch(bankId: string, documentId: string): Promise<void> {
    const url = `${this.baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`;
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const response = await fetch(url, { method: "DELETE", headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`deleteDocument failed: ${response.status} ${body}`);
    }
  }
}
