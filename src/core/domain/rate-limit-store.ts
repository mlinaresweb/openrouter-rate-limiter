import type { OpenRouterRateLimitStateSnapshot } from './rate-limit-state.js';

export interface OpenRouterRateLimitStateStore {
  readonly load: () => Promise<OpenRouterRateLimitStateSnapshot | null>;
  readonly save: (snapshot: OpenRouterRateLimitStateSnapshot) => Promise<void>;
  readonly clear: () => Promise<void>;
}