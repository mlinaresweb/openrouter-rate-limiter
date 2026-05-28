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
  /**
   * Metadata used only by openrouter-rate-limiter.
   *
   * This property is removed before calling the real fetch implementation.
   */
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

  /**
   * Custom fetch implementation.
   *
   * Defaults to limiter.getConfig().fetch.
   */
  readonly fetch?: typeof fetch;

  /**
   * Used when neither init.openRouter.model nor request body model exists.
   */
  readonly defaultModel?: string;

  /**
   * Default operation name for observability hooks.
   */
  readonly defaultOperation?: string;

  /**
   * Custom input size estimator.
   *
   * If omitted, the wrapper uses the request body text length when available.
   */
  readonly estimateInputCharacters?: (
    input: EstimateOpenRouterInputCharactersInput,
  ) => number | Promise<number>;

  /**
   * If true, the wrapper tries to read Request body from input.clone()
   * when init.body is not provided.
   *
   * Defaults to true.
   */
  readonly inspectRequestBody?: boolean;
}

interface BuiltFetchMetadata {
  readonly metadata: OpenRouterRequestMetadata;
  readonly fetchInit: RequestInit | undefined;
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
        const response = await fetchImplementation(input, built.fetchInit);

        return {
          value: response,
          status: response.status,
          headers: response.headers,
        };
      },
    });

    return result.value;
  };
}

async function buildFetchMetadata(params: {
  readonly input: OpenRouterRateLimitedFetchInput;
  readonly init: OpenRouterRateLimitedFetchInit | undefined;
  readonly options: CreateOpenRouterRateLimitedFetchOptions;
}): Promise<BuiltFetchMetadata> {
  const fetchInit = stripOpenRouterMetadata(params.init);
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

  const metadata: OpenRouterRequestMetadata = {
    model,
    ...(fallbackModels.length > 0
      ? { fallbackModels }
      : {}),
    ...(estimatedInputCharacters !== null
      ? { estimatedInputCharacters }
      : {}),
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
    ...(params.init?.openRouter?.signal !== undefined
      ? { signal: params.init.openRouter.signal }
      : params.init?.signal instanceof AbortSignal
        ? { signal: params.init.signal }
        : {}),
  };

  return {
    metadata,
    fetchInit,
  };
}

function stripOpenRouterMetadata(
  init: OpenRouterRateLimitedFetchInit | undefined,
): RequestInit | undefined {
  if (init === undefined) {
    return undefined;
  }

  const {
    openRouter: _openRouter,
    ...fetchInit
  } = init;

  return fetchInit;
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

  /**
   * FormData and ReadableStream are intentionally not consumed here.
   *
   * - FormData is not expected for OpenRouter JSON requests.
   * - ReadableStream would be consumed and break the actual fetch call.
   */
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