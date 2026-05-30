// Compose the per-concern parsers into one ParsedRun for a RawRun.

import { ANSI_RE, COVERAGE_HEADER_REGEX } from './constants.ts';
import { collapseRetries, parseJunit } from './parse-junit.ts';
import { parseCoverage } from './parse-coverage.ts';
import { extractFailureDetails } from './parse-failures.ts';
import type { ParsedRun, RawRun } from './types.ts';

function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '');
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
    failureDetails: extractFailureDetails(testSection),
  };
}
