import type {
  OpenRouterModelRateLimitPolicy,
  OpenRouterRateLimiterConfig,
  ResolvedOpenRouterRateLimiterConfig,
  ResolvedOpenRouterRateLimitPolicy,
} from '../core/domain/rate-limit-config.js';
import type {
  OpenRouterRateLimitedRequest,
  OpenRouterRateLimitedResponse,
  OpenRouterRequestMetadata,
} from '../core/domain/openrouter-request.js';
import type {
  OpenRouterCooldownReason,
  OpenRouterGlobalRateLimitState,
  OpenRouterModelRateLimitState,
  OpenRouterRateLimitStateSnapshot,
} from '../core/domain/rate-limit-state.js';
import { OpenRouterCreditLimitError } from '../core/errors/openrouter-credit-limit-error.js';
import { OpenRouterRateLimitError } from '../core/errors/openrouter-rate-limit-error.js';
import {
  classifyOpenRouterErrorCategory,
  parseRetryAfterFromHeaders,
} from '../infrastructure/openrouter/openrouter-response-parser.js';
import { createMemoryRateLimitStateStore } from '../infrastructure/storage/memory-rate-limit-state-store.js';
import {
  createEmptyModelState,
  createEmptyOpenRouterRateLimitStateSnapshot,
} from '../infrastructure/storage/rate-limit-state-utils.js';
import { sleepMs } from '../infrastructure/time/sleep.js';
import { clampNumber } from '../shared/date-utils.js';

interface ModelQueueState {
  activeRequests: number;
  readonly waiters: Array<() => void>;
}

interface PreflightWaitDecision {
  readonly shouldWait: boolean;
  readonly delayMs: number;
  readonly reason: OpenRouterCooldownReason;
}

interface RequestAttemptFailure {
  readonly shouldRetry: boolean;
  readonly delayMs: number;
  readonly reason: OpenRouterCooldownReason;
  readonly error: unknown;
}

interface MutableOpenRouterRateLimitStateSnapshot {
  version: 1;
  global: OpenRouterGlobalRateLimitState;
  models: Record<string, OpenRouterModelRateLimitState>;
}

export class OpenRouterRateLimiter {
  private readonly config: ResolvedOpenRouterRateLimiterConfig;
  private readonly queues = new Map<string, ModelQueueState>();

  public constructor(config: OpenRouterRateLimiterConfig) {
    this.config = resolveOpenRouterRateLimiterConfig(config);
  }

  public getConfig(): ResolvedOpenRouterRateLimiterConfig {
    return this.config;
  }

  public async execute<T>(
    request: OpenRouterRateLimitedRequest<T>,
  ): Promise<OpenRouterRateLimitedResponse<T>> {
    const model = resolveRequestModel({
      metadata: request.metadata,
      defaultModel: this.config.defaultModel,
    });

    const modelPolicy = this.config.models[model] ?? {};
    const policy = resolvePolicy({
      defaultPolicy: this.config.defaultPolicy,
      modelPolicy,
      requestMetadata: request.metadata,
    });

    const maxRetries = request.metadata.maxRetries ?? policy.maxRetries;

    let attempt = 0;

    while (true) {
      attempt += 1;

      await this.waitForPreflightAvailability({
        model,
        metadata: request.metadata,
        modelPolicy,
        policy,
        attempt,
        maxRetries,
      });

      await this.acquireModelSlot({
        model,
        modelPolicy,
        metadata: request.metadata,
        attempt,
      });

      await this.markRequestStarted({
        model,
        metadata: request.metadata,
      });

      let response: OpenRouterRateLimitedResponse<T>;

      try {
        await this.emitLifecycle({
          type: 'request_started',
          model,
          attempt,
          metadata: request.metadata,
        });

        response = await request.execute();
      } catch (error) {
        const transientFailure = this.classifyThrownFailure({
          error,
          model,
          metadata: request.metadata,
          attempt,
          maxRetries,
          policy,
        });

        await this.markRequestFailed({
          model,
          reason: transientFailure.reason,
          retryAfterMs: transientFailure.delayMs,
          metadata: request.metadata,
        });

        await this.emitLifecycle({
          type: 'request_failed',
          model,
          attempt,
          metadata: request.metadata,
        });

        await this.markRequestFinished({
          model,
        });

        this.releaseModelSlot(model);

        if (!transientFailure.shouldRetry || attempt > maxRetries) {
          throw transientFailure.error;
        }

        await this.waitBeforeRetry({
          model,
          metadata: request.metadata,
          attempt,
          maxRetries,
          delayMs: transientFailure.delayMs,
          reason: transientFailure.reason,
          policy,
        });

        continue;
      }

      await this.markRequestFinished({
        model,
      });

      this.releaseModelSlot(model);

      const failure = await this.classifyResponseFailure({
        model,
        response,
        metadata: request.metadata,
        attempt,
        maxRetries,
        policy,
      });

      if (!failure) {
        await this.markRequestSucceeded({
          model,
          metadata: request.metadata,
        });

        await this.emitLifecycle({
          type: 'request_succeeded',
          model,
          attempt,
          metadata: request.metadata,
        });

        return response;
      }

      await this.markRequestFailed({
        model,
        reason: failure.reason,
        retryAfterMs: failure.delayMs,
        metadata: request.metadata,
      });

      await this.emitLifecycle({
        type: 'request_failed',
        model,
        attempt,
        metadata: request.metadata,
      });

      if (!failure.shouldRetry || attempt > maxRetries) {
        throw failure.error;
      }

      await this.waitBeforeRetry({
        model,
        metadata: request.metadata,
        attempt,
        maxRetries,
        delayMs: failure.delayMs,
        reason: failure.reason,
        policy,
      });
    }
  }

  public async getState(): Promise<OpenRouterRateLimitStateSnapshot | null> {
    return this.config.store.load();
  }

  public async setState(
    snapshot: OpenRouterRateLimitStateSnapshot,
  ): Promise<void> {
    await this.config.store.save(snapshot);
  }

  public async clearState(): Promise<void> {
    await this.config.store.clear();
  }

  private async waitForPreflightAvailability(params: {
    readonly model: string;
    readonly metadata: OpenRouterRequestMetadata;
    readonly modelPolicy: OpenRouterModelRateLimitPolicy;
    readonly policy: ResolvedOpenRouterRateLimitPolicy;
    readonly attempt: number;
    readonly maxRetries: number;
  }): Promise<void> {
    while (true) {
      const snapshot = await this.loadOrCreateMutableState();
      const modelState = getModelState(snapshot, params.model);
      const now = Date.now();

      const decision = getPreflightWaitDecision({
        now,
        modelState,
        modelPolicy: params.modelPolicy,
        metadata: params.metadata,
      });

      if (!decision.shouldWait) {
        return;
      }

      await this.handleLimitReached({
        model: params.model,
        metadata: params.metadata,
        attempt: params.attempt,
        maxRetries: params.maxRetries,
        delayMs: decision.delayMs,
        reason: decision.reason,
        policy: params.policy,
      });
    }
  }

  private async acquireModelSlot(params: {
    readonly model: string;
    readonly modelPolicy: OpenRouterModelRateLimitPolicy;
    readonly metadata: OpenRouterRequestMetadata;
    readonly attempt: number;
  }): Promise<void> {
    const maxConcurrentRequests = params.modelPolicy.maxConcurrentRequests ?? 1;
    const queue = this.getQueue(params.model);

    while (queue.activeRequests >= maxConcurrentRequests) {
      await this.emitLifecycle({
        type: 'request_queued',
        model: params.model,
        attempt: params.attempt,
        metadata: params.metadata,
      });

      await new Promise<void>((resolve) => {
        queue.waiters.push(resolve);
      });
    }

    queue.activeRequests += 1;
  }

  private releaseModelSlot(model: string): void {
    const queue = this.getQueue(model);

    queue.activeRequests = Math.max(0, queue.activeRequests - 1);

    const next = queue.waiters.shift();

    if (next) {
      next();
    }
  }

  private getQueue(model: string): ModelQueueState {
    const existing = this.queues.get(model);

    if (existing) {
      return existing;
    }

    const created: ModelQueueState = {
      activeRequests: 0,
      waiters: [],
    };

    this.queues.set(model, created);

    return created;
  }

  private async classifyResponseFailure<T>(params: {
    readonly model: string;
    readonly response: OpenRouterRateLimitedResponse<T>;
    readonly metadata: OpenRouterRequestMetadata;
    readonly attempt: number;
    readonly maxRetries: number;
    readonly policy: ResolvedOpenRouterRateLimitPolicy;
  }): Promise<RequestAttemptFailure | null> {
    const status = params.response.status;

    if (status === undefined || (status >= 200 && status < 300)) {
      return null;
    }

    const retryAfterInfo = parseRetryAfterFromHeaders(params.response.headers);

    const category = classifyOpenRouterErrorCategory({
      status,
      code: status,
      message: '',
      type: null,
    });

    if (category === 'credit_limit') {
      return {
        shouldRetry: false,
        delayMs: 0,
        reason: 'credit_limit',
        error: new OpenRouterCreditLimitError({
          message: 'OpenRouter credit limit reached.',
          keyInfo: null,
          metadata: params.metadata,
          cause: {
            status,
          },
        }),
      };
    }

    const shouldRetry = shouldRetryStatus({
      status,
      policy: params.policy,
    });

    const reason = mapCategoryToCooldownReason(category);

    const delayMs = calculateRetryDelay({
      policy: params.policy,
      attempt: params.attempt,
      retryAfterMs: retryAfterInfo.retryAfterMs,
    });

    return {
      shouldRetry,
      delayMs,
      reason,
      error: new OpenRouterRateLimitError({
        message: buildRateLimitMessage({
          model: params.model,
          reason,
          delayMs,
          attempt: params.attempt,
          maxRetries: params.maxRetries,
        }),
        model: params.model,
        reason,
        retryAfterMs: delayMs,
        retryAt: new Date(Date.now() + delayMs),
        attempt: params.attempt,
        maxRetries: params.maxRetries,
        metadata: params.metadata,
        cause: {
          status,
          category,
        },
      }),
    };
  }

  private classifyThrownFailure(params: {
    readonly error: unknown;
    readonly model: string;
    readonly metadata: OpenRouterRequestMetadata;
    readonly attempt: number;
    readonly maxRetries: number;
    readonly policy: ResolvedOpenRouterRateLimitPolicy;
  }): RequestAttemptFailure {
    if (params.error instanceof OpenRouterCreditLimitError) {
      return {
        shouldRetry: false,
        delayMs: 0,
        reason: 'credit_limit',
        error: params.error,
      };
    }

    if (params.error instanceof OpenRouterRateLimitError) {
      return {
        shouldRetry: params.attempt <= params.maxRetries,
        delayMs: params.error.retryAfterMs,
        reason: params.error.reason,
        error: params.error,
      };
    }

    const isAbortError =
      params.error instanceof Error && params.error.name === 'AbortError';

    if (isAbortError) {
      return {
        shouldRetry: false,
        delayMs: 0,
        reason: 'unknown',
        error: params.error,
      };
    }

    const delayMs = calculateRetryDelay({
      policy: params.policy,
      attempt: params.attempt,
      retryAfterMs: null,
    });

    return {
      shouldRetry: params.policy.retryOnTimeout,
      delayMs,
      reason: 'unknown',
      error: params.error,
    };
  }

  private async waitBeforeRetry(params: {
    readonly model: string;
    readonly metadata: OpenRouterRequestMetadata;
    readonly attempt: number;
    readonly maxRetries: number;
    readonly delayMs: number;
    readonly reason: OpenRouterCooldownReason;
    readonly policy: ResolvedOpenRouterRateLimitPolicy;
  }): Promise<void> {
    await this.emitRetry({
      model: params.model,
      metadata: params.metadata,
      attempt: params.attempt,
      maxRetries: params.maxRetries,
      delayMs: params.delayMs,
      reason: params.reason,
    });

    await this.handleLimitReached({
      model: params.model,
      metadata: params.metadata,
      attempt: params.attempt,
      maxRetries: params.maxRetries,
      delayMs: params.delayMs,
      reason: params.reason,
      policy: params.policy,
    });
  }

  private async handleLimitReached(params: {
    readonly model: string;
    readonly metadata: OpenRouterRequestMetadata;
    readonly attempt: number;
    readonly maxRetries: number;
    readonly delayMs: number;
    readonly reason: OpenRouterCooldownReason;
    readonly policy: ResolvedOpenRouterRateLimitPolicy;
  }): Promise<void> {
    if (params.policy.mode === 'fail_fast') {
      throw new OpenRouterRateLimitError({
        message: buildRateLimitMessage({
          model: params.model,
          reason: params.reason,
          delayMs: params.delayMs,
          attempt: params.attempt,
          maxRetries: params.maxRetries,
        }),
        model: params.model,
        reason: params.reason,
        retryAfterMs: params.delayMs,
        retryAt: new Date(Date.now() + params.delayMs),
        attempt: params.attempt,
        maxRetries: params.maxRetries,
        metadata: params.metadata,
      });
    }

    if (params.policy.mode === 'ask') {
      const decision = await this.config.hooks.onLimitReached?.({
        type: 'limit_reached',
        model: params.model,
        operation: params.metadata.operation ?? null,
        reason: params.reason,
        retryAfterMs: params.delayMs,
        attempt: params.attempt,
        maxRetries: params.maxRetries,
        metadata: params.metadata,
        defaultDecision: 'wait',
      });

      if (decision === 'fail' || decision === 'skip') {
        throw new OpenRouterRateLimitError({
          message: `OpenRouter request stopped by user decision: ${decision}.`,
          model: params.model,
          reason: params.reason,
          retryAfterMs: params.delayMs,
          retryAt: new Date(Date.now() + params.delayMs),
          attempt: params.attempt,
          maxRetries: params.maxRetries,
          metadata: params.metadata,
        });
      }
    }

    await this.waitWithCooldownEvents({
      model: params.model,
      metadata: params.metadata,
      reason: params.reason,
      delayMs: params.delayMs,
      notificationIntervalMs: params.policy.cooldownNotificationIntervalMs,
    });
  }

  private async waitWithCooldownEvents(params: {
    readonly model: string;
    readonly metadata: OpenRouterRequestMetadata;
    readonly reason: OpenRouterCooldownReason;
    readonly delayMs: number;
    readonly notificationIntervalMs: number;
  }): Promise<void> {
    const startMs = Date.now();
    const endMs = startMs + Math.max(0, params.delayMs);

    while (true) {
      const now = Date.now();
      const remainingMs = Math.max(endMs - now, 0);

      if (remainingMs <= 0) {
        return;
      }

      await this.emitCooldown({
        model: params.model,
        metadata: params.metadata,
        reason: params.reason,
        remainingMs,
      });

      await sleepMs(
        Math.min(remainingMs, params.notificationIntervalMs),
        {
          ...(params.metadata.signal !== undefined
            ? { signal: params.metadata.signal }
            : {}),
        },
      );
    }
  }

  private async markRequestStarted(params: {
    readonly model: string;
    readonly metadata: OpenRouterRequestMetadata;
  }): Promise<void> {
    const now = Date.now();
    const snapshot = await this.loadOrCreateMutableState();
    const modelState = getModelState(snapshot, params.model);

    snapshot.models[params.model] = {
      ...modelState,
      activeRequests: modelState.activeRequests + 1,
      lastRequestStartedAtMs: now,
      updatedAtMs: now,
      rollingWindow: updateRollingWindowOnRequest({
        state: modelState,
        now,
        inputCharacters: params.metadata.estimatedInputCharacters ?? 0,
        modelPolicy: this.config.models[params.model] ?? {},
      }),
    };

    snapshot.global = {
      ...snapshot.global,
      activeRequests: snapshot.global.activeRequests + 1,
      updatedAtMs: now,
    };

    await this.config.store.save(snapshot);
  }

  private async markRequestSucceeded(params: {
    readonly model: string;
    readonly metadata: OpenRouterRequestMetadata;
  }): Promise<void> {
    const now = Date.now();
    const snapshot = await this.loadOrCreateMutableState();
    const modelState = getModelState(snapshot, params.model);

    snapshot.models[params.model] = {
      ...modelState,
      consecutiveRateLimitCount: 0,
      consecutiveTransientErrorCount: 0,
      cooldownUntilMs: null,
      cooldownReason: null,
      lastRetryAfterMs: null,
      updatedAtMs: now,
    };

    await this.config.store.save(snapshot);
  }

  private async markRequestFailed(params: {
    readonly model: string;
    readonly reason: OpenRouterCooldownReason;
    readonly retryAfterMs: number;
    readonly metadata: OpenRouterRequestMetadata;
  }): Promise<void> {
    const now = Date.now();
    const snapshot = await this.loadOrCreateMutableState();
    const modelState = getModelState(snapshot, params.model);

    snapshot.models[params.model] = {
      ...modelState,
      cooldownUntilMs: now + Math.max(0, params.retryAfterMs),
      cooldownReason: params.reason,
      lastRetryAfterMs: params.retryAfterMs,
      consecutiveRateLimitCount:
        params.reason === 'rate_limit'
          ? modelState.consecutiveRateLimitCount + 1
          : modelState.consecutiveRateLimitCount,
      consecutiveTransientErrorCount:
        params.reason === 'provider_unavailable' || params.reason === 'unknown'
          ? modelState.consecutiveTransientErrorCount + 1
          : modelState.consecutiveTransientErrorCount,
      updatedAtMs: now,
    };

    await this.config.store.save(snapshot);
  }

  private async markRequestFinished(params: {
    readonly model: string;
  }): Promise<void> {
    const now = Date.now();
    const snapshot = await this.loadOrCreateMutableState();
    const modelState = getModelState(snapshot, params.model);

    snapshot.models[params.model] = {
      ...modelState,
      activeRequests: Math.max(0, modelState.activeRequests - 1),
      lastRequestFinishedAtMs: now,
      updatedAtMs: now,
    };

    snapshot.global = {
      ...snapshot.global,
      activeRequests: Math.max(0, snapshot.global.activeRequests - 1),
      updatedAtMs: now,
    };

    await this.config.store.save(snapshot);
  }

  private async loadOrCreateMutableState(): Promise<MutableOpenRouterRateLimitStateSnapshot> {
    const loaded = await this.config.store.load();

    if (!loaded) {
      return toMutableSnapshot(
        createEmptyOpenRouterRateLimitStateSnapshot(Date.now()),
      );
    }

    return toMutableSnapshot(loaded);
  }

  private async emitLifecycle(params: {
    readonly type:
      | 'request_queued'
      | 'request_started'
      | 'request_succeeded'
      | 'request_failed';
    readonly model: string;
    readonly attempt: number;
    readonly metadata: OpenRouterRequestMetadata;
  }): Promise<void> {
    const event = {
      type: params.type,
      model: params.model,
      operation: params.metadata.operation ?? null,
      attempt: params.attempt,
      metadata: params.metadata,
    } as const;

    await this.config.hooks.onEvent?.(event);
  }

  private async emitCooldown(params: {
    readonly model: string;
    readonly metadata: OpenRouterRequestMetadata;
    readonly reason: OpenRouterCooldownReason;
    readonly remainingMs: number;
  }): Promise<void> {
    const event = {
      type: 'cooldown',
      model: params.model,
      operation: params.metadata.operation ?? null,
      reason: params.reason,
      remainingMs: params.remainingMs,
      retryAt: new Date(Date.now() + params.remainingMs),
      metadata: params.metadata,
    } as const;

    await this.config.hooks.onCooldown?.(event);
    await this.config.hooks.onEvent?.(event);
  }

  private async emitRetry(params: {
    readonly model: string;
    readonly metadata: OpenRouterRequestMetadata;
    readonly attempt: number;
    readonly maxRetries: number;
    readonly delayMs: number;
    readonly reason: OpenRouterCooldownReason;
  }): Promise<void> {
    const event = {
      type: 'retry',
      model: params.model,
      operation: params.metadata.operation ?? null,
      attempt: params.attempt,
      maxRetries: params.maxRetries,
      delayMs: params.delayMs,
      reason: params.reason,
      metadata: params.metadata,
    } as const;

    await this.config.hooks.onRetry?.(event);
    await this.config.hooks.onEvent?.(event);
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
      cooldownNotificationIntervalMs:
        config.defaultPolicy?.cooldownNotificationIntervalMs ?? 15_000,
      retryOnServiceUnavailable:
        config.defaultPolicy?.retryOnServiceUnavailable ?? true,
      retryOnBadGateway: config.defaultPolicy?.retryOnBadGateway ?? true,
      retryOnTimeout: config.defaultPolicy?.retryOnTimeout ?? true,
    },
    models: config.models ?? {},
    store: config.store ?? createMemoryRateLimitStateStore(),
    hooks: config.hooks ?? {},
    inspectKeyBeforeRequest: config.inspectKeyBeforeRequest ?? true,
    loadModelsMetadata: config.loadModelsMetadata ?? true,
    modelsMetadataTtlMs: config.modelsMetadataTtlMs ?? 1000 * 60 * 60,
    keyInfoTtlMs: config.keyInfoTtlMs ?? 1000 * 60,
    fetch: fetchImplementation,
    clockMode: config.clockMode ?? 'system',
  };
}

function resolveRequestModel(params: {
  readonly metadata: OpenRouterRequestMetadata;
  readonly defaultModel: string | null;
}): string {
  const model = params.metadata.model || params.defaultModel;

  if (!model) {
    throw new Error(
      'OpenRouterRateLimiter requires metadata.model or config.defaultModel.',
    );
  }

  return model;
}

function resolvePolicy(params: {
  readonly defaultPolicy: ResolvedOpenRouterRateLimitPolicy;
  readonly modelPolicy: OpenRouterModelRateLimitPolicy;
  readonly requestMetadata: OpenRouterRequestMetadata;
}): ResolvedOpenRouterRateLimitPolicy {
  const override = params.modelPolicy.policy ?? {};

  return {
    mode: override.mode ?? params.defaultPolicy.mode,
    maxRetries:
      params.requestMetadata.maxRetries ??
      override.maxRetries ??
      params.defaultPolicy.maxRetries,
    baseDelayMs: override.baseDelayMs ?? params.defaultPolicy.baseDelayMs,
    maxDelayMs: override.maxDelayMs ?? params.defaultPolicy.maxDelayMs,
    jitterRatio: override.jitterRatio ?? params.defaultPolicy.jitterRatio,
    respectRetryAfter:
      override.respectRetryAfter ?? params.defaultPolicy.respectRetryAfter,
    cooldownNotificationIntervalMs:
      override.cooldownNotificationIntervalMs ??
      params.defaultPolicy.cooldownNotificationIntervalMs,
    retryOnServiceUnavailable:
      override.retryOnServiceUnavailable ??
      params.defaultPolicy.retryOnServiceUnavailable,
    retryOnBadGateway:
      override.retryOnBadGateway ?? params.defaultPolicy.retryOnBadGateway,
    retryOnTimeout: override.retryOnTimeout ?? params.defaultPolicy.retryOnTimeout,
  };
}

function getModelState(
  snapshot: MutableOpenRouterRateLimitStateSnapshot,
  model: string,
): OpenRouterModelRateLimitState {
  const existing = snapshot.models[model];

  if (existing) {
    return existing;
  }

  const created = createEmptyModelState({
    model,
    nowMs: Date.now(),
  });

  snapshot.models[model] = created;

  return created;
}

function getPreflightWaitDecision(params: {
  readonly now: number;
  readonly modelState: OpenRouterModelRateLimitState;
  readonly modelPolicy: OpenRouterModelRateLimitPolicy;
  readonly metadata: OpenRouterRequestMetadata;
}): PreflightWaitDecision {
  const cooldownUntilMs = params.modelState.cooldownUntilMs;

  if (cooldownUntilMs !== null && cooldownUntilMs > params.now) {
    return {
      shouldWait: true,
      delayMs: cooldownUntilMs - params.now,
      reason: params.modelState.cooldownReason ?? 'rate_limit',
    };
  }

  const minIntervalMs = params.modelPolicy.minIntervalMs ?? 0;
  const lastStartedAt = params.modelState.lastRequestStartedAtMs;

  if (
    minIntervalMs > 0 &&
    lastStartedAt !== null &&
    params.now - lastStartedAt < minIntervalMs
  ) {
    return {
      shouldWait: true,
      delayMs: minIntervalMs - (params.now - lastStartedAt),
      reason: 'manual_policy',
    };
  }

  const rollingWait = getRollingWindowWaitDecision(params);

  if (rollingWait.shouldWait) {
    return rollingWait;
  }

  return {
    shouldWait: false,
    delayMs: 0,
    reason: 'unknown',
  };
}

function getRollingWindowWaitDecision(params: {
  readonly now: number;
  readonly modelState: OpenRouterModelRateLimitState;
  readonly modelPolicy: OpenRouterModelRateLimitPolicy;
  readonly metadata: OpenRouterRequestMetadata;
}): PreflightWaitDecision {
  const windowMs = params.modelPolicy.windowMs;

  if (!windowMs || windowMs <= 0) {
    return {
      shouldWait: false,
      delayMs: 0,
      reason: 'unknown',
    };
  }

  const rollingWindow = params.modelState.rollingWindow;

  if (!rollingWindow) {
    return {
      shouldWait: false,
      delayMs: 0,
      reason: 'unknown',
    };
  }

  const windowEndsAt = rollingWindow.windowStartedAtMs + windowMs;

  if (params.now >= windowEndsAt) {
    return {
      shouldWait: false,
      delayMs: 0,
      reason: 'unknown',
    };
  }

  const requestsLimit = params.modelPolicy.requestsPerWindow;

  if (
    requestsLimit !== undefined &&
    requestsLimit > 0 &&
    rollingWindow.requestCount >= requestsLimit
  ) {
    return {
      shouldWait: true,
      delayMs: windowEndsAt - params.now,
      reason: 'manual_policy',
    };
  }

  const inputCharactersLimit = params.modelPolicy.inputCharactersPerWindow;
  const requestCharacters = params.metadata.estimatedInputCharacters ?? 0;

  if (
    inputCharactersLimit !== undefined &&
    inputCharactersLimit > 0 &&
    rollingWindow.inputCharacters + requestCharacters > inputCharactersLimit
  ) {
    return {
      shouldWait: true,
      delayMs: windowEndsAt - params.now,
      reason: 'manual_policy',
    };
  }

  return {
    shouldWait: false,
    delayMs: 0,
    reason: 'unknown',
  };
}

function updateRollingWindowOnRequest(params: {
  readonly state: OpenRouterModelRateLimitState;
  readonly now: number;
  readonly inputCharacters: number;
  readonly modelPolicy: OpenRouterModelRateLimitPolicy;
}): OpenRouterModelRateLimitState['rollingWindow'] {
  const windowMs = params.modelPolicy.windowMs;

  if (!windowMs || windowMs <= 0) {
    return params.state.rollingWindow;
  }

  const existing = params.state.rollingWindow;

  if (!existing || params.now >= existing.windowStartedAtMs + windowMs) {
    return {
      windowStartedAtMs: params.now,
      requestCount: 1,
      inputCharacters: params.inputCharacters,
    };
  }

  return {
    windowStartedAtMs: existing.windowStartedAtMs,
    requestCount: existing.requestCount + 1,
    inputCharacters: existing.inputCharacters + params.inputCharacters,
  };
}

function shouldRetryStatus(params: {
  readonly status: number;
  readonly policy: ResolvedOpenRouterRateLimitPolicy;
}): boolean {
  if (params.status === 429 || params.status === 500 || params.status === 504) {
    return true;
  }

  if (params.status === 503) {
    return params.policy.retryOnServiceUnavailable;
  }

  if (params.status === 502) {
    return params.policy.retryOnBadGateway;
  }

  if (params.status === 408) {
    return params.policy.retryOnTimeout;
  }

  return false;
}

function mapCategoryToCooldownReason(
  category: string,
): OpenRouterCooldownReason {
  if (category === 'rate_limit') {
    return 'rate_limit';
  }

  if (category === 'credit_limit') {
    return 'credit_limit';
  }

  if (category === 'provider_unavailable' || category === 'server_error') {
    return 'provider_unavailable';
  }

  return 'unknown';
}

function calculateRetryDelay(params: {
  readonly policy: ResolvedOpenRouterRateLimitPolicy;
  readonly attempt: number;
  readonly retryAfterMs: number | null;
}): number {
  if (
    params.policy.respectRetryAfter &&
    params.retryAfterMs !== null &&
    params.retryAfterMs >= 0
  ) {
    return Math.min(params.retryAfterMs, params.policy.maxDelayMs);
  }

  const exponential =
    params.policy.baseDelayMs * 2 ** Math.max(params.attempt - 1, 0);

  const clamped = clampNumber({
    value: exponential,
    min: params.policy.baseDelayMs,
    max: params.policy.maxDelayMs,
  });

  if (params.policy.jitterRatio <= 0) {
    return clamped;
  }

  const jitterRange = clamped * params.policy.jitterRatio;
  const jitter = Math.random() * jitterRange * 2 - jitterRange;

  return Math.round(
    clampNumber({
      value: clamped + jitter,
      min: params.policy.baseDelayMs,
      max: params.policy.maxDelayMs,
    }),
  );
}

function buildRateLimitMessage(params: {
  readonly model: string;
  readonly reason: OpenRouterCooldownReason;
  readonly delayMs: number;
  readonly attempt: number;
  readonly maxRetries: number;
}): string {
  return [
    `OpenRouter request for model "${params.model}" is limited.`,
    `Reason: ${params.reason}.`,
    `Retry after: ${params.delayMs.toString()}ms.`,
    `Attempt: ${params.attempt.toString()}/${params.maxRetries.toString()}.`,
  ].join(' ');
}

function toMutableSnapshot(
  snapshot: OpenRouterRateLimitStateSnapshot,
): MutableOpenRouterRateLimitStateSnapshot {
  return {
    version: 1,
    global: {
      ...snapshot.global,
    },
    models: Object.fromEntries(
      Object.entries(snapshot.models).map(([model, state]) => {
        return [
          model,
          {
            ...state,
            rollingWindow: state.rollingWindow
              ? {
                  ...state.rollingWindow,
                }
              : null,
          },
        ];
      }),
    ),
  };
}