import type { OpenRouterRateLimitStateSnapshot } from '../../core/domain/rate-limit-state.js';
import type { OpenRouterRateLimitStateStore } from '../../core/domain/rate-limit-store.js';
import { cloneOpenRouterRateLimitStateSnapshot } from './rate-limit-state-utils.js';

export interface MemoryRateLimitStateStoreOptions {
  readonly initialState?: OpenRouterRateLimitStateSnapshot | null;
}

/**
 * In-memory state store.
 *
 * Useful for:
 * - tests
 * - short-lived scripts
 * - serverless executions where persistence is not needed
 * - applications that want to provide their own persistence later
 */
export class MemoryRateLimitStateStore implements OpenRouterRateLimitStateStore {
  private snapshot: OpenRouterRateLimitStateSnapshot | null;

  public constructor(options: MemoryRateLimitStateStoreOptions = {}) {
    this.snapshot = options.initialState
      ? cloneOpenRouterRateLimitStateSnapshot(options.initialState)
      : null;
  }

  public async load(): Promise<OpenRouterRateLimitStateSnapshot | null> {
    return this.snapshot
      ? cloneOpenRouterRateLimitStateSnapshot(this.snapshot)
      : null;
  }

  public async save(
    snapshot: OpenRouterRateLimitStateSnapshot,
  ): Promise<void> {
    this.snapshot = cloneOpenRouterRateLimitStateSnapshot(snapshot);
  }

  public async clear(): Promise<void> {
    this.snapshot = null;
  }
}

export function createMemoryRateLimitStateStore(
  options: MemoryRateLimitStateStoreOptions = {},
): MemoryRateLimitStateStore {
  return new MemoryRateLimitStateStore(options);
}