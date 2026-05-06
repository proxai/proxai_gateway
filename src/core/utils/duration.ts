/**
 * Parse a coarse-grained `--since` duration into milliseconds.
 *
 * Supported units (designed for the `backfill` command — long horizons,
 * not log tail filters):
 *   - `Nd`  — days   (N * 24h)
 *   - `Nmo` — months (N * 30 days approx.)
 *   - `Ny`  — years  (N * 365 days approx.)
 *
 * Notes:
 *   - The unit must be one of the three forms above. `1m` is intentionally
 *     rejected as ambiguous (could be minutes or months).
 *   - N must be a non-negative integer; `0d` is allowed and yields 0 ms.
 *   - Whitespace around the value is trimmed.
 *
 * Returns the duration in ms, or `null` when the input is malformed.
 */
export function parseBackfillDuration(input: string): number | null {
  const trimmed = input.trim();
  const match = /^(\d+)(d|mo|y)$/.exec(trimmed);
  if (match === null) return null;
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return null;
  const DAY_MS = 24 * 60 * 60 * 1000;
  switch (unit) {
    case 'd':
      return value * DAY_MS;
    case 'mo':
      return value * 30 * DAY_MS;
    case 'y':
      return value * 365 * DAY_MS;
    default:
      return null;
  }
}
