import type { OpenRouterRateLimitEventHandlers } from './rate-limit-events.js';
import type { OpenRouterRateLimitStateStore } from './rate-limit-store.js';

export type OpenRouterRateLimitMode =
  | 'fail_fast'
  | 'wait'
  | 'ask';

export type OpenRouterRateLimitClockMode =
  | 'system'
  | 'monotonic';

export interface OpenRouterRateLimitPolicy {
  /**
   * What should happen when a request cannot be sent immediately.
   *
   * - fail_fast: throw immediately.
   * - wait: wait automatically and retry.
   * - ask: delegate the decision to hooks.onLimitReached.
   */
  readonly mode: OpenRouterRateLimitMode;

  /**
   * Maximum number of retries after 429/provider throttling.
   */
  readonly maxRetries: number;

  /**
   * Base delay for exponential backoff when Retry-After is unavailable.
   */
  readonly baseDelayMs: number;

  /**
   * Maximum delay allowed for a single wait.
   */
  readonly maxDelayMs: number;

  /**
   * Jitter ratio applied to calculated delays.
   *
   * 0 means disabled.
   * 0.2 means +/- 20%.
   */
  readonly jitterRatio: number;

  /**
   * Whether Retry-After should override local delay estimation.
   */
  readonly respectRetryAfter: boolean;

  /**
   * How often onCooldown is emitted while waiting.
   */
  readonly cooldownNotificationIntervalMs: number;

  /**
   * If true, 503 is treated as transient provider pressure and can be retried.
   */
  readonly retryOnServiceUnavailable: boolean;

  /**
   * If true, 502 is treated as transient provider error and can be retried.
   */
  readonly retryOnBadGateway: boolean;

  /**
   * If true, 408/timeout-like failures may be retried by user code through the limiter.
   */
  readonly retryOnTimeout: boolean;
}

export interface OpenRouterModelRateLimitPolicy {
  /**
   * Minimum interval between two requests for the same model.
   */
  readonly minIntervalMs?: number;

  /**
   * Maximum concurrent requests for the same model.
   */
  readonly maxConcurrentRequests?: number;

  /**
   * Optional manual requests per rolling window limit.
   */
  readonly requestsPerWindow?: number;

  /**
   * Rolling window size for requestsPerWindow.
   */
  readonly windowMs?: number;

  /**
   * Optional manual input token/character budget per rolling window.
   *
   * Characters are accepted because many apps estimate before tokenization.
   */
  readonly inputCharactersPerWindow?: number;

  /**
   * Optional custom policy for this model.
   */
  readonly policy?: Partial<OpenRouterRateLimitPolicy>;
}

export interface OpenRouterRateLimiterConfig {
  readonly apiKey: string;

  /**
   * Base URL. Defaults to https://openrouter.ai/api/v1.
   */
  readonly baseUrl?: string;

  /**
   * Default model. Individual requests can override it.
   */
  readonly defaultModel?: string;

  /**
   * Default global behavior.
   */
  readonly defaultPolicy?: Partial<OpenRouterRateLimitPolicy>;

  /**
   * Per-model manual overrides.
   */
  readonly models?: Readonly<Record<string, OpenRouterModelRateLimitPolicy>>;

  /**
   * Optional persistent or in-memory store.
   */
  readonly store?: OpenRouterRateLimitStateStore;

  /**
   * Optional hooks for CLIs, logs, telemetry and UI integrations.
   */
  readonly hooks?: OpenRouterRateLimitEventHandlers;

  /**
   * Whether the limiter should query /key before requests when useful.
   */
  readonly inspectKeyBeforeRequest?: boolean;

  /**
   * Whether the limiter should fetch /models and cache model metadata.
   */
  readonly loadModelsMetadata?: boolean;

  /**
   * How long model metadata can be reused.
   */
  readonly modelsMetadataTtlMs?: number;

  /**
   * How long key info can be reused.
   */
  readonly keyInfoTtlMs?: number;

  /**
   * Optional custom fetch implementation.
   */
  readonly fetch?: typeof fetch;

  /**
   * Clock mode for internal state.
   */
  readonly clockMode?: OpenRouterRateLimitClockMode;
}

export interface ResolvedOpenRouterRateLimitPolicy {
  readonly mode: OpenRouterRateLimitMode;
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
  readonly respectRetryAfter: boolean;
  readonly cooldownNotificationIntervalMs: number;
  readonly retryOnServiceUnavailable: boolean;
  readonly retryOnBadGateway: boolean;
  readonly retryOnTimeout: boolean;
}

export interface ResolvedOpenRouterRateLimiterConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly defaultModel: string | null;
  readonly defaultPolicy: ResolvedOpenRouterRateLimitPolicy;
  readonly models: Readonly<Record<string, OpenRouterModelRateLimitPolicy>>;
  readonly store: OpenRouterRateLimitStateStore;
  readonly hooks: OpenRouterRateLimitEventHandlers;
  readonly inspectKeyBeforeRequest: boolean;
  readonly loadModelsMetadata: boolean;
  readonly modelsMetadataTtlMs: number;
  readonly keyInfoTtlMs: number;
  readonly fetch: typeof fetch;
  readonly clockMode: OpenRouterRateLimitClockMode;
}