export interface OpenRouterRequestMetadata {
  /**
   * Model used by the request.
   *
   * Example: qwen/qwen3.5-flash-02-23
   */
  readonly model: string;

  /**
   * Optional list of fallback models.
   *
   * This mirrors OpenRouter's multi-model routing use case.
   */
  readonly fallbackModels?: readonly string[];

  /**
   * Estimated input characters before sending the request.
   */
  readonly estimatedInputCharacters?: number;

  /**
   * Estimated output tokens or characters, if the caller knows it.
   */
  readonly estimatedOutputTokens?: number;

  /**
   * Logical operation name.
   *
   * Example: documentation-change-plan, documentation-draft, embeddings-sync.
   */
  readonly operation?: string;

  /**
   * External correlation ID.
   */
  readonly requestId?: string;

  /**
   * If true, this request can be queued/waited by the limiter.
   */
  readonly allowWaiting?: boolean;

  /**
   * Optional override for max retries for this request.
   */
  readonly maxRetries?: number;

  /**
   * Optional abort signal from the caller.
   */
  readonly signal?: AbortSignal;
}

export interface OpenRouterRateLimitedRequest<T> {
  readonly metadata: OpenRouterRequestMetadata;
  readonly execute: () => Promise<OpenRouterRateLimitedResponse<T>>;
}

export interface OpenRouterRateLimitedResponse<T> {
  readonly value: T;
  readonly status?: number;
  readonly headers?: Headers;
}