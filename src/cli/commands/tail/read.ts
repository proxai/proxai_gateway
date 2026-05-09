import { lineMatches } from 'cli/commands/tail/filter.ts';
import type { ResolvedFilters } from 'cli/commands/tail/tail.types.ts';

export interface ReadResult {
  lines: string[];
  endPosition: number;
}

export async function readMatchingTail(
  path: string,
  limit: number,
  filters: ResolvedFilters,
): Promise<ReadResult> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { lines: [], endPosition: 0 };
  const text = await file.text();
  const allLines = text.split('\n').filter((l) => l.length > 0);
  const matching: string[] = [];
  for (const line of allLines) {
    if (lineMatches(line, filters)) matching.push(line);
  }
  const tail = matching.slice(-limit);
  return { lines: tail, endPosition: text.length };
}

export async function readMatchingFrom(
  path: string,
  fromPosition: number,
  filters: ResolvedFilters,
): Promise<ReadResult> {
  const file = Bun.file(path);
  const size = file.size;
  if (size <= fromPosition) return { lines: [], endPosition: fromPosition };
  if (!(await file.exists())) return { lines: [], endPosition: fromPosition };
  const slice = await file.slice(fromPosition, size).text();
  const newLines = slice.split('\n').filter((l) => l.length > 0);
  const matching: string[] = [];
  for (const line of newLines) {
    if (lineMatches(line, filters)) matching.push(line);
  }
  return { lines: matching, endPosition: size };
}
