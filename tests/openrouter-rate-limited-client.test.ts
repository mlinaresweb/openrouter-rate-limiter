import { describe, expect, it } from 'vitest';

import {
  createOpenRouterRateLimitedClient,
} from '../src/index.js';

describe('openrouter-rate-limiter · rate-limited client', () => {
  it('creates a high-level client and calls chat completions', async () => {
    const calls: Array<{
      readonly url: string;
      readonly headers: Headers;
      readonly body: unknown;
    }> = [];

    const client = createOpenRouterRateLimitedClient({
      apiKey: 'sk-or-test',
      defaultModel: 'openai/gpt-4o-mini',
      appName: 'Test App',
      referer: 'https://example.com',
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)) as unknown,
        });

        return new Response(
          JSON.stringify({
            id: 'chatcmpl-test',
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
      readonly choices: readonly unknown[];
    }>({
      model: 'openai/gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: 'Hola',
        },
      ],
    });

    expect(result.id).toBe('chatcmpl-test');
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer sk-or-test');
    expect(calls[0]?.headers.get('X-Title')).toBe('Test App');
    expect(calls[0]?.headers.get('HTTP-Referer')).toBe('https://example.com');
  });

  it('supports requestJson and postJson helpers', async () => {
    const urls: string[] = [];

    const client = createOpenRouterRateLimitedClient({
      apiKey: 'sk-or-test',
      defaultModel: 'openai/gpt-4o-mini',
      fetch: async (input) => {
        urls.push(String(input));

        return new Response(
          JSON.stringify({
            ok: true,
          }),
          {
            status: 200,
          },
        );
      },
    });

    const getResult = await client.requestJson<{ readonly ok: boolean }>('/models');
    const postResult = await client.postJson<{ readonly ok: boolean }>(
      '/chat/completions',
      {
        model: 'openai/gpt-4o-mini',
        messages: [],
      },
    );

    expect(getResult.ok).toBe(true);
    expect(postResult.ok).toBe(true);
    expect(urls).toEqual([
      'https://openrouter.ai/api/v1/models',
      'https://openrouter.ai/api/v1/chat/completions',
    ]);
  });

  it('exposes cached key and model metadata through the limiter', async () => {
    let keyCalls = 0;
    let modelsCalls = 0;

    const client = createOpenRouterRateLimitedClient({
      apiKey: 'sk-or-test',
      fetch: async (input) => {
        const url = String(input);

        if (url.endsWith('/key')) {
          keyCalls += 1;

          return new Response(
            JSON.stringify({
              data: {
                label: 'test-key',
                usage: 1,
                limit: 10,
                limit_remaining: 9,
                limit_reset: 'daily',
              },
            }),
            {
              status: 200,
            },
          );
        }

        if (url.endsWith('/models')) {
          modelsCalls += 1;

          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'openai/gpt-4o-mini',
                  name: 'GPT-4o Mini',
                  context_length: 128000,
                },
              ],
            }),
            {
              status: 200,
            },
          );
        }

        return new Response('{}', {
          status: 200,
        });
      },
    });

    const keyInfo1 = await client.getCurrentKeyInfo();
    const keyInfo2 = await client.getCurrentKeyInfo();

    const models1 = await client.listModels();
    const models2 = await client.listModels();

    const model = await client.getModelInfo('openai/gpt-4o-mini');

    expect(keyInfo1.keyInfo.label).toBe('test-key');
    expect(keyInfo2.keyInfo.limitRemaining).toBe(9);
    expect(models1.models).toHaveLength(1);
    expect(models2.models[0]?.id).toBe('openai/gpt-4o-mini');
    expect(model.model?.contextLength).toBe(128000);

    expect(keyCalls).toBe(1);
    expect(modelsCalls).toBe(1);
  });

  it('can force refresh metadata caches', async () => {
    let keyCalls = 0;

    const client = createOpenRouterRateLimitedClient({
      apiKey: 'sk-or-test',
      fetch: async (input) => {
        if (String(input).endsWith('/key')) {
          keyCalls += 1;

          return new Response(
            JSON.stringify({
              data: {
                label: `key-${keyCalls.toString()}`,
              },
            }),
            {
              status: 200,
            },
          );
        }

        return new Response('{}', {
          status: 200,
        });
      },
    });

    const first = await client.getCurrentKeyInfo();
    const second = await client.getCurrentKeyInfo({
      forceRefresh: true,
    });

    expect(first.keyInfo.label).toBe('key-1');
    expect(second.keyInfo.label).toBe('key-2');
    expect(keyCalls).toBe(2);
  });
});