// Compose the per-concern parsers into one ParsedRun for a RawRun.

import { ANSI_RE, COVERAGE_HEADER_REGEX } from './constants.ts';
import { collapseRetries, parseJunit } from './parse-junit.ts';
import { parseCoverage } from './parse-coverage.ts';
import { extractFailureBlocks, HEADER_RE } from './parse-failures.ts';
import type { FailureBlock } from './parse-failures.ts';
import type { ParsedRun, RawRun, TestCase } from './types.ts';

function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '');
}

// The console marker may differ from the JUnit `file` attribute by an abs/rel
// prefix AND by separator: bun's console prints `/` even on Windows, while
// JUnit's `file` attribute is the OS-native path (`\` on Windows). Normalize
// separators first, then match on a path boundary so `src/a/foo.test.ts`
// matches `foo.test.ts` but `bfoo.test.ts` does not. Without the normalization
// every Windows failure goes unmatched (console `src/x.test.ts` vs JUnit
// `src\x.test.ts`), which is exactly what dropped the detail on the Windows job.
function sameFile(a: string, b: string): boolean {
  const na = a.replace(/\\/g, '/');
  const nb = b.replace(/\\/g, '/');
  if (na === nb) return true;
  const [longer, shorter] = na.length >= nb.length ? [na, nb] : [nb, na];
  if (!longer.endsWith(shorter)) return false;
  return longer[longer.length - shorter.length - 1] === '/';
}

function nameMatches(consoleName: string, junitLeaf: string): boolean {
  return consoleName === junitLeaf || consoleName.endsWith(` > ${junitLeaf}`);
}

// A real failure block carries an `error:` line, a `<n> |` code frame, or a
// timeout note. Windows' name-only reporter emits a consolidated `(fail) <name>`
// list with NO such content — guarding on a signal stops those bare names from
// matching with garbage detail (and keeps the name-list fallback alive).
function hasFailureSignal(detail: string): boolean {
  return (
    /(?:^|\n)\s*error:/.test(detail) || /(?:^|\n)\s*\d+ \|/.test(detail) || /timed out/.test(detail)
  );
}

// JUnit reports the leaf test name; the console block carries the full describe
// path. Match each failing case to its block and key the detail by the same
// `<file> <leaf>` the renderer looks up.
function matchFailureDetails(tests: TestCase[], blocks: FailureBlock[]): Map<string, string> {
  const details = new Map<string, string>();
  for (const t of tests) {
    if (t.status !== 'fail') continue;
    const block = blocks.find(
      (b) => hasFailureSignal(b.detail) && sameFile(b.file, t.file) && nameMatches(b.name, t.name),
    );
    if (block !== undefined) details.set(`${t.file} ${t.name}`, block.detail);
  }
  return details;
}

const FAIL_LINE_RE = /^\s*\(fail\) /;
const PASSLIKE_LINE_RE = /^\s*\((?:pass|skip|todo)\)/;

// Fallback verbatim console for failures the structured matcher couldn't pair
// with a block. Dumps the raw section (header -> next header) only for files
// that still have an UNMATCHED failure, so it never re-prints detail already
// shown structurally. If no such section parses AND nothing matched at all
// (e.g. Windows name-only output), it dumps the whole console minus per-test
// pass/skip/todo noise so at least the failed names/counts survive. Empty when
// every failure already matched a structured block.
function rawForUnmatched(
  testSection: string,
  tests: TestCase[],
  details: Map<string, string>,
): string {
  const unmatchedFiles = new Set(
    tests
      .filter((t) => t.status === 'fail' && !details.has(`${t.file} ${t.name}`))
      .map((t) => t.file),
  );
  if (unmatchedFiles.size === 0) return '';

  const lines = testSection.split('\n');
  const sections: string[] = [];
  let headerLine = '';
  let headerPath = '';
  let buf: string[] = [];
  const flush = (): void => {
    if (
      headerPath !== '' &&
      buf.some((l) => FAIL_LINE_RE.test(l)) &&
      [...unmatchedFiles].some((f) => sameFile(headerPath, f))
    ) {
      sections.push([headerLine, ...buf].join('\n').trim());
    }
  };
  for (const line of lines) {
    const path = line.match(HEADER_RE)?.[1];
    if (path !== undefined) {
      flush();
      headerLine = line;
      headerPath = path;
      buf = [];
      continue;
    }
    buf.push(line);
  }
  flush();
  if (sections.length > 0) return sections.join('\n\n');
  // No per-file section parsed. Only dump the whole console when NOTHING matched
  // structurally (Windows name-only); otherwise the structured detail already
  // covers what bun emitted and there is nothing useful to add.
  if (details.size > 0) return '';
  return lines
    .filter((l) => !PASSLIKE_LINE_RE.test(l))
    .join('\n')
    .trim();
}

export function parseRun(raw: RawRun): ParsedRun {
  const consoleText = stripAnsi(raw.consoleText);
  const tests = collapseRetries(parseJunit(raw.junitXml));
  const covIdx = consoleText.search(COVERAGE_HEADER_REGEX);
  const testSection = covIdx >= 0 ? consoleText.slice(0, covIdx) : consoleText;
  const coverageSection = covIdx >= 0 ? consoleText.slice(covIdx) : '';
  const cov = parseCoverage(coverageSection);
  const failureDetails = matchFailureDetails(tests, extractFailureBlocks(testSection));
  return {
    tests,
    coverageByFile: cov.byFile,
    coverageAll: cov.all,
    coverageTotal: cov.total,
    gaps: cov.gaps,
    failureDetails,
    rawUnmatched: rawForUnmatched(testSection, tests, failureDetails),
  };
}
