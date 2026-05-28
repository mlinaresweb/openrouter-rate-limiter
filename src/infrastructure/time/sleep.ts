export interface SleepOptions {
  readonly signal?: AbortSignal;
}

export async function sleepMs(
  delayMs: number,
  options: SleepOptions = {},
): Promise<void> {
  const safeDelayMs = Math.max(0, delayMs);

  if (safeDelayMs === 0) {
    return;
  }

  if (options.signal?.aborted) {
    throw buildAbortError();
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, safeDelayMs);

    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(buildAbortError());
    };

    options.signal?.addEventListener('abort', onAbort, {
      once: true,
    });
  });
}

function buildAbortError(): Error {
  const error = new Error('Operation aborted.');

  error.name = 'AbortError';

  return error;
}