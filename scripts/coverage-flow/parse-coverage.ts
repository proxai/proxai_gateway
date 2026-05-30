// bun's text coverage table -> per-file coverage. Returns every file (so callers
// can tell "now 100%" from "not measured") plus the gaps and the All-files row.

import type { CoverageRow } from './types.ts';

export interface ParsedCoverage {
  all: CoverageRow | null;
  byFile: Map<string, CoverageRow>;
  gaps: CoverageRow[];
  total: number;
}

export function parseCoverage(text: string): ParsedCoverage {
  let all: CoverageRow | null = null;
  const byFile = new Map<string, CoverageRow>();
  const gaps: CoverageRow[] = [];
  let total = 0;
  for (const raw of text.split('\n')) {
    if (!raw.includes('|')) continue;
    const cols = raw.split('|');
    if (cols.length < 3) continue;
    const file = (cols[0] ?? '').trim();
    if (file === '' || file === 'File' || file.startsWith('-')) continue;
    const funcs = Number.parseFloat((cols[1] ?? '').trim());
    const lines = Number.parseFloat((cols[2] ?? '').trim());
    if (Number.isNaN(funcs) || Number.isNaN(lines)) continue;
    const row: CoverageRow = { file, funcs, lines, uncovered: (cols[3] ?? '').trim() };
    if (file === 'All files') {
      all = row;
      continue;
    }
    byFile.set(file, row);
    total++;
    if (funcs < 100 || lines < 100) gaps.push(row);
  }
  return { all, byFile, gaps, total };
}
