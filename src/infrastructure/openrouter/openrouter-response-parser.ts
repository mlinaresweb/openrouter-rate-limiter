import type {
  OpenRouterErrorCategory,
  OpenRouterExtractedRequestModel,
  OpenRouterParsedError,
  OpenRouterResponseCategory,
  OpenRouterResponseClassification,
  OpenRouterResponseHeadersInfo,
} from '../../core/domain/openrouter-response.js';
import {
  isRecord,
  readArray,
  readRecord,
  readString,
} from '../../shared/object-utils.js';

export type OpenRouterHeadersLike =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | null
  | undefined;

export interface ClassifyOpenRouterResponseInput {
  readonly status: number;
  readonly statusText?: string;
  readonly ok?: boolean;
  readonly headers?: OpenRouterHeadersLike;
  readonly rawText: string;
  readonly nowMs?: number;
}

export function classifyOpenRouterResponse(
  input: ClassifyOpenRouterResponseInput,
): OpenRouterResponseClassification {
  const statusText = input.statusText ?? '';
  const httpOk = input.ok ?? isHttpOk(input.status);
  const rawJson = parseOpenRouterResponseJson(input.rawText);
  const errorObject = extractOpenRouterErrorObject(rawJson);

  if (httpOk && errorObject === null) {
    return {
      ok: true,
      httpOk,
      status: input.status,
      statusText,
      category: 'success',
      isRetryable: false,
      retryAfterMs: null,
      retryAt: null,
      rawText: input.rawText,
      rawJson,
      error: null,
    };
  }

  const error = buildParsedOpenRouterError({
    status: input.status,
    statusText,
    headers: input.headers,
    rawText: input.rawText,
    rawJson,
    errorObject,
    nowMs: input.nowMs,
  });

  return {
    ok: false,
    httpOk,
    status: input.status,
    statusText,
    category: error.category,
    isRetryable: error.isRetryable,
    retryAfterMs: error.retryAfterMs,
    retryAt: error.retryAt,
    rawText: input.rawText,
    rawJson,
    error,
  };
}

export function parseOpenRouterResponseJson(rawText: string): unknown {
  const trimmed = rawText.trim();

  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

export function parseRetryAfterHeader(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  const numericSeconds = Number(trimmed);

  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return Math.ceil(numericSeconds * 1000);
  }

  const parsedDateMs = Date.parse(trimmed);

  if (!Number.isFinite(parsedDateMs)) {
    return null;
  }

  return Math.max(parsedDateMs - nowMs, 0);
}

export function parseRetryAfterFromHeaders(
  headers: OpenRouterHeadersLike,
  nowMs: number = Date.now(),
): OpenRouterResponseHeadersInfo {
  const rawRetryAfter = getHeaderValue(headers, 'retry-after');
  const retryAfterMs = parseRetryAfterHeader(rawRetryAfter, nowMs);

  return {
    retryAfterMs,
    retryAt: retryAfterMs !== null ? new Date(nowMs + retryAfterMs) : null,
    rawRetryAfter,
  };
}

export function getHeaderValue(
  headers: OpenRouterHeadersLike,
  headerName: string,
): string | null {
  if (!headers) {
    return null;
  }

  const normalizedHeaderName = headerName.toLowerCase();

  if (headers instanceof Headers) {
    const value = headers.get(headerName);

    return value && value.trim().length > 0 ? value.trim() : null;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== normalizedHeaderName) {
      continue;
    }

    if (typeof value === 'string') {
      return value.trim().length > 0 ? value.trim() : null;
    }

    if (Array.isArray(value)) {
      const joined = value
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .join(', ');

      return joined.length > 0 ? joined : null;
    }
  }

  return null;
}

export function extractOpenRouterRequestModelFromBody(
  body: unknown,
): OpenRouterExtractedRequestModel {
  const parsedBody = parseRequestBody(body);

  if (!isRecord(parsedBody)) {
    return {
      model: null,
      fallbackModels: [],
    };
  }

  const directModel = readString(parsedBody, 'model');
  const models = readStringArray(parsedBody, 'models');

  if (directModel) {
    return {
      model: directModel,
      fallbackModels: models.filter((model) => model !== directModel),
    };
  }

  const firstModel = models[0];

  if (firstModel) {
    return {
      model: firstModel,
      fallbackModels: models.slice(1),
    };
  }

  return {
    model: null,
    fallbackModels: [],
  };
}

export function isOpenRouterRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export function classifyOpenRouterErrorCategory(params: {
  readonly status: number;
  readonly code: string | number | null;
  readonly message: string;
  readonly type: string | null;
}): OpenRouterErrorCategory {
  const normalizedMessage = params.message.toLowerCase();
  const normalizedType = params.type?.toLowerCase() ?? '';
  const normalizedCode = String(params.code ?? '').toLowerCase();

  if (params.status === 429 || normalizedCode === '429') {
    return 'rate_limit';
  }

  if (
    params.status === 402 ||
    normalizedCode === '402' ||
    normalizedMessage.includes('credit') ||
    normalizedMessage.includes('quota') ||
    normalizedMessage.includes('insufficient')
  ) {
    return 'credit_limit';
  }

  if (params.status === 401) {
    return 'authentication';
  }

  if (params.status === 403) {
    return 'authorization';
  }

  if (params.status === 400 || normalizedType.includes('invalid')) {
    return 'invalid_request';
  }

  if (params.status === 404) {
    return 'not_found';
  }

  if (params.status === 408) {
    return 'timeout';
  }

  if (
    params.status === 502 ||
    params.status === 503 ||
    normalizedMessage.includes('provider returned error') ||
    normalizedMessage.includes('provider') ||
    normalizedType.includes('provider')
  ) {
    return 'provider_unavailable';
  }

  if (params.status === 500 || params.status === 504) {
    return 'server_error';
  }

  return 'unknown';
}

function buildParsedOpenRouterError(params: {
  readonly status: number;
  readonly statusText: string;
  readonly headers: OpenRouterHeadersLike;
  readonly rawText: string;
  readonly rawJson: unknown;
  readonly errorObject: Readonly<Record<string, unknown>> | null;
  readonly nowMs: number | undefined;
}): OpenRouterParsedError {
  const headersInfo = parseRetryAfterFromHeaders(params.headers, params.nowMs);
  const rootObject = isRecord(params.rawJson) ? params.rawJson : null;
  const errorObject = params.errorObject;

  const message =
    (errorObject ? readString(errorObject, 'message') : null) ??
    (rootObject ? readString(rootObject, 'message') : null) ??
    params.statusText ??
    params.rawText.slice(0, 500) ??
    'OpenRouter request failed.';

  const code = errorObject
    ? readCodeValue(errorObject, 'code')
    : rootObject
      ? readCodeValue(rootObject, 'code')
      : null;

  const type =
    (errorObject ? readString(errorObject, 'type') : null) ??
    (rootObject ? readString(rootObject, 'type') : null);

  const metadata = errorObject?.metadata ?? rootObject?.metadata;

  const category = classifyOpenRouterErrorCategory({
    status: params.status,
    code,
    message,
    type,
  });

  const isRetryable = isRetryableCategory(category) || isOpenRouterRetryableStatus(params.status);

  return {
    status: params.status,
    statusText: params.statusText,
    category,
    message,
    isRetryable,
    isRateLimited: category === 'rate_limit',
    isCreditLimited: category === 'credit_limit',
    retryAfterMs: headersInfo.retryAfterMs,
    retryAt: headersInfo.retryAt,
    rawText: params.rawText,
    rawJson: params.rawJson,
    ...(code !== null ? { code } : {}),
    ...(type !== null ? { type } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function extractOpenRouterErrorObject(
  rawJson: unknown,
): Readonly<Record<string, unknown>> | null {
  if (!isRecord(rawJson)) {
    return null;
  }

  const errorObject = readRecord(rawJson, 'error');

  if (errorObject) {
    return errorObject;
  }

  if (readString(rawJson, 'message')) {
    return rawJson;
  }

  return null;
}

function isRetryableCategory(category: OpenRouterErrorCategory): boolean {
  return (
    category === 'rate_limit' ||
    category === 'timeout' ||
    category === 'provider_unavailable' ||
    category === 'server_error' ||
    category === 'network_error'
  );
}

function isHttpOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function readCodeValue(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | number | null {
  const value = record[key];

  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return null;
}

function parseRequestBody(body: unknown): unknown {
  if (typeof body === 'string') {
    const trimmed = body.trim();

    if (trimmed.length === 0) {
      return null;
    }

    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }

  if (body instanceof URLSearchParams) {
    const result: Record<string, string> = {};

    for (const [key, value] of body.entries()) {
      result[key] = value;
    }

    return result;
  }

  if (isRecord(body)) {
    return body;
  }

  return null;
}

function readStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = readArray(record, key);

  if (!value) {
    return [];
  }

  return value.filter((item): item is string => {
    return typeof item === 'string' && item.trim().length > 0;
  });
}