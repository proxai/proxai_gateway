function parseVersionParts(version: string): number[] {
  const hyphenIndex = version.indexOf('-');
  const base = hyphenIndex === -1 ? version : version.slice(0, hyphenIndex);
  const suffix = hyphenIndex === -1 ? '' : version.slice(hyphenIndex + 1);
  const parts = base.split('.').map((segment) => {
    const parsed = Number.parseInt(segment, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  const suffixValue = Number.parseInt(suffix, 10);
  parts.push(Number.isFinite(suffixValue) ? suffixValue : 0);
  return parts;
}

export function compareGatewayVersions(a: string, b: string): number {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const lv = left[i] ?? 0;
    const rv = right[i] ?? 0;
    if (lv > rv) return 1;
    if (lv < rv) return -1;
  }
  return 0;
}
