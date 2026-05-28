export type OpenRouterErrorCategory =
  | 'rate_limit'
  | 'credit_limit'
  | 'authentication'
  | 'authorization'
  | 'invalid_request'
  | 'not_found'
  | 'timeout'
  | 'provider_unavailable'
  | 'server_error'
  | 'network_error'
  | 'unknown';

export type OpenRouterResponseCategory =
  | 'success'
  | OpenRouterErrorCategory;

export interface OpenRouterResponseHeadersInfo {
  readonly retryAfterMs: number | null;
  readonly retryAt: Date | null;
  readonly rawRetryAfter: string | null;
}

export interface OpenRouterParsedError {
  readonly status: number;
  readonly statusText: string;
  readonly category: OpenRouterErrorCategory;
  readonly message: string;
  readonly isRetryable: boolean;
  readonly isRateLimited: boolean;
  readonly isCreditLimited: boolean;
  readonly retryAfterMs: number | null;
  readonly retryAt: Date | null;
  readonly rawText: string;
  readonly rawJson: unknown;
  readonly code?: string | number;
  readonly type?: string;
  readonly metadata?: unknown;
}

export interface OpenRouterResponseClassification {
  readonly ok: boolean;
  readonly httpOk: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly category: OpenRouterResponseCategory;
  readonly isRetryable: boolean;
  readonly retryAfterMs: number | null;
  readonly retryAt: Date | null;
  readonly rawText: string;
  readonly rawJson: unknown;
  readonly error: OpenRouterParsedError | null;
}

export interface OpenRouterExtractedRequestModel {
  readonly model: string | null;
  readonly fallbackModels: readonly string[];
}