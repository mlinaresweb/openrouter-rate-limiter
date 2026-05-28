import type { OpenRouterKeyInfo } from '../domain/openrouter-key-info.js';
import type { OpenRouterRequestMetadata } from '../domain/openrouter-request.js';
import { OpenRouterRateLimiterError } from './openrouter-rate-limiter-error.js';

export interface OpenRouterCreditLimitErrorInput {
  readonly message: string;
  readonly keyInfo: OpenRouterKeyInfo | null;
  readonly metadata: OpenRouterRequestMetadata | null;
  readonly cause?: unknown;
}

export class OpenRouterCreditLimitError extends OpenRouterRateLimiterError {
  public readonly keyInfo: OpenRouterKeyInfo | null;
  public readonly metadata: OpenRouterRequestMetadata | null;

  public constructor(input: OpenRouterCreditLimitErrorInput) {
    super({
      code: 'OPENROUTER_CREDIT_LIMIT',
      message: input.message,
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
    });

    this.name = 'OpenRouterCreditLimitError';
    this.keyInfo = input.keyInfo;
    this.metadata = input.metadata;
  }
}