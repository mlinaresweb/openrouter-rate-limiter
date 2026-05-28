import type { OpenRouterKeyInfo } from './openrouter-key-info.js';
import type { OpenRouterModelInfo } from './openrouter-model-info.js';
import type { OpenRouterRequestMetadata } from './openrouter-request.js';
import type { OpenRouterCooldownReason } from './rate-limit-state.js';

export type OpenRouterLimitDecision =
  | 'wait'
  | 'fail'
  | 'skip';

export interface OpenRouterRateLimitWarningEvent {
  readonly type: 'warning';
  readonly message: string;
  readonly model: string | null;
  readonly operation: string | null;
  readonly metadata: OpenRouterRequestMetadata | null;
}

export interface OpenRouterLimitReachedEvent {
  readonly type: 'limit_reached';
  readonly model: string;
  readonly operation: string | null;
  readonly reason: OpenRouterCooldownReason;
  readonly retryAfterMs: number;
  readonly attempt: number;
  readonly maxRetries: number;
  readonly metadata: OpenRouterRequestMetadata;

  /**
   * Used only when policy.mode = ask.
   *
   * Return wait to let the limiter sleep and retry.
   * Return fail to throw.
   * Return skip to stop retrying and return control to caller through an error.
   */
  readonly defaultDecision: OpenRouterLimitDecision;
}

export interface OpenRouterCooldownEvent {
  readonly type: 'cooldown';
  readonly model: string;
  readonly operation: string | null;
  readonly reason: OpenRouterCooldownReason;
  readonly remainingMs: number;
  readonly retryAt: Date;
  readonly metadata: OpenRouterRequestMetadata;
}

export interface OpenRouterRetryEvent {
  readonly type: 'retry';
  readonly model: string;
  readonly operation: string | null;
  readonly attempt: number;
  readonly maxRetries: number;
  readonly delayMs: number;
  readonly reason: OpenRouterCooldownReason;
  readonly metadata: OpenRouterRequestMetadata;
}

export interface OpenRouterRequestLifecycleEvent {
  readonly type:
    | 'request_queued'
    | 'request_started'
    | 'request_succeeded'
    | 'request_failed';
  readonly model: string;
  readonly operation: string | null;
  readonly attempt: number;
  readonly metadata: OpenRouterRequestMetadata;
}

export interface OpenRouterKeyInfoEvent {
  readonly type: 'key_info';
  readonly keyInfo: OpenRouterKeyInfo;
}

export interface OpenRouterModelsLoadedEvent {
  readonly type: 'models_loaded';
  readonly models: readonly OpenRouterModelInfo[];
}

export type OpenRouterRateLimitEvent =
  | OpenRouterRateLimitWarningEvent
  | OpenRouterLimitReachedEvent
  | OpenRouterCooldownEvent
  | OpenRouterRetryEvent
  | OpenRouterRequestLifecycleEvent
  | OpenRouterKeyInfoEvent
  | OpenRouterModelsLoadedEvent;

export interface OpenRouterRateLimitEventHandlers {
  readonly onEvent?: (event: OpenRouterRateLimitEvent) => void | Promise<void>;
  readonly onWarning?: (event: OpenRouterRateLimitWarningEvent) => void | Promise<void>;
  readonly onLimitReached?: (
    event: OpenRouterLimitReachedEvent,
  ) => OpenRouterLimitDecision | Promise<OpenRouterLimitDecision>;
  readonly onCooldown?: (event: OpenRouterCooldownEvent) => void | Promise<void>;
  readonly onRetry?: (event: OpenRouterRetryEvent) => void | Promise<void>;
}