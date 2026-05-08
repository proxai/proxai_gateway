export interface Version {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly suffix: number | null;
}

export function parseVersion(tag: string): Version | null {
  const stripped = tag.startsWith('v') ? tag.slice(1) : tag;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/.exec(stripped);
  if (match === null) return null;
  return {
    year: Number.parseInt(match[1]!, 10),
    month: Number.parseInt(match[2]!, 10),
    day: Number.parseInt(match[3]!, 10),
    suffix: match[4] !== undefined ? Number.parseInt(match[4], 10) : null,
  };
}

export function formatVersion(v: Version): string {
  const base = `${v.year.toString()}.${v.month.toString()}.${v.day.toString()}`;
  return v.suffix === null ? base : `${base}-${v.suffix.toString()}`;
}

export function compareDates(a: Version, b: Version): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

export function compareVersions(a: Version, b: Version): number {
  const dateCmp = compareDates(a, b);
  if (dateCmp !== 0) return dateCmp;
  const aSuf = a.suffix ?? 0;
  const bSuf = b.suffix ?? 0;
  return aSuf - bSuf;
}

export function todayUtc(now: Date = new Date()): Version {
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
    suffix: null,
  };
}

export function pickLatestTag(tags: readonly string[]): Version | null {
  const versions: Version[] = [];
  for (const t of tags) {
    const v = parseVersion(t);
    if (v !== null) versions.push(v);
  }
  if (versions.length === 0) return null;
  versions.sort(compareVersions);
  return versions[versions.length - 1]!;
}

export function computeNextVersion(latest: Version | null, today: Version): Version {
  if (latest === null) {
    return { year: today.year, month: today.month, day: today.day, suffix: null };
  }
  const dateCmp = compareDates(latest, today);
  if (dateCmp < 0) {
    return { year: today.year, month: today.month, day: today.day, suffix: null };
  }
  return {
    year: latest.year,
    month: latest.month,
    day: latest.day,
    suffix: (latest.suffix ?? 0) + 1,
  };
}
