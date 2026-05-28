import type { OpenRouterRequestMetadata } from '../domain/openrouter-request.js';
import type { OpenRouterCooldownReason } from '../domain/rate-limit-state.js';
import { OpenRouterRateLimiterError } from './openrouter-rate-limiter-error.js';

export interface OpenRouterRateLimitErrorInput {
  readonly message: string;
  readonly model: string;
  readonly reason: OpenRouterCooldownReason;
  readonly retryAfterMs: number;
  readonly retryAt: Date;
  readonly attempt: number;
  readonly maxRetries: number;
  readonly metadata: OpenRouterRequestMetadata;
  readonly cause?: unknown;
}

export class OpenRouterRateLimitError extends OpenRouterRateLimiterError {
  public readonly model: string;
  public readonly reason: OpenRouterCooldownReason;
  public readonly retryAfterMs: number;
  public readonly retryAt: Date;
  public readonly attempt: number;
  public readonly maxRetries: number;
  public readonly metadata: OpenRouterRequestMetadata;

  public constructor(input: OpenRouterRateLimitErrorInput) {
    super({
      code: 'OPENROUTER_RATE_LIMITED',
      message: input.message,
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
    });

    this.name = 'OpenRouterRateLimitError';
    this.model = input.model;
    this.reason = input.reason;
    this.retryAfterMs = input.retryAfterMs;
    this.retryAt = input.retryAt;
    this.attempt = input.attempt;
    this.maxRetries = input.maxRetries;
    this.metadata = input.metadata;
  }
}