

const GEN_SUFFIX_RE = /#gen=(\d+)$/;

export function currentGenerationNumber(path: string): number {
  const match = path.match(GEN_SUFFIX_RE);
  if (match === null) return 0;
  const parsed = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

export function stripGenerationSuffix(path: string): string {
  return path.replace(GEN_SUFFIX_RE, '');
}

export function nextGenerationSuffix(currentPath: string): string {
  const base = stripGenerationSuffix(currentPath);
  const next = currentGenerationNumber(currentPath) + 1;
  return `${base}#gen=${next}`;
}
