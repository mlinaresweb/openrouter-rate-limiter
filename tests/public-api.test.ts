import { describe, expect, it } from 'vitest';

import {
  OpenRouterRateLimiter,
  type OpenRouterRateLimiterConfig,
} from '../src/index.js';

describe('openrouter-rate-limiter · public API', () => {
  it('creates a limiter with API configuration', () => {
    const config: OpenRouterRateLimiterConfig = {
      apiKey: 'sk-or-test',
      defaultModel: 'qwen/qwen3.5-flash-02-23',
      defaultPolicy: {
        mode: 'wait',
        maxRetries: 3,
      },
      models: {
        'qwen/qwen3.5-flash-02-23': {
          minIntervalMs: 15_000,
          maxConcurrentRequests: 1,
        },
      },
    };

    const limiter = new OpenRouterRateLimiter(config);

    expect(limiter.getConfig().apiKey).toBe('sk-or-test');
    expect(limiter.getConfig().defaultModel).toBe('qwen/qwen3.5-flash-02-23');
    expect(limiter.getConfig().defaultPolicy.mode).toBe('wait');
    expect(limiter.getConfig().defaultPolicy.maxRetries).toBe(3);
  });

  it('executes a request through the initial pass-through implementation', async () => {
    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
    });

    const result = await limiter.execute({
      metadata: {
        model: 'openai/gpt-4o-mini',
        operation: 'test',
      },
      execute: async () => {
        return {
          value: {
            ok: true,
          },
          status: 200,
        };
      },
    });

    expect(result.value.ok).toBe(true);
    expect(result.status).toBe(200);
  });
});