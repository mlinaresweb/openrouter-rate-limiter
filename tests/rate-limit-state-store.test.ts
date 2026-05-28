import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  OpenRouterRateLimiter,
  createEmptyModelState,
  createEmptyOpenRouterRateLimitStateSnapshot,
  createFileRateLimitStateStore,
  createMemoryRateLimitStateStore,
  parseOpenRouterRateLimitStateSnapshot,
  serializeOpenRouterRateLimitStateSnapshot,
} from '../src/index.js';

describe('openrouter-rate-limiter · state stores', () => {
  it('stores and loads state in memory with defensive cloning', async () => {
    const snapshot = createEmptyOpenRouterRateLimitStateSnapshot(1000);
    const store = createMemoryRateLimitStateStore();

    await store.save({
      ...snapshot,
      models: {
        'openai/gpt-4o-mini': createEmptyModelState({
          model: 'openai/gpt-4o-mini',
          nowMs: 1000,
        }),
      },
    });

    const loaded = await store.load();

    expect(loaded?.version).toBe(1);
    expect(loaded?.models['openai/gpt-4o-mini']?.model).toBe('openai/gpt-4o-mini');

    if (loaded) {
      const mutated = loaded as {
        models: Record<string, { activeRequests: number }>;
      };

      const model = mutated.models['openai/gpt-4o-mini'];

      if (model) {
        model.activeRequests = 999;
      }
    }

    const loadedAgain = await store.load();

    expect(loadedAgain?.models['openai/gpt-4o-mini']?.activeRequests).toBe(0);
  });

  it('clears memory state', async () => {
    const store = createMemoryRateLimitStateStore();

    await store.save(createEmptyOpenRouterRateLimitStateSnapshot(1000));
    expect(await store.load()).not.toBeNull();

    await store.clear();

    expect(await store.load()).toBeNull();
  });

  it('persists state to a file', async () => {
    const tempDirectory = await mkdtemp(
      path.join(tmpdir(), 'openrouter-rate-limiter-store-'),
    );

    try {
      const filePath = path.join(tempDirectory, 'state', 'rate-limit.json');
      const store = createFileRateLimitStateStore({
        filePath,
      });

      const snapshot = createEmptyOpenRouterRateLimitStateSnapshot(1234);

      await store.save({
        ...snapshot,
        models: {
          'qwen/qwen3.5-flash-02-23': {
            ...createEmptyModelState({
              model: 'qwen/qwen3.5-flash-02-23',
              nowMs: 1234,
            }),
            cooldownUntilMs: 9999,
            cooldownReason: 'rate_limit',
            lastRetryAfterMs: 5000,
            consecutiveRateLimitCount: 2,
          },
        },
      });

      const raw = await readFile(filePath, 'utf8');
      const loaded = await store.load();

      expect(raw).toContain('qwen/qwen3.5-flash-02-23');
      expect(loaded?.models['qwen/qwen3.5-flash-02-23']?.cooldownUntilMs).toBe(9999);
      expect(loaded?.models['qwen/qwen3.5-flash-02-23']?.cooldownReason).toBe('rate_limit');
    } finally {
      await rm(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it('returns null when file store does not exist', async () => {
    const tempDirectory = await mkdtemp(
      path.join(tmpdir(), 'openrouter-rate-limiter-store-missing-'),
    );

    try {
      const store = createFileRateLimitStateStore({
        filePath: path.join(tempDirectory, 'missing.json'),
      });

      expect(await store.load()).toBeNull();
    } finally {
      await rm(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it('ignores corrupted state files by default', async () => {
    const tempDirectory = await mkdtemp(
      path.join(tmpdir(), 'openrouter-rate-limiter-store-corrupt-'),
    );

    try {
      const filePath = path.join(tempDirectory, 'state.json');

      await writeFile(filePath, '{ bad json', 'utf8');

      const store = createFileRateLimitStateStore({
        filePath,
      });

      expect(await store.load()).toBeNull();
    } finally {
      await rm(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it('throws on corrupted state files when ignoreCorruptedFile is false', async () => {
    const tempDirectory = await mkdtemp(
      path.join(tmpdir(), 'openrouter-rate-limiter-store-corrupt-strict-'),
    );

    try {
      const filePath = path.join(tempDirectory, 'state.json');

      await writeFile(filePath, '{ bad json', 'utf8');

      const store = createFileRateLimitStateStore({
        filePath,
        ignoreCorruptedFile: false,
      });

      await expect(store.load()).rejects.toThrow();
    } finally {
      await rm(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it('serializes and parses snapshots safely', () => {
    const snapshot = createEmptyOpenRouterRateLimitStateSnapshot(500);
    const serialized = serializeOpenRouterRateLimitStateSnapshot(snapshot);
    const parsed = JSON.parse(serialized) as unknown;

    expect(parseOpenRouterRateLimitStateSnapshot(parsed)).toEqual(snapshot);
    expect(parseOpenRouterRateLimitStateSnapshot({ version: 999 })).toBeNull();
  });

  it('uses memory store by default inside the limiter', async () => {
    const limiter = new OpenRouterRateLimiter({
      apiKey: 'sk-or-test',
    });

    const snapshot = createEmptyOpenRouterRateLimitStateSnapshot(777);

    await limiter.setState(snapshot);

    expect(await limiter.getState()).toEqual(snapshot);

    await limiter.clearState();

    expect(await limiter.getState()).toBeNull();
  });
});