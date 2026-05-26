export function requireDefined<T>(value: T | null | undefined, context = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`${context} was ${value === null ? 'null' : 'undefined'}`);
  }
  return value;
}

export function requireString(value: unknown, context = 'value'): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${context} was not a string (got ${describeType(value)})`);
  }
  return value;
}

export function requireNumber(value: unknown, context = 'value'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${context} was not a finite number (got ${describeType(value)})`);
  }
  return value;
}

export function requireRecord(value: unknown, context = 'value'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${context} was not a plain object (got ${describeType(value)})`);
  }
  return value as Record<string, unknown>;
}

export interface ErrnoLike {
  readonly code: string;
  readonly message: string;
}

export function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as { code?: unknown }).code === 'string';
}

export function errnoCode(value: unknown): string | null {
  return isErrnoException(value) ? (value.code ?? null) : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
