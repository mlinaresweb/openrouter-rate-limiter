import { describe, expect, it } from 'vitest';

import {
  OpenRouterRateLimitError,
  OpenRouterRateLimiter,
  createOpenRouterRateLimitedClient,
  createOpenRouterRateLimitedFetch,
} from '../src/index.js';

describe('openrouter-rate-limiter · hardening', () => {
  it('enforces global requestsPerWindow in fail_fast mode', async () => {
    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
      global: {
        requestsPerWindow: 1,
        windowMs: 60_000,
      },
      defaultPolicy: {
        mode: 'fail_fast',
      },
    });

    await limiter.execute({
      metadata: {
        model: 'openai/gpt-4o-mini',
        estimatedInputCharacters: 10,
      },
      execute: async () => ({
        value: 'first',
        status: 200,
      }),
    });

    await expect(
      limiter.execute({
        metadata: {
          model: 'anthropic/claude-3.5-haiku',
          estimatedInputCharacters: 10,
        },
        execute: async () => ({
          value: 'second',
          status: 200,
        }),
      }),
    ).rejects.toBeInstanceOf(OpenRouterRateLimitError);
  });

  it('inspects availability before executing', async () => {
    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
      defaultModel: 'openai/gpt-4o-mini',
      global: {
        requestsPerWindow: 1,
        windowMs: 60_000,
      },
      defaultPolicy: {
        mode: 'fail_fast',
      },
    });

    const before = await limiter.inspectAvailability({
      estimatedInputCharacters: 10,
    });

    expect(before.canRunNow).toBe(true);
    expect(before.waitMs).toBe(0);
    expect(before.constraints).toHaveLength(0);

    await limiter.execute({
      metadata: {
        model: 'openai/gpt-4o-mini',
        estimatedInputCharacters: 10,
      },
      execute: async () => ({
        value: 'first',
        status: 200,
      }),
    });

    const after = await limiter.inspectAvailability({
      estimatedInputCharacters: 10,
    });

    expect(after.canRunNow).toBe(false);
    expect(after.waitMs).toBeGreaterThan(0);
    expect(after.reason).toBe('manual_policy');
    expect(after.constraints.some((item) => item.scope === 'global')).toBe(true);
  });

  it('supports requestTimeoutMs in rate-limited fetch', async () => {
    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
      defaultModel: 'openai/gpt-4o-mini',
      defaultPolicy: {
        mode: 'fail_fast',
        retryOnTimeout: false,
      },
    });

    const openRouterFetch = createOpenRouterRateLimitedFetch({
      limiter,
      requestTimeoutMs: 5,
      fetch: async (_input, init) => {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(resolve, 50);

          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(createAbortError('aborted'));
          });
        });

        return new Response('never', {
          status: 200,
        });
      },
    });

    await expect(
      openRouterFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'openai/gpt-4o-mini',
          messages: [],
        }),
      }),
    ).rejects.toThrow('aborted');
  });

  it('passes requestTimeoutMs from high-level client', async () => {
    const client = createOpenRouterRateLimitedClient({
      apiKey: 'sk-or-test',
      defaultModel: 'openai/gpt-4o-mini',
      requestTimeoutMs: 5,
      rateLimiter: {
        defaultPolicy: {
          mode: 'fail_fast',
          retryOnTimeout: false,
        },
      },
      fetch: async (_input, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);

        return new Response(
          JSON.stringify({
            id: 'ok',
            choices: [],
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          },
        );
      },
    });

    const result = await client.chatCompletions<{
      readonly id: string;
    }>({
      model: 'openai/gpt-4o-mini',
      messages: [],
    });

    expect(result.id).toBe('ok');
  });
});

function createAbortError(message: string): Error {
  const error = new Error(message);

  error.name = 'AbortError';

  return error;
}