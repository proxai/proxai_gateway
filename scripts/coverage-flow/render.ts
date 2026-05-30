// Assemble the final colored report from the main run + retry outcome.
// Sections: heavy tests, coverage gaps, failures, flake check, timing, summary.

import { SHARE_THRESHOLD_PCT } from './constants.ts';
import { fmtDur, median, percentile } from './stats.ts';
import { chalk, composeRow, section, TERM_WIDTH } from './term.ts';
import type { CoverageRow, ParsedRun, RetryOutcome, TestCase } from './types.ts';
import type { TableCell } from './term.ts';

function pct(value: number): string {
  const s = `${value.toFixed(2)}%`;
  return value >= 100 ? chalk.green(s) : chalk.red(s);
}

function colorizeDiffLine(line: string): string {
  if (line.startsWith('error:')) return chalk.red(line);
  if (/^[-]\s/.test(line) || line.startsWith('- Expected')) return chalk.red(line);
  if (/^[+]\s/.test(line) || line.startsWith('+ Received')) return chalk.green(line);
  if (/^\s*at\b.*:\d+:\d+/.test(line)) return chalk.dim(line);
  return line;
}

const INDENT = '  ';
const GAP = '  ';

function renderHeavyTests(out: string[], passed: TestCase[], sumMs: number): number {
  const shareOf = (ms: number): number => (sumMs > 0 ? (ms / sumMs) * 100 : 0);
  const heavy = passed
    .filter((t) => shareOf(t.durationMs) >= SHARE_THRESHOLD_PCT)
    .toSorted((a, b) => b.durationMs - a.durationMs);
  const heavyMs = heavy.reduce((acc, t) => acc + t.durationMs, 0);
  const heavyShare = sumMs > 0 ? (heavyMs / sumMs) * 100 : 0;

  out.push(section(`Tests >= ${SHARE_THRESHOLD_PCT.toFixed(2)}% of total time (${heavy.length})`));
  out.push(
    chalk.dim(`${INDENT}% = share of total test time. long cells wrap to fit your terminal`),
  );
  if (heavy.length === 0) {
    out.push(
      `${INDENT}${chalk.dim(`(no passing test takes >= ${SHARE_THRESHOLD_PCT.toFixed(2)}% of total time)`)}`,
    );
    return heavyShare;
  }
  const rankW = Math.max(2, String(heavy.length).length);
  const timeW = 9;
  const shareW = 7;
  const fixed = INDENT.length + rankW + timeW + shareW + GAP.length * 4;
  const flex = Math.max(30, TERM_WIDTH - fixed);
  const testW = Math.max(16, Math.round(flex * 0.58));
  const fileW = Math.max(14, flex - testW);
  out.push(
    chalk.dim(
      INDENT +
        [
          '#'.padStart(rankW),
          'TIME'.padStart(timeW),
          '%'.padStart(shareW),
          'TEST'.padEnd(testW),
          'FILE'.padEnd(fileW),
        ].join(GAP),
    ),
  );
  heavy.forEach((t, i) => {
    const cells: TableCell[] = [
      {
        text: `${i + 1}`,
        width: rankW,
        align: 'right',
        paint: (s) => chalk.dim(s),
        firstLineOnly: true,
      },
      {
        text: `${t.durationMs.toFixed(1)}ms`,
        width: timeW,
        align: 'right',
        paint: (s) => chalk.yellow(s),
        firstLineOnly: true,
      },
      {
        text: `${shareOf(t.durationMs).toFixed(2)}%`,
        width: shareW,
        align: 'right',
        paint: (s) => chalk.magenta(s),
        firstLineOnly: true,
      },
      { text: t.name, width: testW, align: 'left', paint: (s) => s, firstLineOnly: false },
      {
        text: `${t.file}:${t.line}`,
        width: fileW,
        align: 'left',
        paint: (s) => chalk.dim(s),
        firstLineOnly: false,
      },
    ];
    for (const phys of composeRow(cells, INDENT, GAP)) out.push(phys);
  });
  return heavyShare;
}

function renderCoverageGaps(out: string[], all: CoverageRow | null, gaps: CoverageRow[]): void {
  out.push(section('Coverage gaps'));
  if (all === null) {
    out.push(`${INDENT}${chalk.dim('(no coverage table found)')}`);
    return;
  }
  if (gaps.length === 0) {
    out.push(`${INDENT}${chalk.green('OK - every file at 100.00% funcs / 100.00% lines')}`);
    return;
  }
  const funcsW = 7;
  const linesW = 7;
  const fixed = INDENT.length + funcsW + linesW + GAP.length * 3;
  const flex = Math.max(30, TERM_WIDTH - fixed);
  const fileW = Math.max(20, Math.round(flex * 0.5));
  const uncW = Math.max(12, flex - fileW);
  out.push(
    chalk.dim(
      INDENT +
        [
          'FILE'.padEnd(fileW),
          'FUNCS'.padStart(funcsW),
          'LINES'.padStart(linesW),
          'UNCOVERED'.padEnd(uncW),
        ].join(GAP),
    ),
  );
  for (const g of gaps) {
    const fPaint = g.funcs < 100 ? (s: string) => chalk.red(s) : (s: string) => chalk.green(s);
    const lPaint = g.lines < 100 ? (s: string) => chalk.red(s) : (s: string) => chalk.green(s);
    const cells: TableCell[] = [
      {
        text: g.file,
        width: fileW,
        align: 'left',
        paint: (s) => chalk.dim(s),
        firstLineOnly: false,
      },
      {
        text: g.funcs.toFixed(2),
        width: funcsW,
        align: 'right',
        paint: fPaint,
        firstLineOnly: true,
      },
      {
        text: g.lines.toFixed(2),
        width: linesW,
        align: 'right',
        paint: lPaint,
        firstLineOnly: true,
      },
      {
        text: g.uncovered === '' ? '-' : g.uncovered,
        width: uncW,
        align: 'left',
        paint: (s) => chalk.dim(s),
        firstLineOnly: false,
      },
    ];
    for (const phys of composeRow(cells, INDENT, GAP)) out.push(phys);
  }
}

function renderFailures(out: string[], failed: TestCase[], details: Map<string, string>): void {
  out.push(section(`Failures (${failed.length})`));
  if (failed.length === 0) {
    out.push(`${INDENT}${chalk.green('OK - no failing tests')}`);
    return;
  }
  const byFile = new Map<string, TestCase[]>();
  for (const t of failed) {
    const arr = byFile.get(t.file) ?? [];
    arr.push(t);
    byFile.set(t.file, arr);
  }
  for (const [file, fileTests] of byFile) {
    out.push(chalk.red.bold(`\n${INDENT}${file}`));
    for (const t of fileTests) {
      out.push(`${INDENT}  ${chalk.red(`x ${t.name}`)} ${chalk.dim(`(line ${t.line})`)}`);
      const detail = details.get(`${t.file} ${t.name}`);
      if (detail !== undefined && detail !== '') {
        for (const dl of detail.split('\n')) out.push(`${INDENT}    ${colorizeDiffLine(dl)}`);
      } else {
        out.push(`${INDENT}    ${chalk.dim('(no console detail captured)')}`);
      }
    }
  }
}

function renderFlakeCheck(out: string[], retry: RetryOutcome): void {
  if (!retry.ran) return;
  const note = retry.converged ? '' : ', hit max';
  out.push(section(`Coverage flake check (${retry.retries} full re-runs${note})`));
  out.push(
    chalk.dim(
      `${INDENT}flaky test failures are absorbed earlier by bun --retry; this is gaps only`,
    ),
  );

  const recovered = retry.gaps.filter((g) => g.recovered);
  const authentic = retry.gaps.filter((g) => !g.recovered);

  if (recovered.length > 0) {
    out.push(`${INDENT}${chalk.green('Recovered (flaky - reached 100% on a full re-run):')}`);
    for (const g of recovered) {
      out.push(
        `${INDENT}  ${chalk.green('gap')} ${g.file} (was ${g.funcs.toFixed(2)}% / ${g.lines.toFixed(2)}%)`,
      );
    }
  }
  if (authentic.length > 0) {
    out.push(`${INDENT}${chalk.yellow('Authentic (gap reproduced across full re-runs):')}`);
    for (const g of authentic) {
      out.push(
        `${INDENT}  ${chalk.yellow('gap')} ${g.file} (${g.funcs.toFixed(2)}% / ${g.lines.toFixed(2)}%)`,
      );
    }
  }
}

function renderTiming(
  out: string[],
  executed: TestCase[],
  wallClockMs: number,
  heavyShare: number,
  heavyCount: number,
): void {
  const durationsAsc = executed.map((t) => t.durationMs).toSorted((a, b) => a - b);
  const sumMs = durationsAsc.reduce((acc, v) => acc + v, 0);
  const meanMs = executed.length > 0 ? sumMs / executed.length : 0;
  const medianMs = median(durationsAsc);

  out.push(section('Timing'));
  const timing = (label: string, value: string, note: string): void => {
    const noteTxt = note === '' ? '' : `  ${chalk.dim(note)}`;
    out.push(`${INDENT}${label.padEnd(16)} ${chalk.bold(value.padStart(9))}${noteTxt}`);
  };
  timing('Wall-clock:', fmtDur(wallClockMs), 'elapsed (includes load, hooks, coverage)');
  timing(
    'Test time (sum):',
    fmtDur(sumMs),
    `sum of ${executed.length} executed tests = 100% basis`,
  );
  timing('Median:', fmtDur(medianMs), '');
  timing('Mean:', fmtDur(meanMs), meanMs > medianMs * 3 ? 'mean >> median (slow tail)' : '');
  timing(
    'p95 / p99:',
    `${fmtDur(percentile(durationsAsc, 95))} / ${fmtDur(percentile(durationsAsc, 99))}`,
    '',
  );
  timing(`Top ${heavyCount} share:`, `${heavyShare.toFixed(2)}%`, 'of total test time');
}

function renderSummary(
  out: string[],
  passed: TestCase[],
  failed: TestCase[],
  skipped: TestCase[],
  fileCount: number,
  all: CoverageRow | null,
  gaps: CoverageRow[],
  total: number,
  retry: RetryOutcome,
): void {
  out.push(section('Summary'));
  const failTxt = failed.length > 0 ? chalk.red(`${failed.length} failed`) : '0 failed';
  out.push(
    `${INDENT}Tests:    ${chalk.green(`${passed.length} passed`)} | ${failTxt} | ${skipped.length} skipped`,
  );
  const filesWithFailures = new Set(failed.map((t) => t.file)).size;
  const fwf =
    filesWithFailures > 0 ? chalk.red(`${filesWithFailures} with failures`) : '0 with failures';
  out.push(`${INDENT}Files:    ${fileCount} total | ${fwf}`);
  if (all !== null) {
    const at100 = total - gaps.length;
    const at100Txt =
      gaps.length > 0 ? chalk.red(`${at100}/${total}`) : chalk.green(`${at100}/${total}`);
    out.push(
      `${INDENT}Coverage: lines ${pct(all.lines)} | funcs ${pct(all.funcs)} | ${at100Txt} files at 100%`,
    );
  }
  if (retry.ran) {
    const recN = retry.gaps.filter((g) => g.recovered).length;
    const authN = retry.gaps.filter((g) => !g.recovered).length;
    const authTxt = authN > 0 ? chalk.red(`${authN} authentic`) : '0 authentic';
    out.push(
      `${INDENT}Gap rechecks: ${retry.retries} re-runs | ${chalk.green(`${recN} flaky-recovered`)} | ${authTxt}`,
    );
  }
}

export function renderReport(
  main: ParsedRun,
  retry: RetryOutcome,
  wallClockMs: number,
): { text: string; failing: number } {
  const passed = main.tests.filter((t) => t.status === 'pass');
  const failed = main.tests.filter((t) => t.status === 'fail');
  const skipped = main.tests.filter((t) => t.status === 'skip');
  const executed = main.tests.filter((t) => t.status !== 'skip');
  const sumMs = executed.reduce((acc, t) => acc + t.durationMs, 0);
  const fileCount = new Set(main.tests.map((t) => t.file)).size;

  const out: string[] = [];
  const heavyShare = renderHeavyTests(out, passed, sumMs);
  const heavyCount = passed.filter(
    (t) => (sumMs > 0 ? (t.durationMs / sumMs) * 100 : 0) >= SHARE_THRESHOLD_PCT,
  ).length;
  renderCoverageGaps(out, main.coverageAll, main.gaps);
  renderFailures(out, failed, main.failureDetails);
  renderFlakeCheck(out, retry);
  renderTiming(out, executed, wallClockMs, heavyShare, heavyCount);
  renderSummary(
    out,
    passed,
    failed,
    skipped,
    fileCount,
    main.coverageAll,
    main.gaps,
    main.coverageTotal,
    retry,
  );

  // Build fails on genuine test failures (bun already retried flaky ones away)
  // plus coverage gaps that survived the full re-runs.
  const authenticGaps = retry.ran ? retry.gaps.filter((g) => !g.recovered).length : 0;
  const failing = failed.length + authenticGaps;
  return { text: `${out.join('\n')}\n`, failing };
}
