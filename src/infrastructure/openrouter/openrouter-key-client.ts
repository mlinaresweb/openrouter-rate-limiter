import type {
  OpenRouterKeyInfo,
  OpenRouterKeyInfoResult,
  OpenRouterKeyLimitReset,
} from '../../core/domain/openrouter-key-info.js';
import {
  isRecord,
  readBoolean,
  readNumber,
  readString,
} from '../../shared/object-utils.js';
import {
  executeOpenRouterApiGetJson,
  resolveOpenRouterApiClientOptions,
  type OpenRouterApiClientOptions,
  type ResolvedOpenRouterApiClientOptions,
} from './openrouter-api-client-utils.js';

export interface OpenRouterKeyClientOptions extends OpenRouterApiClientOptions {}

export class OpenRouterKeyClient {
  private readonly options: ResolvedOpenRouterApiClientOptions;

  public constructor(options: OpenRouterKeyClientOptions) {
    this.options = resolveOpenRouterApiClientOptions(options);
  }

  public async getCurrentKeyInfo(): Promise<OpenRouterKeyInfoResult> {
    const checkedAtMs = Date.now();

    const json = await executeOpenRouterApiGetJson({
      options: this.options,
      path: '/key',
      errorCode: 'OPENROUTER_KEY_INFO_REQUEST_FAILED',
      errorMessage: 'Failed to load OpenRouter current API key information.',
    });

    return {
      keyInfo: parseOpenRouterKeyInfoResponse(json),
      checkedAtMs,
    };
  }
}

export function parseOpenRouterKeyInfoResponse(
  value: unknown,
): OpenRouterKeyInfo {
  const data = extractDataObject(value);

  if (!data) {
    throw new Error('Invalid OpenRouter key info response: missing data object.');
  }

  return parseOpenRouterKeyInfo(data);
}

export function parseOpenRouterKeyInfo(
  data: Readonly<Record<string, unknown>>,
): OpenRouterKeyInfo {
  const limitReset = parseLimitReset(data.limit_reset);

  return {
    raw: data,
    ...(readString(data, 'label') !== null
      ? { label: readString(data, 'label') as string }
      : {}),
    ...(readString(data, 'name') !== null
      ? { name: readString(data, 'name') as string }
      : {}),
    ...(readString(data, 'hash') !== null
      ? { hash: readString(data, 'hash') as string }
      : {}),
    ...(readNumber(data, 'usage') !== null
      ? { usage: readNumber(data, 'usage') as number }
      : {}),
    ...(readNumber(data, 'usage_daily') !== null
      ? { usageDaily: readNumber(data, 'usage_daily') as number }
      : {}),
    ...(readNumber(data, 'usage_weekly') !== null
      ? { usageWeekly: readNumber(data, 'usage_weekly') as number }
      : {}),
    ...(readNumber(data, 'usage_monthly') !== null
      ? { usageMonthly: readNumber(data, 'usage_monthly') as number }
      : {}),
    ...(readNumber(data, 'byok_usage') !== null
      ? { byokUsage: readNumber(data, 'byok_usage') as number }
      : {}),
    ...(readNumber(data, 'byok_usage_daily') !== null
      ? { byokUsageDaily: readNumber(data, 'byok_usage_daily') as number }
      : {}),
    ...(readNumber(data, 'byok_usage_weekly') !== null
      ? { byokUsageWeekly: readNumber(data, 'byok_usage_weekly') as number }
      : {}),
    ...(readNumber(data, 'byok_usage_monthly') !== null
      ? { byokUsageMonthly: readNumber(data, 'byok_usage_monthly') as number }
      : {}),
    ...(hasOwn(data, 'limit') ? { limit: readNullableNumber(data, 'limit') } : {}),
    ...(hasOwn(data, 'limit_remaining')
      ? { limitRemaining: readNullableNumber(data, 'limit_remaining') }
      : {}),
    ...(hasOwn(data, 'limit_reset') ? { limitReset } : {}),
    ...(readBoolean(data, 'include_byok_in_limit') !== null
      ? { includeByokInLimit: readBoolean(data, 'include_byok_in_limit') as boolean }
      : {}),
    ...(readBoolean(data, 'disabled') !== null
      ? { disabled: readBoolean(data, 'disabled') as boolean }
      : {}),
    ...(readString(data, 'created_at') !== null
      ? { createdAt: readString(data, 'created_at') as string }
      : {}),
    ...(readString(data, 'updated_at') !== null
      ? { updatedAt: readString(data, 'updated_at') as string }
      : {}),
    ...(hasOwn(data, 'expires_at')
      ? { expiresAt: readNullableString(data, 'expires_at') }
      : {}),
    ...(readString(data, 'workspace_id') !== null
      ? { workspaceId: readString(data, 'workspace_id') as string }
      : {}),
    ...(readString(data, 'creator_user_id') !== null
      ? { creatorUserId: readString(data, 'creator_user_id') as string }
      : {}),
    ...(readBoolean(data, 'is_free_tier') !== null
      ? { isFreeTier: readBoolean(data, 'is_free_tier') as boolean }
      : {}),
  };
}

function extractDataObject(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  if (!isRecord(value)) {
    return null;
  }

  const data = value.data;

  return isRecord(data) ? data : value;
}

function parseLimitReset(value: unknown): OpenRouterKeyLimitReset {
  if (value === null || value === undefined) {
    return null;
  }

  if (value === 'daily' || value === 'weekly' || value === 'monthly') {
    return value;
  }

  return null;
}

function readNullableNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = record[key];

  if (value === null || value === undefined) {
    return null;
  }

  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNullableString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = record[key];

  if (value === null || value === undefined) {
    return null;
  }

  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function hasOwn(
  record: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}