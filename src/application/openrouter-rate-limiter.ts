import type {
  OpenRouterGlobalRateLimitPolicy,
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
import type {
  OpenRouterAvailabilityConstraint,
  OpenRouterAvailabilityInspection,
  OpenRouterAvailabilityInspectionInput,
} from '../core/domain/rate-limit-availability.js';
import type {
  OpenRouterKeyInfoResult,
} from '../core/domain/openrouter-key-info.js';
import type {
  OpenRouterModelLookupResult,
  OpenRouterModelsListResult,
} from '../core/domain/openrouter-model-info.js';
import { OpenRouterCreditLimitError } from '../core/errors/openrouter-credit-limit-error.js';
import { OpenRouterRateLimitError } from '../core/errors/openrouter-rate-limit-error.js';
import {
  classifyOpenRouterErrorCategory,
  parseRetryAfterFromHeaders,
} from '../infrastructure/openrouter/openrouter-response-parser.js';
import {
  OpenRouterKeyClient,
} from '../infrastructure/openrouter/openrouter-key-client.js';
import {
  OpenRouterModelsClient,
  type ListOpenRouterModelsOptions,
} from '../infrastructure/openrouter/openrouter-models-client.js';
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

  private readonly globalQueue: ModelQueueState = {
    activeRequests: 0,
    waiters: [],
  };

  private readonly queues = new Map<string, ModelQueueState>();

  private keyClient: OpenRouterKeyClient | null = null;

  private modelsClient: OpenRouterModelsClient | null = null;

  private cachedKeyInfo: OpenRouterKeyInfoResult | null = null;

  private readonly cachedModelsByKey = new Map<string, OpenRouterModelsListResult>();

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

      await this.acquireExecutionSlots({
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

        this.releaseExecutionSlots(model);

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

      this.releaseExecutionSlots(model);

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

  public async inspectAvailability(
    input: OpenRouterAvailabilityInspectionInput,
  ): Promise<OpenRouterAvailabilityInspection> {
    const metadata = buildAvailabilityMetadata({
      input,
      defaultModel: this.config.defaultModel,
    });

    const model = resolveRequestModel({
      metadata,
      defaultModel: this.config.defaultModel,
    });

    const snapshot = await this.loadOrCreateMutableState();
    const modelState = getModelState(snapshot, model);
    const now = Date.now();

    const globalDecision = getGlobalPreflightWaitDecision({
      now,
      globalState: snapshot.global,
      globalPolicy: this.config.global,
      metadata,
    });

    const modelDecision = getPreflightWaitDecision({
      now,
      modelState,
      modelPolicy: this.config.models[model] ?? {},
      metadata,
    });

    const constraints = buildAvailabilityConstraints({
      model,
      globalDecision,
      modelDecision,
    });

    const selectedConstraint = constraints
      .slice()
      .sort((a, b) => b.waitMs - a.waitMs)[0];

    return {
      canRunNow: constraints.length === 0,
      model,
      waitMs: selectedConstraint?.waitMs ?? 0,
      retryAt: selectedConstraint?.retryAt ?? null,
      reason: selectedConstraint?.reason ?? null,
      constraints,
      metadata,
    };
  }

  public async getCurrentKeyInfo(
    options: {
      readonly forceRefresh?: boolean;
    } = {},
  ): Promise<OpenRouterKeyInfoResult> {
    const now = Date.now();

    if (
      !options.forceRefresh &&
      this.cachedKeyInfo &&
      now - this.cachedKeyInfo.checkedAtMs <= this.config.keyInfoTtlMs
    ) {
      return this.cachedKeyInfo;
    }

    const result = await this.getKeyClient().getCurrentKeyInfo();

    this.cachedKeyInfo = result;

    await this.updateGlobalState((global) => {
      return {
        ...global,
        lastKeyInfoCheckedAtMs: result.checkedAtMs,
        updatedAtMs: Date.now(),
      };
    });

    await this.config.hooks.onEvent?.({
      type: 'key_info',
      keyInfo: result.keyInfo,
    });

    return result;
  }

  public async listModels(
    options: ListOpenRouterModelsOptions & {
      readonly forceRefresh?: boolean;
    } = {},
  ): Promise<OpenRouterModelsListResult> {
    const cacheKey = buildModelsCacheKey(options);
    const now = Date.now();
    const cached = this.cachedModelsByKey.get(cacheKey);

    if (
      !options.forceRefresh &&
      cached &&
      now - cached.loadedAtMs <= this.config.modelsMetadataTtlMs
    ) {
      return cached;
    }

    const result = await this.getModelsClient().listModels({
      ...(options.category !== undefined ? { category: options.category } : {}),
      ...(options.supportedParameters !== undefined
        ? { supportedParameters: options.supportedParameters }
        : {}),
      ...(options.modality !== undefined ? { modality: options.modality } : {}),
    });

    this.cachedModelsByKey.set(cacheKey, result);

    await this.updateGlobalState((global) => {
      return {
        ...global,
        lastModelsMetadataCheckedAtMs: result.loadedAtMs,
        updatedAtMs: Date.now(),
      };
    });

    await this.config.hooks.onEvent?.({
      type: 'models_loaded',
      models: result.models,
    });

    return result;
  }

  public async getModelInfo(
    modelId: string,
    options: ListOpenRouterModelsOptions & {
      readonly forceRefresh?: boolean;
    } = {},
  ): Promise<OpenRouterModelLookupResult> {
    const loaded = await this.listModels(options);

    return {
      model: loaded.models.find((model) => model.id === modelId) ?? null,
      loadedAtMs: loaded.loadedAtMs,
    };
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

      const globalDecision = getGlobalPreflightWaitDecision({
        now,
        globalState: snapshot.global,
        globalPolicy: this.config.global,
        metadata: params.metadata,
      });

      const modelDecision = getPreflightWaitDecision({
        now,
        modelState,
        modelPolicy: params.modelPolicy,
        metadata: params.metadata,
      });

      const decision = selectPreflightWaitDecision([
        globalDecision,
        modelDecision,
      ]);

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

  private async acquireExecutionSlots(params: {
    readonly model: string;
    readonly modelPolicy: OpenRouterModelRateLimitPolicy;
    readonly metadata: OpenRouterRequestMetadata;
    readonly attempt: number;
  }): Promise<void> {
    const maxGlobalConcurrentRequests =
      this.config.global.maxConcurrentRequests ?? Number.POSITIVE_INFINITY;

    const maxModelConcurrentRequests =
      params.modelPolicy.maxConcurrentRequests ?? 1;

    const modelQueue = this.getQueue(params.model);

    while (
      this.globalQueue.activeRequests >= maxGlobalConcurrentRequests ||
      modelQueue.activeRequests >= maxModelConcurrentRequests
    ) {
      await this.emitLifecycle({
        type: 'request_queued',
        model: params.model,
        attempt: params.attempt,
        metadata: params.metadata,
      });

      await new Promise<void>((resolve) => {
        if (this.globalQueue.activeRequests >= maxGlobalConcurrentRequests) {
          this.globalQueue.waiters.push(resolve);
          return;
        }

        modelQueue.waiters.push(resolve);
      });
    }

    this.globalQueue.activeRequests += 1;
    modelQueue.activeRequests += 1;
  }

  private releaseExecutionSlots(model: string): void {
    this.globalQueue.activeRequests = Math.max(
      0,
      this.globalQueue.activeRequests - 1,
    );

    const modelQueue = this.getQueue(model);

    modelQueue.activeRequests = Math.max(0, modelQueue.activeRequests - 1);

    const globalNext = this.globalQueue.waiters.shift();

    if (globalNext) {
      globalNext();
    }

    const modelNext = modelQueue.waiters.shift();

    if (modelNext) {
      modelNext();
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
        rateLimitPolicy: this.config.models[params.model] ?? {},
      }),
    };

    snapshot.global = {
      ...snapshot.global,
      activeRequests: snapshot.global.activeRequests + 1,
      lastRequestStartedAtMs: now,
      rollingWindow: updateRollingWindowOnRequest({
        state: {
          model: '__global__',
          activeRequests: snapshot.global.activeRequests,
          lastRequestStartedAtMs: snapshot.global.lastRequestStartedAtMs,
          lastRequestFinishedAtMs: snapshot.global.lastRequestFinishedAtMs,
          cooldownUntilMs: snapshot.global.globalCooldownUntilMs,
          cooldownReason: snapshot.global.globalCooldownReason,
          lastRetryAfterMs: null,
          consecutiveRateLimitCount: 0,
          consecutiveTransientErrorCount: 0,
          rollingWindow: snapshot.global.rollingWindow,
          updatedAtMs: snapshot.global.updatedAtMs,
        },
        now,
        inputCharacters: params.metadata.estimatedInputCharacters ?? 0,
        rateLimitPolicy: this.config.global,
      }),
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
      lastRequestFinishedAtMs: now,
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

  private getKeyClient(): OpenRouterKeyClient {
    if (this.keyClient) {
      return this.keyClient;
    }

    this.keyClient = new OpenRouterKeyClient({
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      fetch: this.config.fetch,
      ...(this.config.appName !== null ? { appName: this.config.appName } : {}),
      ...(this.config.referer !== null ? { referer: this.config.referer } : {}),
      ...(this.config.userAgent !== null ? { userAgent: this.config.userAgent } : {}),
    });

    return this.keyClient;
  }

  private getModelsClient(): OpenRouterModelsClient {
    if (this.modelsClient) {
      return this.modelsClient;
    }

    this.modelsClient = new OpenRouterModelsClient({
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      fetch: this.config.fetch,
      ...(this.config.appName !== null ? { appName: this.config.appName } : {}),
      ...(this.config.referer !== null ? { referer: this.config.referer } : {}),
      ...(this.config.userAgent !== null ? { userAgent: this.config.userAgent } : {}),
    });

    return this.modelsClient;
  }

  private async updateGlobalState(
    updater: (
      global: OpenRouterGlobalRateLimitState,
    ) => OpenRouterGlobalRateLimitState,
  ): Promise<void> {
    const snapshot = await this.loadOrCreateMutableState();

    snapshot.global = updater(snapshot.global);

    await this.config.store.save(snapshot);
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
    appName: normalizeOptionalString(config.appName),
    referer: normalizeOptionalString(config.referer),
    userAgent: normalizeOptionalString(config.userAgent),
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
    global: config.global ?? {},
    models: config.models ?? {},
    store: config.store ?? createMemoryRateLimitStateStore(),
    hooks: config.hooks ?? {},
    inspectKeyBeforeRequest: config.inspectKeyBeforeRequest ?? false,
    loadModelsMetadata: config.loadModelsMetadata ?? false,
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

function getGlobalPreflightWaitDecision(params: {
  readonly now: number;
  readonly globalState: OpenRouterGlobalRateLimitState;
  readonly globalPolicy: OpenRouterGlobalRateLimitPolicy;
  readonly metadata: OpenRouterRequestMetadata;
}): PreflightWaitDecision {
  const cooldownUntilMs = params.globalState.globalCooldownUntilMs;

  if (cooldownUntilMs !== null && cooldownUntilMs > params.now) {
    return {
      shouldWait: true,
      delayMs: cooldownUntilMs - params.now,
      reason: params.globalState.globalCooldownReason ?? 'rate_limit',
    };
  }

  const minIntervalMs = params.globalPolicy.minIntervalMs ?? 0;
  const lastStartedAt = params.globalState.lastRequestStartedAtMs;

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

  return getGlobalRollingWindowWaitDecision(params);
}

function getGlobalRollingWindowWaitDecision(params: {
  readonly now: number;
  readonly globalState: OpenRouterGlobalRateLimitState;
  readonly globalPolicy: OpenRouterGlobalRateLimitPolicy;
  readonly metadata: OpenRouterRequestMetadata;
}): PreflightWaitDecision {
  const windowMs = params.globalPolicy.windowMs;

  if (!windowMs || windowMs <= 0) {
    return {
      shouldWait: false,
      delayMs: 0,
      reason: 'unknown',
    };
  }

  const rollingWindow = params.globalState.rollingWindow;

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

  const requestsLimit = params.globalPolicy.requestsPerWindow;

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

  const inputCharactersLimit = params.globalPolicy.inputCharactersPerWindow;
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

function selectPreflightWaitDecision(
  decisions: readonly PreflightWaitDecision[],
): PreflightWaitDecision {
  const waiting = decisions
    .filter((decision) => decision.shouldWait)
    .sort((a, b) => b.delayMs - a.delayMs);

  return waiting[0] ?? {
    shouldWait: false,
    delayMs: 0,
    reason: 'unknown',
  };
}

function updateRollingWindowOnRequest(params: {
  readonly state: OpenRouterModelRateLimitState;
  readonly now: number;
  readonly inputCharacters: number;
  readonly rateLimitPolicy:
    | OpenRouterModelRateLimitPolicy
    | OpenRouterGlobalRateLimitPolicy;
}): OpenRouterModelRateLimitState['rollingWindow'] {
  const windowMs = params.rateLimitPolicy.windowMs;

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
      rollingWindow: snapshot.global.rollingWindow
        ? {
            ...snapshot.global.rollingWindow,
          }
        : null,
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

function normalizeOptionalString(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function buildModelsCacheKey(
  options: ListOpenRouterModelsOptions & {
    readonly forceRefresh?: boolean;
  },
): string {
  return JSON.stringify({
    category: options.category ?? null,
    modality: options.modality ?? null,
    supportedParameters: options.supportedParameters ?? [],
  });
}

function buildAvailabilityMetadata(params: {
  readonly input: OpenRouterAvailabilityInspectionInput;
  readonly defaultModel: string | null;
}): OpenRouterRequestMetadata {
  const model = params.input.model ?? params.defaultModel;

  if (!model) {
    throw new Error(
      'inspectAvailability requires input.model or config.defaultModel.',
    );
  }

  return {
    model,
    ...(params.input.fallbackModels !== undefined
      ? { fallbackModels: params.input.fallbackModels }
      : {}),
    ...(params.input.estimatedInputCharacters !== undefined
      ? { estimatedInputCharacters: params.input.estimatedInputCharacters }
      : {}),
    ...(params.input.estimatedOutputTokens !== undefined
      ? { estimatedOutputTokens: params.input.estimatedOutputTokens }
      : {}),
    ...(params.input.operation !== undefined
      ? { operation: params.input.operation }
      : {}),
    ...(params.input.requestId !== undefined
      ? { requestId: params.input.requestId }
      : {}),
    ...(params.input.allowWaiting !== undefined
      ? { allowWaiting: params.input.allowWaiting }
      : {}),
    ...(params.input.maxRetries !== undefined
      ? { maxRetries: params.input.maxRetries }
      : {}),
    ...(params.input.signal !== undefined
      ? { signal: params.input.signal }
      : {}),
  };
}

function buildAvailabilityConstraints(params: {
  readonly model: string;
  readonly globalDecision: PreflightWaitDecision;
  readonly modelDecision: PreflightWaitDecision;
}): readonly OpenRouterAvailabilityConstraint[] {
  const constraints: OpenRouterAvailabilityConstraint[] = [];

  if (params.globalDecision.shouldWait) {
    constraints.push({
      scope: 'global',
      reason: params.globalDecision.reason,
      waitMs: params.globalDecision.delayMs,
      retryAt: new Date(Date.now() + params.globalDecision.delayMs),
      message: buildAvailabilityMessage({
        scope: 'global',
        model: params.model,
        decision: params.globalDecision,
      }),
    });
  }

  if (params.modelDecision.shouldWait) {
    constraints.push({
      scope: 'model',
      reason: params.modelDecision.reason,
      waitMs: params.modelDecision.delayMs,
      retryAt: new Date(Date.now() + params.modelDecision.delayMs),
      message: buildAvailabilityMessage({
        scope: 'model',
        model: params.model,
        decision: params.modelDecision,
      }),
    });
  }

  return constraints;
}

function buildAvailabilityMessage(params: {
  readonly scope: 'global' | 'model';
  readonly model: string;
  readonly decision: PreflightWaitDecision;
}): string {
  return [
    params.scope === 'global'
      ? 'Global OpenRouter limiter is not ready.'
      : `OpenRouter model "${params.model}" is not ready.`,
    `Reason: ${params.decision.reason}.`,
    `Wait: ${params.decision.delayMs.toString()}ms.`,
  ].join(' ');
}