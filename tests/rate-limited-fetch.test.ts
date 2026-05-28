import { describe, expect, it } from 'vitest';

import {
  OpenRouterRateLimitError,
  OpenRouterRateLimiter,
  createMemoryRateLimitStateStore,
  createOpenRouterRateLimitedFetch,
  type OpenRouterRateLimitedFetchInit,
} from '../src/index.js';

describe('openrouter-rate-limiter · rate-limited fetch', () => {
  it('extracts model from JSON body and returns the final Response', async () => {
    const calls: string[] = [];

    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
      store: createMemoryRateLimitStateStore(),
    });

    const rateLimitedFetch = createOpenRouterRateLimitedFetch({
      limiter,
      fetch: async (input, init) => {
        calls.push(String(input));

        expect(init).toBeDefined();
        expect(hasOpenRouterMetadata(init)).toBe(false);

        return new Response(
          JSON.stringify({
            ok: true,
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

    const response = await rateLimitedFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'qwen/qwen3.5-flash-02-23',
        messages: [
          {
            role: 'user',
            content: 'Hola',
          },
        ],
      }),
      openRouter: {
        operation: 'test-plan',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
    });
    expect(calls).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
  });

  it('uses init.openRouter.model when body does not contain a model', async () => {
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

    const rateLimitedFetch = createOpenRouterRateLimitedFetch({
      limiter,
      fetch: async () => {
        return new Response('ok', {
          status: 200,
        });
      },
    });

    await rateLimitedFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        messages: [],
      }),
      openRouter: {
        model: 'openai/gpt-4o-mini',
      },
    });

    await expect(
      rateLimitedFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          messages: [],
        }),
        openRouter: {
          model: 'openai/gpt-4o-mini',
        },
      }),
    ).rejects.toBeInstanceOf(OpenRouterRateLimitError);
  });

  it('uses defaultModel when neither metadata nor body contains model', async () => {
    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
      defaultModel: 'openai/gpt-4o-mini',
    });

    const rateLimitedFetch = createOpenRouterRateLimitedFetch({
      limiter,
      fetch: async () => {
        return new Response('ok', {
          status: 200,
        });
      },
    });

    const response = await rateLimitedFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        messages: [],
      }),
    });

    expect(response.status).toBe(200);
  });

  it('throws when no model can be resolved', async () => {
    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
    });

    const rateLimitedFetch = createOpenRouterRateLimitedFetch({
      limiter,
      fetch: async () => {
        return new Response('never', {
          status: 200,
        });
      },
    });

    await expect(
      rateLimitedFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          messages: [],
        }),
      }),
    ).rejects.toThrow('could not resolve the OpenRouter model');
  });

  it('retries after a 429 Response and then returns success', async () => {
    let calls = 0;
    const retryAttempts: number[] = [];

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
          retryAttempts.push(event.attempt);
        },
      },
    });

    const rateLimitedFetch = createOpenRouterRateLimitedFetch({
      limiter,
      fetch: async () => {
        calls += 1;

        if (calls === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message: 'Provider returned error',
                code: 429,
              },
            }),
            {
              status: 429,
              statusText: 'Too Many Requests',
              headers: {
                'Retry-After': '0',
                'Content-Type': 'application/json',
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            ok: true,
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

    const response = await rateLimitedFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'qwen/qwen3.5-flash-02-23',
        messages: [],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
    });
    expect(calls).toBe(2);
    expect(retryAttempts).toEqual([1]);
  });

  it('extracts model from a Request body using clone()', async () => {
    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
    });

    const rateLimitedFetch = createOpenRouterRateLimitedFetch({
      limiter,
      fetch: async (input) => {
        expect(input).toBeInstanceOf(Request);

        return new Response('ok', {
          status: 200,
        });
      },
    });

    const request = new Request('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'anthropic/claude-3.5-haiku',
        messages: [],
      }),
    });

    const response = await rateLimitedFetch(request);

    expect(response.status).toBe(200);
  });

  it('uses a custom input character estimator', async () => {
    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
      models: {
        'openai/gpt-4o-mini': {
          inputCharactersPerWindow: 10,
          windowMs: 60_000,
        },
      },
      defaultPolicy: {
        mode: 'fail_fast',
      },
    });

    const rateLimitedFetch = createOpenRouterRateLimitedFetch({
      limiter,
      estimateInputCharacters: async () => 8,
      fetch: async () => {
        return new Response('ok', {
          status: 200,
        });
      },
    });

    await rateLimitedFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [],
      }),
    });

    await expect(
      rateLimitedFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'openai/gpt-4o-mini',
          messages: [],
        }),
      }),
    ).rejects.toBeInstanceOf(OpenRouterRateLimitError);
  });

  it('supports explicit metadata without leaking it to fetch init', async () => {
    let receivedInit: RequestInit | undefined;

    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
    });

    const rateLimitedFetch = createOpenRouterRateLimitedFetch({
      limiter,
      fetch: async (_input, init) => {
        receivedInit = init;

        return new Response('ok', {
          status: 200,
        });
      },
    });

    const init: OpenRouterRateLimitedFetchInit = {
      method: 'POST',
      body: JSON.stringify({
        messages: [],
      }),
      openRouter: {
        model: 'openai/gpt-4o-mini',
        operation: 'explicit-operation',
        requestId: 'request-1',
        estimatedInputCharacters: 20,
        maxRetries: 1,
      },
    };

    const response = await rateLimitedFetch(
      'https://openrouter.ai/api/v1/chat/completions',
      init,
    );

    expect(response.status).toBe(200);
    expect(hasOpenRouterMetadata(receivedInit)).toBe(false);
  });
});

function hasOpenRouterMetadata(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'openRouter' in value
  );
}