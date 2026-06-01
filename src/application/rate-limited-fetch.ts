import type { OpenRouterRateLimiter } from './openrouter-rate-limiter.js';
import type { OpenRouterRequestMetadata } from '../core/domain/openrouter-request.js';
import { extractOpenRouterRequestModelFromBody } from '../infrastructure/openrouter/openrouter-response-parser.js';

export interface OpenRouterRateLimitedFetchMetadata {
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
  readonly estimatedInputCharacters?: number;
  readonly estimatedOutputTokens?: number;
  readonly operation?: string;
  readonly requestId?: string;
  readonly allowWaiting?: boolean;
  readonly maxRetries?: number;
  readonly signal?: AbortSignal;
}

export interface OpenRouterRateLimitedFetchInit extends RequestInit {
  readonly openRouter?: OpenRouterRateLimitedFetchMetadata;
}

export type OpenRouterRateLimitedFetchInput = RequestInfo | URL;

export type OpenRouterRateLimitedFetch = (
  input: OpenRouterRateLimitedFetchInput,
  init?: OpenRouterRateLimitedFetchInit,
) => Promise<Response>;

export interface EstimateOpenRouterInputCharactersInput {
  readonly input: OpenRouterRateLimitedFetchInput;
  readonly init: OpenRouterRateLimitedFetchInit | undefined;
  readonly bodyText: string | null;
  readonly parsedBody: unknown;
}

export interface CreateOpenRouterRateLimitedFetchOptions {
  readonly limiter: OpenRouterRateLimiter;
  readonly fetch?: typeof fetch;
  readonly defaultModel?: string;
  readonly defaultOperation?: string;
  readonly defaultHeaders?: HeadersInit;
  readonly requestTimeoutMs?: number;
  readonly estimateInputCharacters?: (
    input: EstimateOpenRouterInputCharactersInput,
  ) => number | Promise<number>;
  readonly inspectRequestBody?: boolean;
}

interface BuiltFetchMetadata {
  readonly metadata: OpenRouterRequestMetadata;
  readonly fetchInit: RequestInit | undefined;
}

interface TimeoutFetchInit {
  readonly init: RequestInit | undefined;
  readonly cleanup: () => void;
}

export function createOpenRouterRateLimitedFetch(
  options: CreateOpenRouterRateLimitedFetchOptions,
): OpenRouterRateLimitedFetch {
  const fetchImplementation = options.fetch ?? options.limiter.getConfig().fetch;

  return async function openRouterRateLimitedFetch(
    input: OpenRouterRateLimitedFetchInput,
    init?: OpenRouterRateLimitedFetchInit,
  ): Promise<Response> {
    const built = await buildFetchMetadata({
      input,
      init,
      options,
    });

    const result = await options.limiter.execute<Response>({
      metadata: built.metadata,
      execute: async () => {
        const timeoutInit = createTimeoutFetchInit({
          init: built.fetchInit,
          requestTimeoutMs: options.requestTimeoutMs,
        });

        try {
          const response = await fetchImplementation(input, timeoutInit.init);

          return {
            value: response,
            status: response.status,
            headers: response.headers,
          };
        } finally {
          timeoutInit.cleanup();
        }
      },
    });

    return result.value;
  };
}

export function withOpenRouterMetadata(
  init: RequestInit | undefined,
  metadata: OpenRouterRateLimitedFetchMetadata,
): OpenRouterRateLimitedFetchInit {
  return {
    ...(init ?? {}),
    openRouter: metadata,
  };
}

export function createOpenRouterJsonHeaders(params: {
  readonly apiKey: string;
  readonly appName?: string | null;
  readonly referer?: string | null;
  readonly userAgent?: string | null;
  readonly extraHeaders?: HeadersInit;
}): Headers {
  const headers = new Headers();

  headers.set('Authorization', `Bearer ${params.apiKey}`);
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');

  if (params.appName) {
    headers.set('X-Title', params.appName);
  }

  if (params.referer) {
    headers.set('HTTP-Referer', params.referer);
  }

  if (params.userAgent) {
    headers.set('User-Agent', params.userAgent);
  }

  copyHeaders({
    target: headers,
    source: params.extraHeaders,
  });

  return headers;
}

async function buildFetchMetadata(params: {
  readonly input: OpenRouterRateLimitedFetchInput;
  readonly init: OpenRouterRateLimitedFetchInit | undefined;
  readonly options: CreateOpenRouterRateLimitedFetchOptions;
}): Promise<BuiltFetchMetadata> {
  const fetchInit = stripOpenRouterMetadata({
    init: params.init,
    defaultHeaders: params.options.defaultHeaders,
  });

  const bodyText = await readRequestBodyTextForInspection({
    input: params.input,
    init: params.init,
    inspectRequestBody: params.options.inspectRequestBody ?? true,
  });

  const parsedBody = parseJsonBodyText(bodyText);
  const extracted = extractOpenRouterRequestModelFromBody(bodyText ?? parsedBody);

  const configuredDefaultModel =
    params.options.defaultModel ??
    params.options.limiter.getConfig().defaultModel ??
    undefined;

  const model =
    params.init?.openRouter?.model ??
    extracted.model ??
    configuredDefaultModel;

  if (!model) {
    throw new Error(
      [
        'openrouter-rate-limiter could not resolve the OpenRouter model.',
        'Provide init.openRouter.model, include model in the JSON body, or configure defaultModel.',
      ].join(' '),
    );
  }

  const estimatedInputCharacters =
    params.init?.openRouter?.estimatedInputCharacters ??
    await estimateInputCharacters({
      input: params.input,
      init: params.init,
      bodyText,
      parsedBody,
      estimator: params.options.estimateInputCharacters,
    });

  const fallbackModels =
    params.init?.openRouter?.fallbackModels ??
    extracted.fallbackModels;

  const signal =
    params.init?.openRouter?.signal ??
    (params.init?.signal instanceof AbortSignal ? params.init.signal : undefined);

  const metadata: OpenRouterRequestMetadata = {
    model,
    ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
    ...(estimatedInputCharacters !== null ? { estimatedInputCharacters } : {}),
    ...(params.init?.openRouter?.estimatedOutputTokens !== undefined
      ? { estimatedOutputTokens: params.init.openRouter.estimatedOutputTokens }
      : {}),
    ...(params.init?.openRouter?.operation !== undefined
      ? { operation: params.init.openRouter.operation }
      : params.options.defaultOperation !== undefined
        ? { operation: params.options.defaultOperation }
        : {}),
    ...(params.init?.openRouter?.requestId !== undefined
      ? { requestId: params.init.openRouter.requestId }
      : {}),
    ...(params.init?.openRouter?.allowWaiting !== undefined
      ? { allowWaiting: params.init.openRouter.allowWaiting }
      : {}),
    ...(params.init?.openRouter?.maxRetries !== undefined
      ? { maxRetries: params.init.openRouter.maxRetries }
      : {}),
    ...(signal !== undefined ? { signal } : {}),
  };

  return {
    metadata,
    fetchInit,
  };
}

function stripOpenRouterMetadata(params: {
  readonly init: OpenRouterRateLimitedFetchInit | undefined;
  readonly defaultHeaders: HeadersInit | undefined;
}): RequestInit | undefined {
  if (params.init === undefined && params.defaultHeaders === undefined) {
    return undefined;
  }

  const {
    openRouter: _openRouter,
    headers: requestHeaders,
    ...rest
  } = params.init ?? {};

  const mergedHeaders = mergeHeaders({
    defaultHeaders: params.defaultHeaders,
    requestHeaders,
  });

  return {
    ...rest,
    ...(mergedHeaders !== undefined ? { headers: mergedHeaders } : {}),
  };
}

function mergeHeaders(params: {
  readonly defaultHeaders: HeadersInit | undefined;
  readonly requestHeaders: HeadersInit | undefined;
}): Headers | undefined {
  if (params.defaultHeaders === undefined && params.requestHeaders === undefined) {
    return undefined;
  }

  const headers = new Headers();

  copyHeaders({
    target: headers,
    source: params.defaultHeaders,
  });

  copyHeaders({
    target: headers,
    source: params.requestHeaders,
  });

  return headers;
}

function copyHeaders(params: {
  readonly target: Headers;
  readonly source: HeadersInit | undefined;
}): void {
  if (params.source === undefined) {
    return;
  }

  if (params.source instanceof Headers) {
    params.source.forEach((value, key) => {
      params.target.set(key, value);
    });

    return;
  }

  if (Array.isArray(params.source)) {
    for (const [key, value] of params.source) {
      params.target.set(key, value);
    }

    return;
  }

  for (const [key, value] of Object.entries(params.source)) {
    params.target.set(key, value);
  }
}

async function estimateInputCharacters(params: {
  readonly input: OpenRouterRateLimitedFetchInput;
  readonly init: OpenRouterRateLimitedFetchInit | undefined;
  readonly bodyText: string | null;
  readonly parsedBody: unknown;
  readonly estimator:
    | CreateOpenRouterRateLimitedFetchOptions['estimateInputCharacters']
    | undefined;
}): Promise<number | null> {
  if (params.estimator) {
    const estimated = await params.estimator({
      input: params.input,
      init: params.init,
      bodyText: params.bodyText,
      parsedBody: params.parsedBody,
    });

    return Number.isFinite(estimated) && estimated >= 0
      ? Math.round(estimated)
      : null;
  }

  if (params.bodyText !== null) {
    return params.bodyText.length;
  }

  return null;
}

async function readRequestBodyTextForInspection(params: {
  readonly input: OpenRouterRateLimitedFetchInput;
  readonly init: OpenRouterRateLimitedFetchInit | undefined;
  readonly inspectRequestBody: boolean;
}): Promise<string | null> {
  if (params.init?.body !== undefined && params.init.body !== null) {
    return bodyInitToText(params.init.body);
  }

  if (!params.inspectRequestBody) {
    return null;
  }

  if (params.input instanceof Request) {
    try {
      return await params.input.clone().text();
    } catch {
      return null;
    }
  }

  return null;
}

async function bodyInitToText(body: BodyInit): Promise<string | null> {
  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return body.text();
  }

  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }

  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }

  return null;
}

function parseJsonBodyText(bodyText: string | null): unknown {
  if (bodyText === null) {
    return null;
  }

  const trimmed = bodyText.trim();

  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function createTimeoutFetchInit(params: {
  readonly init: RequestInit | undefined;
  readonly requestTimeoutMs: number | undefined;
}): TimeoutFetchInit {
  if (
    params.requestTimeoutMs === undefined ||
    params.requestTimeoutMs <= 0
  ) {
    return {
      init: params.init,
      cleanup: () => {
        // No timeout configured.
      },
    };
  }

  const controller = new AbortController();
  const existingSignal = params.init?.signal;

  if (existingSignal?.aborted) {
    controller.abort();
  }

  const onAbort = (): void => {
    controller.abort();
  };

  existingSignal?.addEventListener('abort', onAbort, {
    once: true,
  });

  const timeout = setTimeout(() => {
    controller.abort();
  }, params.requestTimeoutMs);

  return {
    init: {
      ...(params.init ?? {}),
      signal: controller.signal,
    },
    cleanup: () => {
      clearTimeout(timeout);
      existingSignal?.removeEventListener('abort', onAbort);
    },
  };
}