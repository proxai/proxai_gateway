export function nowIsoUtc(): string {
  return new Date().toISOString();
}

export function monotonicMs(): number {
  return performance.now();
}
