import {
  OpenRouterRateLimiter,
} from './openrouter-rate-limiter.js';
import {
  createOpenRouterJsonHeaders,
  createOpenRouterRateLimitedFetch,
  type OpenRouterRateLimitedFetch,
  type OpenRouterRateLimitedFetchInit,
  type OpenRouterRateLimitedFetchMetadata,
} from './rate-limited-fetch.js';
import type { OpenRouterRateLimiterConfig } from '../core/domain/rate-limit-config.js';
import type {
  OpenRouterKeyInfoResult,
} from '../core/domain/openrouter-key-info.js';
import type {
  OpenRouterModelLookupResult,
  OpenRouterModelsListResult,
} from '../core/domain/openrouter-model-info.js';
import type {
  ListOpenRouterModelsOptions,
} from '../infrastructure/openrouter/openrouter-models-client.js';
import { OpenRouterRateLimiterError } from '../core/errors/openrouter-rate-limiter-error.js';

export type OpenRouterJsonObject = Readonly<Record<string, unknown>>;

export interface OpenRouterRateLimitedClientOptions
  extends Omit<OpenRouterRateLimiterConfig, 'store' | 'hooks' | 'models' | 'defaultPolicy'> {
  readonly limiter?: OpenRouterRateLimiter;
  readonly rateLimiter?: Omit<OpenRouterRateLimiterConfig, 'apiKey' | 'baseUrl' | 'defaultModel' | 'fetch' | 'appName' | 'referer' | 'userAgent'>;
}

export interface OpenRouterJsonRequestOptions {
  readonly headers?: HeadersInit;
  readonly openRouter?: OpenRouterRateLimitedFetchMetadata;
  readonly signal?: AbortSignal;
}

export interface OpenRouterChatCompletionsOptions extends OpenRouterJsonRequestOptions {}

export interface OpenRouterRateLimitedClient {
  readonly limiter: OpenRouterRateLimiter;
  readonly fetch: OpenRouterRateLimitedFetch;

  readonly requestJson: <TResponse = unknown>(
    pathOrUrl: string | URL,
    options?: OpenRouterRequestJsonOptions,
  ) => Promise<TResponse>;

  readonly postJson: <TResponse = unknown>(
    pathOrUrl: string | URL,
    body: unknown,
    options?: OpenRouterJsonRequestOptions,
  ) => Promise<TResponse>;

  readonly chatCompletions: <TResponse = unknown>(
    body: OpenRouterJsonObject,
    options?: OpenRouterChatCompletionsOptions,
  ) => Promise<TResponse>;

  readonly getCurrentKeyInfo: (
    options?: { readonly forceRefresh?: boolean },
  ) => Promise<OpenRouterKeyInfoResult>;

  readonly listModels: (
    options?: ListOpenRouterModelsOptions & { readonly forceRefresh?: boolean },
  ) => Promise<OpenRouterModelsListResult>;

  readonly getModelInfo: (
    modelId: string,
    options?: ListOpenRouterModelsOptions & { readonly forceRefresh?: boolean },
  ) => Promise<OpenRouterModelLookupResult>;

  readonly clearState: () => Promise<void>;
}

export interface OpenRouterRequestJsonOptions extends OpenRouterJsonRequestOptions {
  readonly method?: string;
  readonly body?: unknown;
}

export function createOpenRouterRateLimitedClient(
  options: OpenRouterRateLimitedClientOptions,
): OpenRouterRateLimitedClient {
  const limiter = options.limiter ?? createLimiterFromClientOptions(options);
  const config = limiter.getConfig();

const defaultModel = options.defaultModel ?? config.defaultModel;

const fetch = createOpenRouterRateLimitedFetch({
  limiter,
  ...(defaultModel !== null && defaultModel !== undefined
    ? { defaultModel }
    : {}),
  defaultHeaders: createOpenRouterJsonHeaders({
    apiKey: config.apiKey,
    appName: config.appName,
    referer: config.referer,
    userAgent: config.userAgent,
  }),
});

  async function requestJson<TResponse = unknown>(
    pathOrUrl: string | URL,
    requestOptions: OpenRouterRequestJsonOptions = {},
  ): Promise<TResponse> {
    const response = await fetch(buildClientUrl(config.baseUrl, pathOrUrl), {
      method: requestOptions.method ?? (requestOptions.body !== undefined ? 'POST' : 'GET'),
      ...(requestOptions.body !== undefined
        ? { body: JSON.stringify(requestOptions.body) }
        : {}),
      ...(requestOptions.headers !== undefined
        ? { headers: requestOptions.headers }
        : {}),
      ...(requestOptions.signal !== undefined
        ? { signal: requestOptions.signal }
        : {}),
      ...(requestOptions.openRouter !== undefined
        ? { openRouter: requestOptions.openRouter }
        : {}),
    });

    return parseJsonResponse<TResponse>(response);
  }

  async function postJson<TResponse = unknown>(
    pathOrUrl: string | URL,
    body: unknown,
    requestOptions: OpenRouterJsonRequestOptions = {},
  ): Promise<TResponse> {
    return requestJson<TResponse>(pathOrUrl, {
      method: 'POST',
      body,
      ...(requestOptions.headers !== undefined
        ? { headers: requestOptions.headers }
        : {}),
      ...(requestOptions.signal !== undefined
        ? { signal: requestOptions.signal }
        : {}),
      ...(requestOptions.openRouter !== undefined
        ? { openRouter: requestOptions.openRouter }
        : {}),
    });
  }

  async function chatCompletions<TResponse = unknown>(
    body: OpenRouterJsonObject,
    requestOptions: OpenRouterChatCompletionsOptions = {},
  ): Promise<TResponse> {
    const model =
      typeof body.model === 'string' && body.model.trim().length > 0
        ? body.model
        : config.defaultModel;

    return postJson<TResponse>('/chat/completions', body, {
      ...(requestOptions.headers !== undefined
        ? { headers: requestOptions.headers }
        : {}),
      ...(requestOptions.signal !== undefined
        ? { signal: requestOptions.signal }
        : {}),
      openRouter: {
        ...(requestOptions.openRouter ?? {}),
        ...(model !== null ? { model } : {}),
        operation: requestOptions.openRouter?.operation ?? 'chat.completions',
      },
    });
  }

  return {
    limiter,
    fetch,
    requestJson,
    postJson,
    chatCompletions,
    getCurrentKeyInfo: (keyOptions) => limiter.getCurrentKeyInfo(keyOptions),
    listModels: (modelsOptions) => limiter.listModels(modelsOptions),
    getModelInfo: (modelId, modelOptions) => limiter.getModelInfo(modelId, modelOptions),
    clearState: () => limiter.clearState(),
  };
}

function createLimiterFromClientOptions(
  options: OpenRouterRateLimitedClientOptions,
): OpenRouterRateLimiter {
  if (!options.apiKey || options.apiKey.trim().length === 0) {
    throw new Error(
      'createOpenRouterRateLimitedClient requires apiKey when limiter is not provided.',
    );
  }

  return new OpenRouterRateLimiter({
    apiKey: options.apiKey,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.defaultModel !== undefined ? { defaultModel: options.defaultModel } : {}),
    ...(options.appName !== undefined ? { appName: options.appName } : {}),
    ...(options.referer !== undefined ? { referer: options.referer } : {}),
    ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.inspectKeyBeforeRequest !== undefined
      ? { inspectKeyBeforeRequest: options.inspectKeyBeforeRequest }
      : {}),
    ...(options.loadModelsMetadata !== undefined
      ? { loadModelsMetadata: options.loadModelsMetadata }
      : {}),
    ...(options.modelsMetadataTtlMs !== undefined
      ? { modelsMetadataTtlMs: options.modelsMetadataTtlMs }
      : {}),
    ...(options.keyInfoTtlMs !== undefined ? { keyInfoTtlMs: options.keyInfoTtlMs } : {}),
    ...(options.clockMode !== undefined ? { clockMode: options.clockMode } : {}),
    ...(options.rateLimiter?.store !== undefined ? { store: options.rateLimiter.store } : {}),
    ...(options.rateLimiter?.hooks !== undefined ? { hooks: options.rateLimiter.hooks } : {}),
    ...(options.rateLimiter?.models !== undefined ? { models: options.rateLimiter.models } : {}),
    ...(options.rateLimiter?.defaultPolicy !== undefined
      ? { defaultPolicy: options.rateLimiter.defaultPolicy }
      : {}),
  });
}

function buildClientUrl(baseUrl: string, pathOrUrl: string | URL): string {
  const raw = String(pathOrUrl);

  if (/^https?:\/\//iu.test(raw)) {
    return raw;
  }

  const normalizedBase = baseUrl.endsWith('/')
    ? baseUrl.slice(0, -1)
    : baseUrl;

  const normalizedPath = raw.startsWith('/')
    ? raw
    : `/${raw}`;

  return `${normalizedBase}${normalizedPath}`;
}

async function parseJsonResponse<TResponse>(response: Response): Promise<TResponse> {
  const rawText = await response.text();

  if (!response.ok) {
    throw new OpenRouterRateLimiterError({
      code: 'OPENROUTER_CLIENT_REQUEST_FAILED',
      message: `OpenRouter request failed with HTTP ${response.status.toString()} ${response.statusText}.`,
      cause: {
        status: response.status,
        statusText: response.statusText,
        rawTextPreview: rawText.slice(0, 2000),
      },
    });
  }

  if (rawText.trim().length === 0) {
    return null as TResponse;
  }

  try {
    return JSON.parse(rawText) as TResponse;
  } catch (error) {
    throw new OpenRouterRateLimiterError({
      code: 'OPENROUTER_CLIENT_INVALID_JSON_RESPONSE',
      message: 'OpenRouter response was not valid JSON.',
      cause: {
        error,
        rawTextPreview: rawText.slice(0, 2000),
      },
    });
  }
}