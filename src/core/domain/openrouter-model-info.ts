export interface OpenRouterModelPricing {
  readonly prompt?: string;
  readonly completion?: string;
  readonly image?: string;
  readonly request?: string;
  readonly inputCacheRead?: string;
  readonly inputCacheWrite?: string;
  readonly webSearch?: string;
  readonly internalReasoning?: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface OpenRouterModelPerRequestLimits {
  readonly promptTokens?: number | null;
  readonly completionTokens?: number | null;
  readonly raw?: Readonly<Record<string, unknown>> | null;
}

export interface OpenRouterModelArchitecture {
  readonly modality?: string;
  readonly inputModalities?: readonly string[];
  readonly outputModalities?: readonly string[];
  readonly tokenizer?: string;
  readonly instructType?: string | null;
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface OpenRouterModelTopProvider {
  readonly contextLength?: number | null;
  readonly maxCompletionTokens?: number | null;
  readonly isModerated?: boolean;
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface OpenRouterModelLinks {
  readonly details?: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface OpenRouterModelInfo {
  readonly id: string;
  readonly name?: string;
  readonly created?: number;
  readonly description?: string;
  readonly contextLength?: number;
  readonly pricing?: OpenRouterModelPricing;
  readonly architecture?: OpenRouterModelArchitecture;
  readonly topProvider?: OpenRouterModelTopProvider;
  readonly perRequestLimits?: OpenRouterModelPerRequestLimits | null;
  readonly supportedParameters?: readonly string[];
  readonly defaultParameters?: Readonly<Record<string, unknown>> | null;
  readonly links?: OpenRouterModelLinks;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface OpenRouterModelsListResult {
  readonly models: readonly OpenRouterModelInfo[];
  readonly loadedAtMs: number;
}

export interface OpenRouterModelLookupResult {
  readonly model: OpenRouterModelInfo | null;
  readonly loadedAtMs: number;
}