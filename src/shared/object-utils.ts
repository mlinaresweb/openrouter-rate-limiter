export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = record[key];

  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export function readNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = record[key];

  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

export function readBoolean(
  record: Readonly<Record<string, unknown>>,
  key: string,
): boolean | null {
  const value = record[key];

  return typeof value === 'boolean' ? value : null;
}

export function readRecord(
  record: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | null {
  const value = record[key];

  return isRecord(value) ? value : null;
}

export function readArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
): readonly unknown[] | null {
  const value = record[key];

  return Array.isArray(value) ? value : null;
}