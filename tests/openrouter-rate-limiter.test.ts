import { describe, expect, it } from 'vitest';

import {
  OpenRouterRateLimitError,
  OpenRouterRateLimiter,
  createEmptyModelState,
  createEmptyOpenRouterRateLimitStateSnapshot,
  createMemoryRateLimitStateStore,
  type OpenRouterLimitDecision,
} from '../src/index.js';

describe('openrouter-rate-limiter · limiter engine', () => {
  it('executes a successful request', async () => {
    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
    });

    const response = await limiter.execute({
      metadata: {
        model: 'openai/gpt-4o-mini',
        operation: 'success',
      },
      execute: async () => ({
        value: 'ok',
        status: 200,
      }),
    });

    expect(response.value).toBe('ok');
  });

  it('fails fast when a model is already in cooldown', async () => {
    const snapshot = {
      ...createEmptyOpenRouterRateLimitStateSnapshot(1000),
      models: {
        'qwen/qwen3.5-flash-02-23': {
          ...createEmptyModelState({
            model: 'qwen/qwen3.5-flash-02-23',
            nowMs: 1000,
          }),
          cooldownUntilMs: Date.now() + 60_000,
          cooldownReason: 'rate_limit' as const,
        },
      },
    };

    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
      store: createMemoryRateLimitStateStore({
        initialState: snapshot,
      }),
      defaultPolicy: {
        mode: 'fail_fast',
      },
    });

    await expect(
      limiter.execute({
        metadata: {
          model: 'qwen/qwen3.5-flash-02-23',
          operation: 'cooldown',
        },
        execute: async () => ({
          value: 'never',
          status: 200,
        }),
      }),
    ).rejects.toBeInstanceOf(OpenRouterRateLimitError);
  });

  it('waits for minIntervalMs before executing the next request', async () => {
    const events: string[] = [];

    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
      models: {
        'openai/gpt-4o-mini': {
          minIntervalMs: 20,
        },
      },
      defaultPolicy: {
        mode: 'wait',
        cooldownNotificationIntervalMs: 5,
      },
      hooks: {
        onCooldown: async () => {
          events.push('cooldown');
        },
      },
    });

    await limiter.execute({
      metadata: {
        model: 'openai/gpt-4o-mini',
      },
      execute: async () => ({
        value: 'first',
        status: 200,
      }),
    });

    await limiter.execute({
      metadata: {
        model: 'openai/gpt-4o-mini',
      },
      execute: async () => ({
        value: 'second',
        status: 200,
      }),
    });

    expect(events.length).toBeGreaterThan(0);
  });

  it('retries after a 429 response and then succeeds', async () => {
    let calls = 0;
    const retries: number[] = [];

    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
      defaultPolicy: {
        mode: 'wait',
        maxRetries: 2,
        baseDelayMs: 1,
        maxDelayMs: 5,
        jitterRatio: 0,
        cooldownNotificationIntervalMs: 1,
      },
      hooks: {
        onRetry: async (event) => {
          retries.push(event.attempt);
        },
      },
    });

    const result = await limiter.execute({
      metadata: {
        model: 'qwen/qwen3.5-flash-02-23',
        operation: 'retry-429',
      },
      execute: async () => {
        calls += 1;

        if (calls === 1) {
          return {
            value: 'limited',
            status: 429,
            headers: new Headers({
              'Retry-After': '0',
            }),
          };
        }

        return {
          value: 'ok',
          status: 200,
        };
      },
    });

    expect(result.value).toBe('ok');
    expect(calls).toBe(2);
    expect(retries).toEqual([1]);
  });

  it('uses ask mode and stops when the hook returns fail', async () => {
    const initialState = {
      ...createEmptyOpenRouterRateLimitStateSnapshot(Date.now()),
      models: {
        'qwen/qwen3.5-flash-02-23': {
          ...createEmptyModelState({
            model: 'qwen/qwen3.5-flash-02-23',
          }),
          cooldownUntilMs: Date.now() + 10_000,
          cooldownReason: 'rate_limit' as const,
        },
      },
    };

    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
      defaultPolicy: {
        mode: 'ask',
      },
      hooks: {
        onLimitReached: async (): Promise<OpenRouterLimitDecision> => 'fail',
      },
      store: createMemoryRateLimitStateStore({
        initialState,
      }),
    });

    await expect(
      limiter.execute({
        metadata: {
          model: 'qwen/qwen3.5-flash-02-23',
        },
        execute: async () => ({
          value: 'never',
          status: 200,
        }),
      }),
    ).rejects.toBeInstanceOf(OpenRouterRateLimitError);
  });

  it('enforces requestsPerWindow in fail_fast mode', async () => {
    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
      models: {
        'openai/gpt-4o-mini': {
          requestsPerWindow: 1,
          windowMs: 60_000,
        },
      },
      defaultPolicy: {
        mode: 'fail_fast',
      },
    });

    await limiter.execute({
      metadata: {
        model: 'openai/gpt-4o-mini',
      },
      execute: async () => ({
        value: 'first',
        status: 200,
      }),
    });

    await expect(
      limiter.execute({
        metadata: {
          model: 'openai/gpt-4o-mini',
        },
        execute: async () => ({
          value: 'second',
          status: 200,
        }),
      }),
    ).rejects.toBeInstanceOf(OpenRouterRateLimitError);
  });

  it('enforces inputCharactersPerWindow in fail_fast mode', async () => {
    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
      models: {
        'openai/gpt-4o-mini': {
          inputCharactersPerWindow: 100,
          windowMs: 60_000,
        },
      },
      defaultPolicy: {
        mode: 'fail_fast',
      },
    });

    await limiter.execute({
      metadata: {
        model: 'openai/gpt-4o-mini',
        estimatedInputCharacters: 80,
      },
      execute: async () => ({
        value: 'first',
        status: 200,
      }),
    });

    await expect(
      limiter.execute({
        metadata: {
          model: 'openai/gpt-4o-mini',
          estimatedInputCharacters: 30,
        },
        execute: async () => ({
          value: 'second',
          status: 200,
        }),
      }),
    ).rejects.toBeInstanceOf(OpenRouterRateLimitError);
  });
});