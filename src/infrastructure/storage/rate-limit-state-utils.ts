import type {
  OpenRouterGlobalRateLimitState,
  OpenRouterModelRateLimitState,
  OpenRouterModelWindowState,
  OpenRouterRateLimitStateSnapshot,
} from '../../core/domain/rate-limit-state.js';
import { isRecord } from '../../shared/object-utils.js';

export function createEmptyOpenRouterRateLimitStateSnapshot(
  nowMs: number = Date.now(),
): OpenRouterRateLimitStateSnapshot {
  return {
    version: 1,
    global: createEmptyGlobalState(nowMs),
    models: {},
  };
}

export function createEmptyGlobalState(
  nowMs: number = Date.now(),
): OpenRouterGlobalRateLimitState {
  return {
    activeRequests: 0,
    lastKeyInfoCheckedAtMs: null,
    lastModelsMetadataCheckedAtMs: null,
    globalCooldownUntilMs: null,
    globalCooldownReason: null,
    updatedAtMs: nowMs,
  };
}

export function createEmptyModelState(params: {
  readonly model: string;
  readonly nowMs?: number;
}): OpenRouterModelRateLimitState {
  const nowMs = params.nowMs ?? Date.now();

  return {
    model: params.model,
    activeRequests: 0,
    lastRequestStartedAtMs: null,
    lastRequestFinishedAtMs: null,
    cooldownUntilMs: null,
    cooldownReason: null,
    lastRetryAfterMs: null,
    consecutiveRateLimitCount: 0,
    consecutiveTransientErrorCount: 0,
    rollingWindow: null,
    updatedAtMs: nowMs,
  };
}

export function createModelWindowState(params: {
  readonly windowStartedAtMs: number;
  readonly requestCount?: number;
  readonly inputCharacters?: number;
}): OpenRouterModelWindowState {
  return {
    windowStartedAtMs: params.windowStartedAtMs,
    requestCount: params.requestCount ?? 0,
    inputCharacters: params.inputCharacters ?? 0,
  };
}

export function cloneOpenRouterRateLimitStateSnapshot(
  snapshot: OpenRouterRateLimitStateSnapshot,
): OpenRouterRateLimitStateSnapshot {
  return {
    version: 1,
    global: {
      ...snapshot.global,
    },
    models: Object.fromEntries(
      Object.entries(snapshot.models).map(([model, state]) => {
        return [
          model,
          {
            ...state,
            rollingWindow: state.rollingWindow
              ? {
                  ...state.rollingWindow,
                }
              : null,
          },
        ];
      }),
    ),
  };
}

export function parseOpenRouterRateLimitStateSnapshot(
  value: unknown,
): OpenRouterRateLimitStateSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.version !== 1) {
    return null;
  }

  const global = parseGlobalState(value.global);

  if (!global) {
    return null;
  }

  if (!isRecord(value.models)) {
    return null;
  }

  const models: Record<string, OpenRouterModelRateLimitState> = {};

  for (const [model, rawModelState] of Object.entries(value.models)) {
    const parsedModelState = parseModelState(rawModelState);

    if (!parsedModelState) {
      continue;
    }

    models[model] = parsedModelState;
  }

  return {
    version: 1,
    global,
    models,
  };
}

export function serializeOpenRouterRateLimitStateSnapshot(
  snapshot: OpenRouterRateLimitStateSnapshot,
): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function parseGlobalState(value: unknown): OpenRouterGlobalRateLimitState | null {
  if (!isRecord(value)) {
    return null;
  }

  const activeRequests = readFiniteNumber(value, 'activeRequests');

  if (activeRequests === null) {
    return null;
  }

  const updatedAtMs = readFiniteNumber(value, 'updatedAtMs');

  if (updatedAtMs === null) {
    return null;
  }

  return {
    activeRequests,
    lastKeyInfoCheckedAtMs: readNullableFiniteNumber(value, 'lastKeyInfoCheckedAtMs'),
    lastModelsMetadataCheckedAtMs: readNullableFiniteNumber(
      value,
      'lastModelsMetadataCheckedAtMs',
    ),
    globalCooldownUntilMs: readNullableFiniteNumber(value, 'globalCooldownUntilMs'),
    globalCooldownReason: readNullableCooldownReason(value, 'globalCooldownReason'),
    updatedAtMs,
  };
}

function parseModelState(value: unknown): OpenRouterModelRateLimitState | null {
  if (!isRecord(value)) {
    return null;
  }

  const model = readNonEmptyString(value, 'model');
  const activeRequests = readFiniteNumber(value, 'activeRequests');
  const consecutiveRateLimitCount = readFiniteNumber(value, 'consecutiveRateLimitCount');
  const consecutiveTransientErrorCount = readFiniteNumber(
    value,
    'consecutiveTransientErrorCount',
  );
  const updatedAtMs = readFiniteNumber(value, 'updatedAtMs');

  if (
    model === null ||
    activeRequests === null ||
    consecutiveRateLimitCount === null ||
    consecutiveTransientErrorCount === null ||
    updatedAtMs === null
  ) {
    return null;
  }

  return {
    model,
    activeRequests,
    lastRequestStartedAtMs: readNullableFiniteNumber(value, 'lastRequestStartedAtMs'),
    lastRequestFinishedAtMs: readNullableFiniteNumber(value, 'lastRequestFinishedAtMs'),
    cooldownUntilMs: readNullableFiniteNumber(value, 'cooldownUntilMs'),
    cooldownReason: readNullableCooldownReason(value, 'cooldownReason'),
    lastRetryAfterMs: readNullableFiniteNumber(value, 'lastRetryAfterMs'),
    consecutiveRateLimitCount,
    consecutiveTransientErrorCount,
    rollingWindow: parseNullableModelWindowState(value.rollingWindow),
    updatedAtMs,
  };
}

function parseNullableModelWindowState(
  value: unknown,
): OpenRouterModelWindowState | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const windowStartedAtMs = readFiniteNumber(value, 'windowStartedAtMs');
  const requestCount = readFiniteNumber(value, 'requestCount');
  const inputCharacters = readFiniteNumber(value, 'inputCharacters');

  if (
    windowStartedAtMs === null ||
    requestCount === null ||
    inputCharacters === null
  ) {
    return null;
  }

  return {
    windowStartedAtMs,
    requestCount,
    inputCharacters,
  };
}

function readFiniteNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = record[key];

  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNullableFiniteNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = record[key];

  if (value === null || value === undefined) {
    return null;
  }

  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNonEmptyString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = record[key];

  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNullableCooldownReason(
  record: Readonly<Record<string, unknown>>,
  key: string,
): OpenRouterGlobalRateLimitState['globalCooldownReason'] {
  const value = record[key];

  if (value === null || value === undefined) {
    return null;
  }

  if (
    value === 'rate_limit' ||
    value === 'retry_after' ||
    value === 'manual_policy' ||
    value === 'credit_limit' ||
    value === 'provider_unavailable' ||
    value === 'unknown'
  ) {
    return value;
  }

  return null;
}