export function nowMs(): number {
  return Date.now();
}

export function toRetryDate(delayMs: number, now: number = nowMs()): Date {
  return new Date(now + Math.max(delayMs, 0));
}

export function clampNumber(params: {
  readonly value: number;
  readonly min: number;
  readonly max: number;
}): number {
  return Math.min(Math.max(params.value, params.min), params.max);
}