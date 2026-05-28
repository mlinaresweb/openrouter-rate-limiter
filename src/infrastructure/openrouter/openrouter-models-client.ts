import type {
  OpenRouterModelArchitecture,
  OpenRouterModelInfo,
  OpenRouterModelLinks,
  OpenRouterModelLookupResult,
  OpenRouterModelPerRequestLimits,
  OpenRouterModelPricing,
  OpenRouterModelsListResult,
  OpenRouterModelTopProvider,
} from '../../core/domain/openrouter-model-info.js';
import {
  isRecord,
  readArray,
  readBoolean,
  readNumber,
  readRecord,
  readString,
} from '../../shared/object-utils.js';
import {
  executeOpenRouterApiGetJson,
  resolveOpenRouterApiClientOptions,
  type OpenRouterApiClientOptions,
  type ResolvedOpenRouterApiClientOptions,
} from './openrouter-api-client-utils.js';

export interface OpenRouterModelsClientOptions extends OpenRouterApiClientOptions {}

export interface ListOpenRouterModelsOptions {
  readonly category?: string;
  readonly supportedParameters?: readonly string[];
  readonly modality?: string;
}

export class OpenRouterModelsClient {
  private readonly options: ResolvedOpenRouterApiClientOptions;

  public constructor(options: OpenRouterModelsClientOptions) {
    this.options = resolveOpenRouterApiClientOptions(options);
  }

  public async listModels(
    options: ListOpenRouterModelsOptions = {},
  ): Promise<OpenRouterModelsListResult> {
    const loadedAtMs = Date.now();

    const json = await executeOpenRouterApiGetJson({
      options: this.options,
      path: '/models',
      errorCode: 'OPENROUTER_MODELS_REQUEST_FAILED',
      errorMessage: 'Failed to load OpenRouter models.',
      query: buildModelsQuery(options),
    });

    return {
      models: parseOpenRouterModelsResponse(json),
      loadedAtMs,
    };
  }

  public async getModel(
    modelId: string,
    options: ListOpenRouterModelsOptions = {},
  ): Promise<OpenRouterModelLookupResult> {
    const loaded = await this.listModels(options);

    return {
      model: loaded.models.find((model) => model.id === modelId) ?? null,
      loadedAtMs: loaded.loadedAtMs,
    };
  }
}

export function parseOpenRouterModelsResponse(
  value: unknown,
): readonly OpenRouterModelInfo[] {
  if (!isRecord(value)) {
    throw new Error('Invalid OpenRouter models response: expected object.');
  }

  const data = readArray(value, 'data');

  if (!data) {
    throw new Error('Invalid OpenRouter models response: missing data array.');
  }

  return data
    .map(parseOpenRouterModelInfoOrNull)
    .filter((model): model is OpenRouterModelInfo => model !== null);
}

export function parseOpenRouterModelInfoOrNull(
  value: unknown,
): OpenRouterModelInfo | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = readString(value, 'id');

  if (!id) {
    return null;
  }

  const pricing = parsePricing(readRecord(value, 'pricing'));
  const architecture = parseArchitecture(readRecord(value, 'architecture'));
  const topProvider = parseTopProvider(readRecord(value, 'top_provider'));
  const perRequestLimits = parsePerRequestLimits(value.per_request_limits);
  const links = parseLinks(readRecord(value, 'links'));
  const supportedParameters = parseStringArray(value.supported_parameters);
  const defaultParameters = isRecord(value.default_parameters)
    ? value.default_parameters
    : value.default_parameters === null
      ? null
      : undefined;

  return {
    id,
    raw: value,
    ...(readString(value, 'name') !== null
      ? { name: readString(value, 'name') as string }
      : {}),
    ...(readNumber(value, 'created') !== null
      ? { created: readNumber(value, 'created') as number }
      : {}),
    ...(readString(value, 'description') !== null
      ? { description: readString(value, 'description') as string }
      : {}),
    ...(readNumber(value, 'context_length') !== null
      ? { contextLength: readNumber(value, 'context_length') as number }
      : {}),
    ...(pricing !== undefined ? { pricing } : {}),
    ...(architecture !== undefined ? { architecture } : {}),
    ...(topProvider !== undefined ? { topProvider } : {}),
    ...(perRequestLimits !== undefined ? { perRequestLimits } : {}),
    ...(supportedParameters !== undefined ? { supportedParameters } : {}),
    ...(defaultParameters !== undefined ? { defaultParameters } : {}),
    ...(links !== undefined ? { links } : {}),
  };
}

function buildModelsQuery(
  options: ListOpenRouterModelsOptions,
): Readonly<Record<string, string | null>> {
  const supportedParameters =
    options.supportedParameters && options.supportedParameters.length > 0
      ? options.supportedParameters.join(',')
      : null;

  return {
    category: options.category ?? null,
    supported_parameters: supportedParameters,
    modality: options.modality ?? null,
  };
}

function parsePricing(
  value: Readonly<Record<string, unknown>> | null,
): OpenRouterModelPricing | undefined {
  if (!value) {
    return undefined;
  }

  return {
    raw: value,
    ...(readString(value, 'prompt') !== null
      ? { prompt: readString(value, 'prompt') as string }
      : {}),
    ...(readString(value, 'completion') !== null
      ? { completion: readString(value, 'completion') as string }
      : {}),
    ...(readString(value, 'image') !== null
      ? { image: readString(value, 'image') as string }
      : {}),
    ...(readString(value, 'request') !== null
      ? { request: readString(value, 'request') as string }
      : {}),
    ...(readString(value, 'input_cache_read') !== null
      ? { inputCacheRead: readString(value, 'input_cache_read') as string }
      : {}),
    ...(readString(value, 'input_cache_write') !== null
      ? { inputCacheWrite: readString(value, 'input_cache_write') as string }
      : {}),
    ...(readString(value, 'web_search') !== null
      ? { webSearch: readString(value, 'web_search') as string }
      : {}),
    ...(readString(value, 'internal_reasoning') !== null
      ? { internalReasoning: readString(value, 'internal_reasoning') as string }
      : {}),
  };
}

function parseArchitecture(
  value: Readonly<Record<string, unknown>> | null,
): OpenRouterModelArchitecture | undefined {
  if (!value) {
    return undefined;
  }

  const inputModalities = parseStringArray(value.input_modalities);
  const outputModalities = parseStringArray(value.output_modalities);

  return {
    raw: value,
    ...(readString(value, 'modality') !== null
      ? { modality: readString(value, 'modality') as string }
      : {}),
    ...(inputModalities !== undefined ? { inputModalities } : {}),
    ...(outputModalities !== undefined ? { outputModalities } : {}),
    ...(readString(value, 'tokenizer') !== null
      ? { tokenizer: readString(value, 'tokenizer') as string }
      : {}),
    ...(hasOwn(value, 'instruct_type')
      ? { instructType: readNullableString(value, 'instruct_type') }
      : {}),
  };
}

function parseTopProvider(
  value: Readonly<Record<string, unknown>> | null,
): OpenRouterModelTopProvider | undefined {
  if (!value) {
    return undefined;
  }

  return {
    raw: value,
    ...(hasOwn(value, 'context_length')
      ? { contextLength: readNullableNumber(value, 'context_length') }
      : {}),
    ...(hasOwn(value, 'max_completion_tokens')
      ? { maxCompletionTokens: readNullableNumber(value, 'max_completion_tokens') }
      : {}),
    ...(readBoolean(value, 'is_moderated') !== null
      ? { isModerated: readBoolean(value, 'is_moderated') as boolean }
      : {}),
  };
}

function parsePerRequestLimits(
  value: unknown,
): OpenRouterModelPerRequestLimits | null | undefined {
  if (value === null) {
    return null;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  return {
    raw: value,
    ...(hasOwn(value, 'prompt_tokens')
      ? { promptTokens: readNullableNumber(value, 'prompt_tokens') }
      : {}),
    ...(hasOwn(value, 'completion_tokens')
      ? { completionTokens: readNullableNumber(value, 'completion_tokens') }
      : {}),
  };
}

function parseLinks(
  value: Readonly<Record<string, unknown>> | null,
): OpenRouterModelLinks | undefined {
  if (!value) {
    return undefined;
  }

  return {
    raw: value,
    ...(readString(value, 'details') !== null
      ? { details: readString(value, 'details') as string }
      : {}),
  };
}

function parseStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const parsed = value
    .filter((item): item is string => {
      return typeof item === 'string' && item.trim().length > 0;
    })
    .map((item) => item.trim());

  return parsed.length > 0 ? parsed : [];
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