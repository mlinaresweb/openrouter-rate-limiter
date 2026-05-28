import { describe, expect, it } from 'vitest';

import {
  OpenRouterKeyClient,
  OpenRouterModelsClient,
  parseOpenRouterKeyInfoResponse,
  parseOpenRouterModelsResponse,
} from '../src/index.js';

describe('openrouter-rate-limiter · OpenRouter clients', () => {
  it('parses current key information', () => {
    const keyInfo = parseOpenRouterKeyInfoResponse({
      data: {
        label: 'sk-or-v1-test',
        name: 'Test Key',
        hash: 'abc123',
        usage: 25.5,
        usage_daily: 2,
        usage_weekly: 10,
        usage_monthly: 25.5,
        byok_usage: 1,
        byok_usage_daily: 0.1,
        byok_usage_weekly: 0.5,
        byok_usage_monthly: 1,
        limit: 100,
        limit_remaining: 74.5,
        limit_reset: 'monthly',
        include_byok_in_limit: false,
        disabled: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        expires_at: null,
        workspace_id: 'workspace-id',
        creator_user_id: 'user-id',
        is_free_tier: false,
      },
    });

    expect(keyInfo.label).toBe('sk-or-v1-test');
    expect(keyInfo.name).toBe('Test Key');
    expect(keyInfo.limit).toBe(100);
    expect(keyInfo.limitRemaining).toBe(74.5);
    expect(keyInfo.limitReset).toBe('monthly');
    expect(keyInfo.disabled).toBe(false);
    expect(keyInfo.expiresAt).toBeNull();
  });

  it('parses models response', () => {
    const models = parseOpenRouterModelsResponse({
      data: [
        {
          id: 'openai/gpt-4o-mini',
          name: 'GPT-4o Mini',
          created: 1710000000,
          description: 'Small model',
          context_length: 128000,
          architecture: {
            modality: 'text->text',
            input_modalities: ['text'],
            output_modalities: ['text'],
            tokenizer: 'GPT',
            instruct_type: null,
          },
          pricing: {
            prompt: '0.00000015',
            completion: '0.0000006',
            image: '0',
            request: '0',
          },
          top_provider: {
            context_length: 128000,
            max_completion_tokens: 16384,
            is_moderated: true,
          },
          per_request_limits: {
            prompt_tokens: 100000,
            completion_tokens: 16000,
          },
          supported_parameters: ['tools', 'structured_outputs'],
          default_parameters: null,
          links: {
            details: '/api/v1/models/openai/gpt-4o-mini/endpoints',
          },
        },
      ],
    });

    const model = models[0];

    expect(model?.id).toBe('openai/gpt-4o-mini');
    expect(model?.contextLength).toBe(128000);
    expect(model?.pricing?.prompt).toBe('0.00000015');
    expect(model?.topProvider?.maxCompletionTokens).toBe(16384);
    expect(model?.perRequestLimits?.promptTokens).toBe(100000);
    expect(model?.supportedParameters).toContain('structured_outputs');
    expect(model?.links?.details).toContain('/api/v1/models/openai/gpt-4o-mini/endpoints');
  });

  it('loads current key info through fetch', async () => {
    const fetchCalls: string[] = [];

    const client = new OpenRouterKeyClient({
      apiKey: 'sk-or-test',
      fetch: async (input, init) => {
        fetchCalls.push(String(input));

        expect(init?.method).toBe('GET');
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-or-test');

        return jsonResponse({
          data: {
            label: 'sk-or-v1-test',
            usage: 1,
            limit: 10,
            limit_remaining: 9,
            limit_reset: 'daily',
          },
        });
      },
    });

    const result = await client.getCurrentKeyInfo();

    expect(fetchCalls[0]).toBe('https://openrouter.ai/api/v1/key');
    expect(result.keyInfo.label).toBe('sk-or-v1-test');
    expect(result.keyInfo.limitRemaining).toBe(9);
    expect(result.checkedAtMs).toBeGreaterThan(0);
  });

  it('loads models through fetch with query filters', async () => {
    const fetchCalls: string[] = [];

    const client = new OpenRouterModelsClient({
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1/',
      appName: 'Test App',
      referer: 'https://example.com',
      fetch: async (input, init) => {
        fetchCalls.push(String(input));

        const headers = new Headers(init?.headers);

        expect(headers.get('Authorization')).toBe('Bearer sk-or-test');
        expect(headers.get('X-Title')).toBe('Test App');
        expect(headers.get('HTTP-Referer')).toBe('https://example.com');

        return jsonResponse({
          data: [
            {
              id: 'qwen/qwen3.5-flash-02-23',
              name: 'Qwen Flash',
              context_length: 1000000,
              pricing: {
                prompt: '0',
                completion: '0',
              },
              per_request_limits: null,
              supported_parameters: ['structured_outputs'],
            },
          ],
        });
      },
    });

    const result = await client.listModels({
      supportedParameters: ['structured_outputs'],
      modality: 'text',
    });

    expect(fetchCalls[0]).toBe(
      'https://openrouter.ai/api/v1/models?supported_parameters=structured_outputs&modality=text',
    );
    expect(result.models[0]?.id).toBe('qwen/qwen3.5-flash-02-23');
    expect(result.models[0]?.contextLength).toBe(1000000);
  });

  it('gets one model by id', async () => {
    const client = new OpenRouterModelsClient({
      apiKey: 'sk-or-test',
      fetch: async () => {
        return jsonResponse({
          data: [
            {
              id: 'openai/gpt-4o-mini',
              name: 'GPT-4o Mini',
            },
            {
              id: 'anthropic/claude-3.5-haiku',
              name: 'Claude Haiku',
            },
          ],
        });
      },
    });

    const found = await client.getModel('anthropic/claude-3.5-haiku');
    const missing = await client.getModel('missing/model');

    expect(found.model?.name).toBe('Claude Haiku');
    expect(missing.model).toBeNull();
  });

  it('throws a typed error when OpenRouter API fails', async () => {
    const client = new OpenRouterKeyClient({
      apiKey: 'sk-or-test',
      fetch: async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: 'Invalid API key',
              code: 401,
            },
          }),
          {
            status: 401,
            statusText: 'Unauthorized',
            headers: {
              'Content-Type': 'application/json',
            },
          },
        );
      },
    });

    await expect(client.getCurrentKeyInfo()).rejects.toMatchObject({
      code: 'OPENROUTER_KEY_INFO_REQUEST_FAILED',
    });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    statusText: 'OK',
    headers: {
      'Content-Type': 'application/json',
    },
  });
}