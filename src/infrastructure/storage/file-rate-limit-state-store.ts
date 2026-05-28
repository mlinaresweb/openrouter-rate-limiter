import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { OpenRouterRateLimitStateSnapshot } from '../../core/domain/rate-limit-state.js';
import type { OpenRouterRateLimitStateStore } from '../../core/domain/rate-limit-store.js';
import {
  cloneOpenRouterRateLimitStateSnapshot,
  parseOpenRouterRateLimitStateSnapshot,
  serializeOpenRouterRateLimitStateSnapshot,
} from './rate-limit-state-utils.js';

export interface FileRateLimitStateStoreOptions {
  readonly filePath: string;

  /**
   * If true, corrupted/unparseable files are ignored and treated as empty state.
   *
   * Defaults to true.
   */
  readonly ignoreCorruptedFile?: boolean;

  /**
   * If true, writes go through a temporary file + rename.
   *
   * Defaults to true.
   */
  readonly atomicWrites?: boolean;
}

/**
 * File-based state store.
 *
 * Useful for CLIs and automation workflows because the cooldown survives
 * process restarts.
 */
export class FileRateLimitStateStore implements OpenRouterRateLimitStateStore {
  private readonly filePath: string;
  private readonly ignoreCorruptedFile: boolean;
  private readonly atomicWrites: boolean;

  public constructor(options: FileRateLimitStateStoreOptions) {
    if (options.filePath.trim().length === 0) {
      throw new Error('FileRateLimitStateStore requires a non-empty filePath.');
    }

    this.filePath = path.resolve(options.filePath);
    this.ignoreCorruptedFile = options.ignoreCorruptedFile ?? true;
    this.atomicWrites = options.atomicWrites ?? true;
  }

  public async load(): Promise<OpenRouterRateLimitStateSnapshot | null> {
    let raw: string;

    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNodeFileNotFoundError(error)) {
        return null;
      }

      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      const snapshot = parseOpenRouterRateLimitStateSnapshot(parsed);

      if (!snapshot) {
        if (this.ignoreCorruptedFile) {
          return null;
        }

        throw new Error(
          `Invalid OpenRouter rate limit state file: ${this.filePath}`,
        );
      }

      return cloneOpenRouterRateLimitStateSnapshot(snapshot);
    } catch (error) {
      if (this.ignoreCorruptedFile) {
        return null;
      }

      throw error;
    }
  }

  public async save(
    snapshot: OpenRouterRateLimitStateSnapshot,
  ): Promise<void> {
    const directory = path.dirname(this.filePath);

    await mkdir(directory, {
      recursive: true,
    });

    const serialized = serializeOpenRouterRateLimitStateSnapshot(snapshot);

    if (!this.atomicWrites) {
      await writeFile(this.filePath, serialized, 'utf8');
      return;
    }

    const tempFilePath = buildTempFilePath(this.filePath);

    await writeFile(tempFilePath, serialized, 'utf8');
    await rename(tempFilePath, this.filePath);
  }

  public async clear(): Promise<void> {
    await rm(this.filePath, {
      force: true,
    });
  }

  public getFilePath(): string {
    return this.filePath;
  }
}

export function createFileRateLimitStateStore(
  options: FileRateLimitStateStoreOptions,
): FileRateLimitStateStore {
  return new FileRateLimitStateStore(options);
}

function buildTempFilePath(filePath: string): string {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const unique = `${process.pid.toString()}-${Date.now().toString()}-${Math.random()
    .toString(16)
    .slice(2)}`;

  return path.join(directory, `.${basename}.${unique}.tmp`);
}

function isNodeFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}