import { describe, expect, it } from 'vitest';

import {
  classifyOpenRouterErrorCategory,
  classifyOpenRouterResponse,
  extractOpenRouterRequestModelFromBody,
  getHeaderValue,
  isOpenRouterRetryableStatus,
  parseOpenRouterResponseJson,
  parseRetryAfterFromHeaders,
  parseRetryAfterHeader,
} from '../src/index.js';

describe('openrouter-rate-limiter · OpenRouter response parser', () => {
  it('parses Retry-After seconds', () => {
    expect(parseRetryAfterHeader('45')).toBe(45_000);
    expect(parseRetryAfterHeader('0')).toBe(0);
  });

  it('parses Retry-After HTTP date', () => {
    const nowMs = Date.UTC(2026, 0, 1, 10, 0, 0);
    const retryDate = new Date(nowMs + 30_000).toUTCString();

    expect(parseRetryAfterHeader(retryDate, nowMs)).toBe(30_000);
  });

  it('returns null for invalid Retry-After values', () => {
    expect(parseRetryAfterHeader(null)).toBeNull();
    expect(parseRetryAfterHeader(undefined)).toBeNull();
    expect(parseRetryAfterHeader('')).toBeNull();
    expect(parseRetryAfterHeader('not-a-date')).toBeNull();
  });

  it('reads headers from Headers objects', () => {
    const headers = new Headers({
      'Retry-After': '12',
    });

    expect(getHeaderValue(headers, 'retry-after')).toBe('12');

    const parsed = parseRetryAfterFromHeaders(headers);

    expect(parsed.retryAfterMs).toBe(12_000);
    expect(parsed.rawRetryAfter).toBe('12');
  });

  it('reads headers from plain records', () => {
    const headers = {
      'retry-after': '7',
    };

    expect(getHeaderValue(headers, 'Retry-After')).toBe('7');
    expect(parseRetryAfterFromHeaders(headers).retryAfterMs).toBe(7_000);
  });

  it('parses JSON safely', () => {
    expect(parseOpenRouterResponseJson('{"ok":true}')).toEqual({ ok: true });
    expect(parseOpenRouterResponseJson('not-json')).toBeNull();
    expect(parseOpenRouterResponseJson('')).toBeNull();
  });

  it('classifies a successful response', () => {
    const result = classifyOpenRouterResponse({
      status: 200,
      statusText: 'OK',
      rawText: JSON.stringify({
        id: 'generation-id',
        choices: [],
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.category).toBe('success');
    expect(result.error).toBeNull();
    expect(result.isRetryable).toBe(false);
  });

  it('classifies 429 as rate limit with Retry-After', () => {
    const result = classifyOpenRouterResponse({
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers({
        'Retry-After': '60',
      }),
      rawText: JSON.stringify({
        error: {
          message: 'Provider returned error',
          code: 429,
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.category).toBe('rate_limit');
    expect(result.isRetryable).toBe(true);
    expect(result.retryAfterMs).toBe(60_000);
    expect(result.error?.isRateLimited).toBe(true);
    expect(result.error?.code).toBe(429);
  });

  it('classifies 402 as credit limit', () => {
    const result = classifyOpenRouterResponse({
      status: 402,
      statusText: 'Payment Required',
      rawText: JSON.stringify({
        error: {
          message: 'Insufficient credits',
          code: 402,
        },
      }),
    });

    expect(result.category).toBe('credit_limit');
    expect(result.isRetryable).toBe(false);
    expect(result.error?.isCreditLimited).toBe(true);
  });

  it('classifies provider failures as retryable', () => {
    const result = classifyOpenRouterResponse({
      status: 503,
      statusText: 'Service Unavailable',
      rawText: JSON.stringify({
        error: {
          message: 'Provider returned error',
          type: 'provider_error',
        },
      }),
    });

    expect(result.category).toBe('provider_unavailable');
    expect(result.isRetryable).toBe(true);
  });

  it('classifies malformed non-json error responses', () => {
    const result = classifyOpenRouterResponse({
      status: 500,
      statusText: 'Internal Server Error',
      rawText: '<html>bad gateway</html>',
    });

    expect(result.ok).toBe(false);
    expect(result.category).toBe('server_error');
    expect(result.error?.message).toBe('Internal Server Error');
    expect(result.error?.rawJson).toBeNull();
  });

  it('classifies categories directly', () => {
    expect(
      classifyOpenRouterErrorCategory({
        status: 429,
        code: null,
        message: '',
        type: null,
      }),
    ).toBe('rate_limit');

    expect(
      classifyOpenRouterErrorCategory({
        status: 401,
        code: null,
        message: '',
        type: null,
      }),
    ).toBe('authentication');

    expect(
      classifyOpenRouterErrorCategory({
        status: 403,
        code: null,
        message: '',
        type: null,
      }),
    ).toBe('authorization');
  });

  it('detects retryable HTTP statuses', () => {
    expect(isOpenRouterRetryableStatus(429)).toBe(true);
    expect(isOpenRouterRetryableStatus(503)).toBe(true);
    expect(isOpenRouterRetryableStatus(402)).toBe(false);
    expect(isOpenRouterRetryableStatus(400)).toBe(false);
  });

  it('extracts model from JSON request body', () => {
    const result = extractOpenRouterRequestModelFromBody(
      JSON.stringify({
        model: 'qwen/qwen3.5-flash-02-23',
        messages: [],
      }),
    );

    expect(result.model).toBe('qwen/qwen3.5-flash-02-23');
    expect(result.fallbackModels).toEqual([]);
  });

  it('extracts primary and fallback models from models array', () => {
    const result = extractOpenRouterRequestModelFromBody({
      models: [
        'openai/gpt-4o-mini',
        'anthropic/claude-3.5-haiku',
        'google/gemini-flash-1.5',
      ],
    });

    expect(result.model).toBe('openai/gpt-4o-mini');
    expect(result.fallbackModels).toEqual([
      'anthropic/claude-3.5-haiku',
      'google/gemini-flash-1.5',
    ]);
  });

  it('extracts model from URLSearchParams', () => {
    const params = new URLSearchParams();

    params.set('model', 'openai/gpt-4o-mini');

    const result = extractOpenRouterRequestModelFromBody(params);

    expect(result.model).toBe('openai/gpt-4o-mini');
  });
});