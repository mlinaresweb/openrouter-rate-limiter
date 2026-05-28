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

export interface OpenRouterModelRateLimitPolicy {
  readonly minIntervalMs?: number;
  readonly maxConcurrentRequests?: number;
  readonly requestsPerWindow?: number;
  readonly windowMs?: number;
  readonly inputCharactersPerWindow?: number;
  readonly policy?: Partial<OpenRouterRateLimitPolicy>;
}

export interface OpenRouterRateLimiterConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;

  /**
   * Optional headers used by OpenRouter for rankings/analytics.
   */
  readonly appName?: string;
  readonly referer?: string;
  readonly userAgent?: string;

  readonly defaultPolicy?: Partial<OpenRouterRateLimitPolicy>;
  readonly models?: Readonly<Record<string, OpenRouterModelRateLimitPolicy>>;
  readonly store?: OpenRouterRateLimitStateStore;
  readonly hooks?: OpenRouterRateLimitEventHandlers;

  /**
   * Public API metadata clients.
   *
   * These do not automatically run before every request unless your app calls
   * getCurrentKeyInfo/listModels/getModelInfo.
   */
  readonly inspectKeyBeforeRequest?: boolean;
  readonly loadModelsMetadata?: boolean;
  readonly modelsMetadataTtlMs?: number;
  readonly keyInfoTtlMs?: number;

  readonly fetch?: typeof fetch;
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
  readonly appName: string | null;
  readonly referer: string | null;
  readonly userAgent: string | null;
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