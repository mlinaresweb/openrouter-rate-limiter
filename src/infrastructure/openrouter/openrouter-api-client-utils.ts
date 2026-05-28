import { OpenRouterRateLimiterError } from '../../core/errors/openrouter-rate-limiter-error.js';
import {
  classifyOpenRouterResponse,
  type OpenRouterHeadersLike,
} from './openrouter-response-parser.js';

export interface OpenRouterApiClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly userAgent?: string;
  readonly appName?: string;
  readonly referer?: string;
}

export interface ResolvedOpenRouterApiClientOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
  readonly userAgent: string | null;
  readonly appName: string | null;
  readonly referer: string | null;
}

export interface ExecuteOpenRouterApiGetJsonInput {
  readonly options: ResolvedOpenRouterApiClientOptions;
  readonly path: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
}

export async function executeOpenRouterApiGetJson(
  input: ExecuteOpenRouterApiGetJsonInput,
): Promise<unknown> {
const url = buildOpenRouterApiUrl({
  baseUrl: input.options.baseUrl,
  path: input.path,
  ...(input.query !== undefined
    ? { query: input.query }
    : {}),
});

  const response = await input.options.fetch(url, {
    method: 'GET',
    headers: buildOpenRouterApiHeaders(input.options),
  });

  const rawText = await response.text();

  const classification = classifyOpenRouterResponse({
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    headers: response.headers,
    rawText,
  });

  if (!classification.ok) {
    throw new OpenRouterRateLimiterError({
      code: input.errorCode,
      message: [
        input.errorMessage,
        `HTTP ${response.status.toString()} ${response.statusText}.`,
        classification.error?.message
          ? `OpenRouter: ${classification.error.message}`
          : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' '),
      cause: {
        url,
        status: response.status,
        statusText: response.statusText,
        category: classification.category,
        error: classification.error,
        rawTextPreview: rawText.slice(0, 2000),
      },
    });
  }

  return classification.rawJson;
}

export function resolveOpenRouterApiClientOptions(
  options: OpenRouterApiClientOptions,
): ResolvedOpenRouterApiClientOptions {
  if (options.apiKey.trim().length === 0) {
    throw new Error('openrouter-rate-limiter requires a non-empty apiKey.');
  }

  const fetchImplementation = options.fetch ?? globalThis.fetch;

  if (typeof fetchImplementation !== 'function') {
    throw new Error(
      'openrouter-rate-limiter requires a fetch implementation. Use Node.js >=20 or pass options.fetch.',
    );
  }

  return {
    apiKey: options.apiKey,
    baseUrl: normalizeBaseUrl(options.baseUrl ?? 'https://openrouter.ai/api/v1'),
    fetch: fetchImplementation,
    userAgent: normalizeOptionalHeaderValue(options.userAgent),
    appName: normalizeOptionalHeaderValue(options.appName),
    referer: normalizeOptionalHeaderValue(options.referer),
  };
}

export function getResponseHeaderValue(
  headers: OpenRouterHeadersLike,
  key: string,
): string | null {
  if (!headers) {
    return null;
  }

  if (headers instanceof Headers) {
    return headers.get(key);
  }

  const normalizedKey = key.toLowerCase();

  for (const [headerKey, headerValue] of Object.entries(headers)) {
    if (headerKey.toLowerCase() !== normalizedKey) {
      continue;
    }

    if (typeof headerValue === 'string') {
      return headerValue;
    }

    if (Array.isArray(headerValue)) {
      return headerValue.join(', ');
    }
  }

  return null;
}

function buildOpenRouterApiHeaders(
  options: ResolvedOpenRouterApiClientOptions,
): Headers {
  const headers = new Headers();

  headers.set('Authorization', `Bearer ${options.apiKey}`);
  headers.set('Accept', 'application/json');

  if (options.userAgent) {
    headers.set('User-Agent', options.userAgent);
  }

  if (options.referer) {
    headers.set('HTTP-Referer', options.referer);
  }

  if (options.appName) {
    headers.set('X-Title', options.appName);
  }

  return headers;
}

function buildOpenRouterApiUrl(params: {
  readonly baseUrl: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
}): string {
  const baseUrl = params.baseUrl.endsWith('/')
    ? params.baseUrl.slice(0, -1)
    : params.baseUrl;

  const path = params.path.startsWith('/')
    ? params.path
    : `/${params.path}`;

  const url = new URL(`${baseUrl}${path}`);

  if (params.query) {
    for (const [key, value] of Object.entries(params.query)) {
      if (value === null || value === undefined) {
        continue;
      }

      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error('OpenRouter baseUrl cannot be empty.');
  }

  return trimmed.endsWith('/')
    ? trimmed.slice(0, -1)
    : trimmed;
}

function normalizeOptionalHeaderValue(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}