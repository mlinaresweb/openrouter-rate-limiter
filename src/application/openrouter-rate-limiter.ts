import type {
  OpenRouterRateLimiterConfig,
  ResolvedOpenRouterRateLimiterConfig,
} from '../core/domain/rate-limit-config.js';
import type {
  OpenRouterRateLimitedRequest,
  OpenRouterRateLimitedResponse,
} from '../core/domain/openrouter-request.js';
import type { OpenRouterRateLimitStateSnapshot } from '../core/domain/rate-limit-state.js';

export class OpenRouterRateLimiter {
  private readonly config: ResolvedOpenRouterRateLimiterConfig;

  public constructor(config: OpenRouterRateLimiterConfig) {
    this.config = resolveOpenRouterRateLimiterConfig(config);
  }

  public getConfig(): ResolvedOpenRouterRateLimiterConfig {
    return this.config;
  }

  public async execute<T>(
    request: OpenRouterRateLimitedRequest<T>,
  ): Promise<OpenRouterRateLimitedResponse<T>> {
    /**
     * ORL-5 will implement:
     * - state loading
     * - concurrency locks
     * - cooldown checks
     * - Retry-After handling
     * - retries
     * - hooks
     * - persistence
     */
    return request.execute();
  }

  public async getState(): Promise<OpenRouterRateLimitStateSnapshot | null> {
    return this.config.store.load();
  }

  public async clearState(): Promise<void> {
    await this.config.store.clear();
  }
}

function resolveOpenRouterRateLimiterConfig(
  config: OpenRouterRateLimiterConfig,
): ResolvedOpenRouterRateLimiterConfig {
  if (config.apiKey.trim().length === 0) {
    throw new Error('openrouter-rate-limiter requires a non-empty apiKey.');
  }

  const fetchImplementation = config.fetch ?? globalThis.fetch;

  if (typeof fetchImplementation !== 'function') {
    throw new Error(
      'openrouter-rate-limiter requires a fetch implementation. Use Node.js >=20 or pass config.fetch.',
    );
  }

  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? 'https://openrouter.ai/api/v1',
    defaultModel: config.defaultModel ?? null,
    defaultPolicy: {
      mode: config.defaultPolicy?.mode ?? 'wait',
      maxRetries: config.defaultPolicy?.maxRetries ?? 5,
      baseDelayMs: config.defaultPolicy?.baseDelayMs ?? 2_000,
      maxDelayMs: config.defaultPolicy?.maxDelayMs ?? 180_000,
      jitterRatio: config.defaultPolicy?.jitterRatio ?? 0.15,
      respectRetryAfter: config.defaultPolicy?.respectRetryAfter ?? true,
      retryOnServiceUnavailable:
        config.defaultPolicy?.retryOnServiceUnavailable ?? true,
      retryOnBadGateway: config.defaultPolicy?.retryOnBadGateway ?? true,
      retryOnTimeout: config.defaultPolicy?.retryOnTimeout ?? true,
    },
    models: config.models ?? {},
    store: config.store ?? createNoopStateStore(),
    hooks: config.hooks ?? {},
    inspectKeyBeforeRequest: config.inspectKeyBeforeRequest ?? true,
    loadModelsMetadata: config.loadModelsMetadata ?? true,
    modelsMetadataTtlMs: config.modelsMetadataTtlMs ?? 1000 * 60 * 60,
    keyInfoTtlMs: config.keyInfoTtlMs ?? 1000 * 60,
    fetch: fetchImplementation,
    clockMode: config.clockMode ?? 'system',
  };
}

function createNoopStateStore() {
  return {
    async load() {
      return null;
    },
    async save() {
      /**
       * No-op store for ORL-1.
       */
    },
    async clear() {
      /**
       * No-op store for ORL-1.
       */
    },
  };
}