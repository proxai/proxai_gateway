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

// JUnit reports the leaf test name; the console block carries the full describe
// path. Match each failing case to its block and key the detail by the same
// `<file> <leaf>` the renderer looks up.
function matchFailureDetails(tests: TestCase[], blocks: FailureBlock[]): Map<string, string> {
  const details = new Map<string, string>();
  for (const t of tests) {
    if (t.status !== 'fail') continue;
    const block = blocks.find(
      (b) => b.detail !== '' && sameFile(b.file, t.file) && nameMatches(b.name, t.name),
    );
    if (block !== undefined) details.set(`${t.file} ${t.name}`, block.detail);
  }
  return details;
}

const FAIL_LINE_RE = /^\(fail\) /;
const PASSLIKE_LINE_RE = /^\((?:pass|skip|todo)\)/;

// Last-resort fallback when structured extraction yields nothing for some
// failure (an output shape bun changed, or path separators that defeat
// matching). Deliberately CONTENT-based — it never matches console paths to
// JUnit `file` attributes (the Windows `/` vs `\` mismatch is exactly what
// emptied the per-file approach). Returns the verbatim console for every
// section (header -> next header) that contains a `(fail)` marker; if no
// section parses, falls back to the whole console minus per-test pass/skip/todo
// noise. Empty string when every failure already matched a structured block.
function rawForUnmatched(
  testSection: string,
  tests: TestCase[],
  details: Map<string, string>,
): string {
  const hasUnmatched = tests.some(
    (t) => t.status === 'fail' && !details.has(`${t.file} ${t.name}`),
  );
  if (!hasUnmatched) return '';

  const lines = testSection.split('\n');
  const sections: string[] = [];
  let header = '';
  let buf: string[] = [];
  const flush = (): void => {
    if (header !== '' && buf.some((l) => FAIL_LINE_RE.test(l))) {
      sections.push([header, ...buf].join('\n').trim());
    }
  };
  for (const line of lines) {
    if (HEADER_RE.test(line)) {
      flush();
      header = line;
      buf = [];
      continue;
    }
    buf.push(line);
  }
  flush();
  if (sections.length > 0) return sections.join('\n\n');
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
