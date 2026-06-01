export type OpenRouterCooldownReason =
  | 'rate_limit'
  | 'retry_after'
  | 'manual_policy'
  | 'credit_limit'
  | 'provider_unavailable'
  | 'unknown';

export interface OpenRouterModelWindowState {
  readonly windowStartedAtMs: number;
  readonly requestCount: number;
  readonly inputCharacters: number;
}

export interface OpenRouterModelRateLimitState {
  readonly model: string;
  readonly activeRequests: number;
  readonly lastRequestStartedAtMs: number | null;
  readonly lastRequestFinishedAtMs: number | null;
  readonly cooldownUntilMs: number | null;
  readonly cooldownReason: OpenRouterCooldownReason | null;
  readonly lastRetryAfterMs: number | null;
  readonly consecutiveRateLimitCount: number;
  readonly consecutiveTransientErrorCount: number;
  readonly rollingWindow: OpenRouterModelWindowState | null;
  readonly updatedAtMs: number;
}

export interface OpenRouterGlobalRateLimitState {
  readonly activeRequests: number;
  readonly lastRequestStartedAtMs: number | null;
  readonly lastRequestFinishedAtMs: number | null;
  readonly rollingWindow: OpenRouterModelWindowState | null;
  readonly lastKeyInfoCheckedAtMs: number | null;
  readonly lastModelsMetadataCheckedAtMs: number | null;
  readonly globalCooldownUntilMs: number | null;
  readonly globalCooldownReason: OpenRouterCooldownReason | null;
  readonly updatedAtMs: number;
}

export interface OpenRouterRateLimitStateSnapshot {
  readonly version: 1;
  readonly global: OpenRouterGlobalRateLimitState;
  readonly models: Readonly<Record<string, OpenRouterModelRateLimitState>>;
}