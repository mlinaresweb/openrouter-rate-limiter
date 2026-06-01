# openrouter-rate-limiter

Production-ready OpenRouter rate limiter for Node.js, CLIs and automation workflows.

`openrouter-rate-limiter` helps applications use OpenRouter safely by adding client-side rate limiting, retries, cooldown persistence, `Retry-After` handling, per-model policies, global policies, metadata inspection and an ergonomic SDK-style client.

It is designed for projects that call OpenRouter from scripts, command-line tools, CI jobs, developer tools, documentation generators, build pipelines, background workers or backend services.

## Why this package exists

OpenRouter can return rate-limit or provider-pressure errors such as `429 Too Many Requests`, `502 Bad Gateway`, `503 Service Unavailable` or credit-related errors such as `402 Payment Required`. Some responses may include a standard `Retry-After` header telling the caller how long to wait before retrying.

In real automation workflows, simply retrying immediately is a bad strategy. It can waste requests, keep hitting the same provider limit, make CLIs feel broken, and force users to restart long-running tasks manually.

This package provides a reusable and configurable layer that can:

- slow down requests before limits are hit;
- serialize requests by model or globally;
- persist cooldowns across process restarts;
- retry only when retrying makes sense;
- respect `Retry-After`;
- expose hooks for CLIs and UIs;
- let your app ask the user whether to wait, fail or stop;
- inspect OpenRouter key and model metadata;
- work as a low-level engine, a `fetch` wrapper or a high-level client.

## Features

- `OpenRouterRateLimiter` low-level engine.
- `createOpenRouterRateLimitedFetch` wrapper compatible with `fetch`.
- `createOpenRouterRateLimitedClient` high-level SDK-style client.
- Modes: `wait`, `ask`, `fail_fast`.
- Per-model limits.
- Global limits.
- `maxConcurrentRequests` per model.
- Global `maxConcurrentRequests`.
- `minIntervalMs` per model and globally.
- Rolling request windows.
- Rolling input character windows.
- `Retry-After` parsing.
- Exponential backoff with jitter.
- Persistent cooldown state with file store.
- In-memory state store.
- `inspectAvailability(...)` before running a request.
- `requestTimeoutMs` support.
- Hooks for logging, UI, CLI prompts and telemetry.
- OpenRouter `/key` client.
- OpenRouter `/models` client.
- Key/model metadata caching.
- Strict TypeScript support.
- ESM package.
- No runtime dependencies.

## Requirements

- Node.js `>=20`
- TypeScript recommended for best DX
- ESM project recommended

Node 20 includes native `fetch`, `Headers`, `Request`, `Response` and `AbortController`. If you use an older or custom runtime, pass your own `fetch` implementation.

## Installation

```bash
npm install openrouter-rate-limiter
```

```bash
pnpm add openrouter-rate-limiter
```

```bash
yarn add openrouter-rate-limiter
```

## Quick start: high-level client

The easiest way to use the library is the SDK-style client.

```ts
import { createOpenRouterRateLimitedClient } from 'openrouter-rate-limiter';

const client = createOpenRouterRateLimitedClient({
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultModel: 'openai/gpt-4o-mini',
  appName: 'My App',
  referer: 'https://example.com',
  requestTimeoutMs: 120_000,
  rateLimiter: {
    defaultPolicy: {
      mode: 'wait',
      maxRetries: 5,
      baseDelayMs: 2_000,
      maxDelayMs: 180_000,
      jitterRatio: 0.15,
      respectRetryAfter: true,
      cooldownNotificationIntervalMs: 15_000,
    },
    global: {
      maxConcurrentRequests: 1,
      minIntervalMs: 5_000,
      requestsPerWindow: 10,
      windowMs: 60_000,
    },
    models: {
      'openai/gpt-4o-mini': {
        maxConcurrentRequests: 1,
        minIntervalMs: 10_000,
      },
    },
  },
});

const completion = await client.chatCompletions({
  model: 'openai/gpt-4o-mini',
  messages: [
    {
      role: 'user',
      content: 'Explain client-side rate limiting in one paragraph.',
    },
  ],
});

console.log(completion);
```

## Quick start: rate-limited fetch

Use this when your app already builds OpenRouter requests manually and you only want a safer `fetch`.

```ts
import {
  OpenRouterRateLimiter,
  createOpenRouterRateLimitedFetch,
} from 'openrouter-rate-limiter';

const limiter = new OpenRouterRateLimiter({
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultModel: 'openai/gpt-4o-mini',
  defaultPolicy: {
    mode: 'wait',
    maxRetries: 5,
    respectRetryAfter: true,
  },
});

const openRouterFetch = createOpenRouterRateLimitedFetch({
  limiter,
  requestTimeoutMs: 120_000,
});

const response = await openRouterFetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'openai/gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: 'Hello!',
      },
    ],
  }),
});

const data = await response.json();
console.log(data);
```

The wrapper automatically extracts `model` from the JSON body when possible.

## Quick start: low-level engine

Use the low-level engine when you need full control over the actual request.

```ts
import { OpenRouterRateLimiter } from 'openrouter-rate-limiter';

const limiter = new OpenRouterRateLimiter({
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultPolicy: {
    mode: 'wait',
    maxRetries: 3,
    respectRetryAfter: true,
  },
});

const result = await limiter.execute({
  metadata: {
    model: 'openai/gpt-4o-mini',
    operation: 'documentation-plan',
    estimatedInputCharacters: 40_000,
  },
  execute: async () => {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [],
      }),
    });

    return {
      value: response,
      status: response.status,
      headers: response.headers,
    };
  },
});

console.log(result.value.status);
```

## Core concepts

### Policy modes

The limiter supports three execution modes.

#### `wait`

Automatically waits and retries when a request is limited.

```ts
const limiter = new OpenRouterRateLimiter({
  apiKey,
  defaultPolicy: {
    mode: 'wait',
    maxRetries: 5,
  },
});
```

Good for background workers, scripts and non-interactive automation.

#### `fail_fast`

Throws immediately when the request cannot run now.

```ts
const limiter = new OpenRouterRateLimiter({
  apiKey,
  defaultPolicy: {
    mode: 'fail_fast',
  },
});
```

Good for CI and test environments.

#### `ask`

Calls your `onLimitReached` hook and lets your app decide.

```ts
const limiter = new OpenRouterRateLimiter({
  apiKey,
  defaultPolicy: {
    mode: 'ask',
  },
  hooks: {
    async onLimitReached(event) {
      console.log(`OpenRouter is limited. Wait ${event.retryAfterMs}ms?`);

      return 'wait';
      // return 'fail';
      // return 'skip';
    },
  },
});
```

Good for CLIs and developer tools.

## Global limits

Global limits apply across all models.

```ts
const limiter = new OpenRouterRateLimiter({
  apiKey,
  global: {
    maxConcurrentRequests: 1,
    minIntervalMs: 5_000,
    requestsPerWindow: 10,
    windowMs: 60_000,
    inputCharactersPerWindow: 200_000,
  },
});
```

Use global limits when your quota is account-level, key-level or provider-level rather than model-level.

## Per-model limits

Model limits apply only to a specific model.

```ts
const limiter = new OpenRouterRateLimiter({
  apiKey,
  models: {
    'qwen/qwen3.5-flash-02-23': {
      maxConcurrentRequests: 1,
      minIntervalMs: 15_000,
      requestsPerWindow: 3,
      windowMs: 60_000,
      inputCharactersPerWindow: 120_000,
      policy: {
        maxRetries: 2,
        maxDelayMs: 120_000,
      },
    },
    'openai/gpt-4o-mini': {
      maxConcurrentRequests: 2,
      minIntervalMs: 2_000,
    },
  },
});
```

## `inspectAvailability(...)`

Use this before executing a request to know whether it can run immediately.

```ts
const availability = await limiter.inspectAvailability({
  model: 'qwen/qwen3.5-flash-02-23',
  operation: 'docs-plan',
  estimatedInputCharacters: 60_000,
});

if (!availability.canRunNow) {
  console.log(`Wait ${availability.waitMs}ms before running.`);
  console.log(availability.reason);
  console.log(availability.retryAt);
  console.log(availability.constraints);
}
```

Example result:

```ts
{
  canRunNow: false,
  model: 'qwen/qwen3.5-flash-02-23',
  waitMs: 43_000,
  retryAt: new Date('...'),
  reason: 'manual_policy',
  constraints: [
    {
      scope: 'global',
      reason: 'manual_policy',
      waitMs: 43_000,
      retryAt: new Date('...'),
      message: 'Global OpenRouter limiter is not ready. Reason: manual_policy. Wait: 43000ms.',
    },
  ],
  metadata: {
    model: 'qwen/qwen3.5-flash-02-23',
    operation: 'docs-plan',
    estimatedInputCharacters: 60_000,
  },
}
```

## Persistent state

Use a file store for CLIs and automation tools. Cooldowns survive process restarts.

```ts
import {
  OpenRouterRateLimiter,
  createFileRateLimitStateStore,
} from 'openrouter-rate-limiter';

const limiter = new OpenRouterRateLimiter({
  apiKey,
  store: createFileRateLimitStateStore({
    filePath: '.openrouter-rate-limiter/state.json',
  }),
});
```

Use memory store for tests, short-lived scripts or serverless-style runs.

```ts
import {
  OpenRouterRateLimiter,
  createMemoryRateLimitStateStore,
} from 'openrouter-rate-limiter';

const limiter = new OpenRouterRateLimiter({
  apiKey,
  store: createMemoryRateLimitStateStore(),
});
```

## Hooks

Hooks let your app log, display progress, collect telemetry or ask the user what to do.

```ts
const limiter = new OpenRouterRateLimiter({
  apiKey,
  defaultPolicy: {
    mode: 'ask',
    cooldownNotificationIntervalMs: 15_000,
  },
  hooks: {
    async onEvent(event) {
      console.log('[event]', event.type);
    },

    async onWarning(event) {
      console.warn(event.message);
    },

    async onLimitReached(event) {
      console.log(`Limit reached for ${event.model}`);
      console.log(`Reason: ${event.reason}`);
      console.log(`Retry after: ${event.retryAfterMs}ms`);

      return 'wait';
    },

    async onCooldown(event) {
      console.log(`Waiting ${event.remainingMs}ms for ${event.model}`);
    },

    async onRetry(event) {
      console.log(`Retry ${event.attempt}/${event.maxRetries}`);
    },
  },
});
```

## Request timeout

Use `requestTimeoutMs` with either the fetch wrapper or the high-level client.

```ts
const openRouterFetch = createOpenRouterRateLimitedFetch({
  limiter,
  requestTimeoutMs: 120_000,
});
```

```ts
const client = createOpenRouterRateLimitedClient({
  apiKey,
  defaultModel: 'openai/gpt-4o-mini',
  requestTimeoutMs: 120_000,
});
```

The package uses `AbortController` internally. If the caller also passes a signal, both timeout and caller cancellation are respected.

## High-level client API

### `chatCompletions(body, options?)`

```ts
const result = await client.chatCompletions({
  model: 'openai/gpt-4o-mini',
  messages: [
    {
      role: 'user',
      content: 'Write a haiku about rate limits.',
    },
  ],
});
```

### `postJson(pathOrUrl, body, options?)`

```ts
const result = await client.postJson('/chat/completions', {
  model: 'openai/gpt-4o-mini',
  messages: [],
});
```

### `requestJson(pathOrUrl, options?)`

```ts
const models = await client.requestJson('/models');
```

### `getCurrentKeyInfo(options?)`

```ts
const keyInfo = await client.getCurrentKeyInfo();

console.log(keyInfo.keyInfo.limitRemaining);
```

Force refresh:

```ts
const keyInfo = await client.getCurrentKeyInfo({
  forceRefresh: true,
});
```

### `listModels(options?)`

```ts
const models = await client.listModels({
  supportedParameters: ['structured_outputs'],
});

console.log(models.models.map((model) => model.id));
```

### `getModelInfo(modelId, options?)`

```ts
const model = await client.getModelInfo('openai/gpt-4o-mini');

console.log(model.model?.contextLength);
```

## OpenRouter metadata clients

You can also use the metadata clients directly.

```ts
import {
  OpenRouterKeyClient,
  OpenRouterModelsClient,
} from 'openrouter-rate-limiter';

const keyClient = new OpenRouterKeyClient({ apiKey });
const key = await keyClient.getCurrentKeyInfo();

const modelsClient = new OpenRouterModelsClient({ apiKey });
const models = await modelsClient.listModels();
```

## Parsing OpenRouter responses

The package exports parser helpers that can be used independently.

```ts
import { classifyOpenRouterResponse } from 'openrouter-rate-limiter';

const rawText = await response.text();

const classified = classifyOpenRouterResponse({
  status: response.status,
  statusText: response.statusText,
  ok: response.ok,
  headers: response.headers,
  rawText,
});

if (classified.category === 'rate_limit') {
  console.log(classified.retryAfterMs);
}
```

## Error handling

The package exposes typed errors.

```ts
import {
  OpenRouterCreditLimitError,
  OpenRouterRateLimitError,
  OpenRouterRateLimiterError,
} from 'openrouter-rate-limiter';

try {
  await client.chatCompletions({
    model: 'openai/gpt-4o-mini',
    messages: [],
  });
} catch (error) {
  if (error instanceof OpenRouterCreditLimitError) {
    console.error('Credit limit reached');
  } else if (error instanceof OpenRouterRateLimitError) {
    console.error(`Rate limited. Retry at ${error.retryAt.toISOString()}`);
  } else if (error instanceof OpenRouterRateLimiterError) {
    console.error(error.code, error.message);
  } else {
    throw error;
  }
}
```

## CLI example with `ask` mode

```ts
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  createFileRateLimitStateStore,
  createOpenRouterRateLimitedClient,
} from 'openrouter-rate-limiter';

const rl = readline.createInterface({ input, output });

const client = createOpenRouterRateLimitedClient({
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultModel: 'openai/gpt-4o-mini',
  rateLimiter: {
    store: createFileRateLimitStateStore({
      filePath: '.openrouter-rate-limiter/state.json',
    }),
    defaultPolicy: {
      mode: 'ask',
      maxRetries: 5,
      respectRetryAfter: true,
      cooldownNotificationIntervalMs: 15_000,
    },
    hooks: {
      async onLimitReached(event) {
        const answer = await rl.question(
          `OpenRouter is limited for ${event.model}. Wait ${Math.ceil(event.retryAfterMs / 1000)}s? [Y/n] `,
        );

        return answer.trim().toLowerCase() === 'n' ? 'fail' : 'wait';
      },
      async onCooldown(event) {
        console.log(`Still waiting: ${Math.ceil(event.remainingMs / 1000)}s`);
      },
    },
  },
});
```

## Server example

For servers, prefer `wait` or `fail_fast`, not `ask`.

```ts
const client = createOpenRouterRateLimitedClient({
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultModel: 'openai/gpt-4o-mini',
  rateLimiter: {
    defaultPolicy: {
      mode: 'wait',
      maxRetries: 3,
      respectRetryAfter: true,
    },
    global: {
      maxConcurrentRequests: 5,
      requestsPerWindow: 100,
      windowMs: 60_000,
    },
  },
});
```

## CI example

For CI, fail fast so builds do not hang.

```ts
const client = createOpenRouterRateLimitedClient({
  apiKey,
  defaultModel,
  rateLimiter: {
    defaultPolicy: {
      mode: 'fail_fast',
      maxRetries: 0,
    },
  },
});
```

## DriveDocs-style example

This package was designed with large automation workflows in mind, such as documentation generation from Git diffs.

```ts
import path from 'node:path';
import {
  createFileRateLimitStateStore,
  createOpenRouterRateLimitedClient,
} from 'openrouter-rate-limiter';

export function createDocsOpenRouterClient(params: {
  readonly apiKey: string;
  readonly model: string;
  readonly stateDirectory: string;
}) {
  return createOpenRouterRateLimitedClient({
    apiKey: params.apiKey,
    defaultModel: params.model,
    appName: 'DriveDocs',
    requestTimeoutMs: 120_000,
    rateLimiter: {
      store: createFileRateLimitStateStore({
        filePath: path.join(params.stateDirectory, 'openrouter-rate-limit-state.json'),
      }),
      defaultPolicy: {
        mode: 'ask',
        maxRetries: 5,
        baseDelayMs: 5_000,
        maxDelayMs: 180_000,
        jitterRatio: 0.15,
        respectRetryAfter: true,
        cooldownNotificationIntervalMs: 15_000,
      },
      global: {
        maxConcurrentRequests: 1,
        minIntervalMs: 10_000,
        requestsPerWindow: 6,
        windowMs: 60_000,
      },
      models: {
        [params.model]: {
          maxConcurrentRequests: 1,
          minIntervalMs: 15_000,
          inputCharactersPerWindow: 250_000,
          windowMs: 60_000,
        },
      },
    },
  });
}
```

## Configuration reference

### `OpenRouterRateLimiterConfig`

```ts
interface OpenRouterRateLimiterConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  appName?: string;
  referer?: string;
  userAgent?: string;
  defaultPolicy?: Partial<OpenRouterRateLimitPolicy>;
  global?: OpenRouterGlobalRateLimitPolicy;
  models?: Record<string, OpenRouterModelRateLimitPolicy>;
  store?: OpenRouterRateLimitStateStore;
  hooks?: OpenRouterRateLimitEventHandlers;
  inspectKeyBeforeRequest?: boolean;
  loadModelsMetadata?: boolean;
  modelsMetadataTtlMs?: number;
  keyInfoTtlMs?: number;
  fetch?: typeof fetch;
  clockMode?: 'system' | 'monotonic';
}
```

### `OpenRouterRateLimitPolicy`

```ts
interface OpenRouterRateLimitPolicy {
  mode: 'fail_fast' | 'wait' | 'ask';
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  respectRetryAfter: boolean;
  cooldownNotificationIntervalMs: number;
  retryOnServiceUnavailable: boolean;
  retryOnBadGateway: boolean;
  retryOnTimeout: boolean;
}
```

### `OpenRouterGlobalRateLimitPolicy`

```ts
interface OpenRouterGlobalRateLimitPolicy {
  minIntervalMs?: number;
  maxConcurrentRequests?: number;
  requestsPerWindow?: number;
  windowMs?: number;
  inputCharactersPerWindow?: number;
}
```

### `OpenRouterModelRateLimitPolicy`

```ts
interface OpenRouterModelRateLimitPolicy {
  minIntervalMs?: number;
  maxConcurrentRequests?: number;
  requestsPerWindow?: number;
  windowMs?: number;
  inputCharactersPerWindow?: number;
  policy?: Partial<OpenRouterRateLimitPolicy>;
}
```

## Recommended defaults

### Conservative CLI defaults

```ts
rateLimiter: {
  defaultPolicy: {
    mode: 'ask',
    maxRetries: 5,
    baseDelayMs: 5_000,
    maxDelayMs: 180_000,
    jitterRatio: 0.15,
    respectRetryAfter: true,
    cooldownNotificationIntervalMs: 15_000,
  },
  global: {
    maxConcurrentRequests: 1,
    minIntervalMs: 10_000,
  },
}
```

### Background worker defaults

```ts
rateLimiter: {
  defaultPolicy: {
    mode: 'wait',
    maxRetries: 5,
    respectRetryAfter: true,
  },
  global: {
    maxConcurrentRequests: 2,
    requestsPerWindow: 60,
    windowMs: 60_000,
  },
}
```

### CI defaults

```ts
rateLimiter: {
  defaultPolicy: {
    mode: 'fail_fast',
    maxRetries: 0,
  },
}
```

## Troubleshooting

### `429 Too Many Requests`

Use `respectRetryAfter: true`, a file store, global limits and per-model `minIntervalMs`.

```ts
rateLimiter: {
  store: createFileRateLimitStateStore({
    filePath: '.openrouter-rate-limiter/state.json',
  }),
  defaultPolicy: {
    mode: 'wait',
    respectRetryAfter: true,
    maxRetries: 5,
  },
  global: {
    maxConcurrentRequests: 1,
    minIntervalMs: 10_000,
  },
}
```

### The process retries too aggressively

Increase `baseDelayMs`, reduce `maxRetries`, and add `minIntervalMs`.

```ts
rateLimiter: {
  defaultPolicy: {
    baseDelayMs: 10_000,
    maxRetries: 3,
  },
  global: {
    minIntervalMs: 15_000,
  },
}
```

### I want to ask users before waiting

Use `mode: 'ask'` and implement `onLimitReached`.

```ts
hooks: {
  async onLimitReached(event) {
    return event.retryAfterMs < 60_000 ? 'wait' : 'fail';
  },
}
```

### I do not want state persisted

Use the memory store or omit `store`.

```ts
store: createMemoryRateLimitStateStore()
```

### I want cooldowns to survive restarts

Use `createFileRateLimitStateStore`.

```ts
store: createFileRateLimitStateStore({
  filePath: '.openrouter-rate-limiter/state.json',
})
```

## Testing your package consumption

This repository includes an external consumer verification script.

```bash
npm run verify:consumer
```

It builds the package, packs it, installs it in a temporary project, type-checks a real consumer and runs a runtime ESM smoke test.

## API exports

Main exports include:

```ts
export {
  OpenRouterRateLimiter,
  createOpenRouterRateLimitedClient,
  createOpenRouterRateLimitedFetch,
  withOpenRouterMetadata,
  createOpenRouterJsonHeaders,
  createMemoryRateLimitStateStore,
  createFileRateLimitStateStore,
  OpenRouterKeyClient,
  OpenRouterModelsClient,
  OpenRouterRateLimitError,
  OpenRouterCreditLimitError,
  OpenRouterRateLimiterError,
  classifyOpenRouterResponse,
  parseRetryAfterHeader,
}
```

## Design notes

This package intentionally does not hardcode a global table of model limits. OpenRouter routes across multiple providers and rate limits can depend on the model, provider, account, key, credits, routing and current provider pressure. Static limits can become stale quickly.

Instead, the package combines:

- caller-provided policies;
- observed `429`/transient failures;
- `Retry-After` when available;
- persistent local state;
- optional `/key` inspection;
- optional `/models` inspection;
- hooks so applications can decide how aggressive or conservative they want to be.

## License

MIT.

## Attribution

Created and maintained by `mlinaresweb`.

If you copy, fork, redistribute, publish, or create a derived version of this library, please preserve the original copyright and license notice as required by the MIT License.

## Useful OpenRouter documentation

- API rate limits: https://openrouter.ai/docs/api/reference/limits
- API errors and `Retry-After`: https://openrouter.ai/docs/api/reference/errors-and-debugging
- API authentication: https://openrouter.ai/docs/api/reference/authentication
- Models API: https://openrouter.ai/docs/api/reference/list-available-models
