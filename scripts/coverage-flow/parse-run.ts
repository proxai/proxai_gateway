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

// Split the test console into per-file sections (header line -> next header) and
// return, for each file that still has an unmatched failing test, its raw lines.
// This is the renderer's last-resort fallback when structured extraction yields
// nothing for a failure (e.g. an output shape bun changed or one we don't model).
function rawSectionsForUnmatched(
  testSection: string,
  tests: TestCase[],
  details: Map<string, string>,
): Map<string, string> {
  const unmatchedFiles = new Set(
    tests
      .filter((t) => t.status === 'fail' && !details.has(`${t.file} ${t.name}`))
      .map((t) => t.file),
  );
  const out = new Map<string, string>();
  if (unmatchedFiles.size === 0) return out;

  let header = '';
  let buf: string[] = [];
  const flush = (): void => {
    if (header === '') return;
    const target = [...unmatchedFiles].find((f) => sameFile(header, f));
    if (target !== undefined) {
      const body = buf.join('\n').trim();
      if (body !== '') out.set(target, body);
    }
  };
  for (const line of testSection.split('\n')) {
    const next = line.match(HEADER_RE)?.[1];
    if (next !== undefined) {
      flush();
      header = next;
      buf = [];
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
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
    rawByFile: rawSectionsForUnmatched(testSection, tests, failureDetails),
  };
}
