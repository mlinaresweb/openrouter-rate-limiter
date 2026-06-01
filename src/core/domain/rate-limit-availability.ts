import type { OpenRouterRequestMetadata } from './openrouter-request.js';
import type { OpenRouterCooldownReason } from './rate-limit-state.js';

export interface OpenRouterAvailabilityInspectionInput {
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
  readonly estimatedInputCharacters?: number;
  readonly estimatedOutputTokens?: number;
  readonly operation?: string;
  readonly requestId?: string;
  readonly allowWaiting?: boolean;
  readonly maxRetries?: number;
  readonly signal?: AbortSignal;
}

export type OpenRouterAvailabilityScope =
  | 'global'
  | 'model';

export interface OpenRouterAvailabilityConstraint {
  readonly scope: OpenRouterAvailabilityScope;
  readonly reason: OpenRouterCooldownReason;
  readonly waitMs: number;
  readonly retryAt: Date | null;
  readonly message: string;
}

export interface OpenRouterAvailabilityInspection {
  readonly canRunNow: boolean;
  readonly model: string;
  readonly waitMs: number;
  readonly retryAt: Date | null;
  readonly reason: OpenRouterCooldownReason | null;
  readonly constraints: readonly OpenRouterAvailabilityConstraint[];
  readonly metadata: OpenRouterRequestMetadata;
}