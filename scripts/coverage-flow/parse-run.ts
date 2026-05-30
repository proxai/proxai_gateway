// Compose the per-concern parsers into one ParsedRun for a RawRun.

import { ANSI_RE, COVERAGE_HEADER_REGEX } from './constants.ts';
import { collapseRetries, parseJunit } from './parse-junit.ts';
import { parseCoverage } from './parse-coverage.ts';
import { extractFailureBlocks } from './parse-failures.ts';
import type { FailureBlock } from './parse-failures.ts';
import type { ParsedRun, RawRun, TestCase } from './types.ts';

function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '');
}

// The console marker may differ from the JUnit `file` attribute only by an
// abs/rel prefix; match on a path boundary so `src/a/foo.test.ts` matches
// `foo.test.ts` but `bfoo.test.ts` does not.
function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  if (!longer.endsWith(shorter)) return false;
  const boundary = longer[longer.length - shorter.length - 1];
  return boundary === '/' || boundary === '\\';
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

export function parseRun(raw: RawRun): ParsedRun {
  const consoleText = stripAnsi(raw.consoleText);
  const tests = collapseRetries(parseJunit(raw.junitXml));
  const covIdx = consoleText.search(COVERAGE_HEADER_REGEX);
  const testSection = covIdx >= 0 ? consoleText.slice(0, covIdx) : consoleText;
  const coverageSection = covIdx >= 0 ? consoleText.slice(covIdx) : '';
  const cov = parseCoverage(coverageSection);
  return {
    tests,
    coverageByFile: cov.byFile,
    coverageAll: cov.all,
    coverageTotal: cov.total,
    gaps: cov.gaps,
    failureDetails: matchFailureDetails(tests, extractFailureBlocks(testSection)),
  };
}
