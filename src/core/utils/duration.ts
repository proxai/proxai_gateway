export function parseBackfillDuration(input: string): number | null {
  const trimmed = input.trim();
  const match = /^(\d+)(d|mo|y)$/.exec(trimmed);
  if (match === null) return null;
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return null;
  const DAY_MS = 24 * 60 * 60 * 1000;
  if (unit === 'd') return value * DAY_MS;
  if (unit === 'mo') return value * 30 * DAY_MS;
  return value * 365 * DAY_MS;
}
