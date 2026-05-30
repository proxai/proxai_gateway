// Tunables and fixed patterns for the coverage-flow reporter. No logic here.

export const OVERALL_TIMEOUT_MS = 6 * 60 * 1000;
export const GRACE_AFTER_SUMMARY_MS = 15_000;
export const HEARTBEAT_MS = 30_000;
export const TEST_TIMEOUT_MS = 30_000;

// Coverage-gap re-check: how many full serial re-runs before giving up on
// convergence.
export const MAX_RETRIES = 10;

// Flaky test FAILURES are absorbed by bun's native in-process per-test retry:
// it re-runs a failing test in place (real suite context, hooks re-run) and
// reports green if any attempt passes. coverage-flow's own retry handles only
// flaky coverage GAPS, which bun cannot re-measure. N here = extra attempts.
export const FAILURE_RETRY_COUNT = 2;

// A test is "heavy" (and listed) when its share of total test time is >= this.
export const SHARE_THRESHOLD_PCT = 0.2;

export const SUMMARY_REGEX = /Ran \d+ tests across \d+ files/;
export const COVERAGE_HEADER_REGEX = /\|\s*% Funcs\s*\|/;

const ESC = String.fromCharCode(27);
export const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, 'g');
export const CLEAR_LINE = `\r${ESC}[2K`;

// Always serial (never --parallel): bun's parallel coverage merge undercounts
// any source file imported by tests across multiple workers. `--retry` tolerates
// flaky failures in-process, so only flaky coverage gaps reach our retry flow.
export const BUN_TEST_BASE_ARGS = [
  'test',
  '--timeout',
  String(TEST_TIMEOUT_MS),
  '--retry',
  String(FAILURE_RETRY_COUNT),
];

// Added only when coverage is requested. The cross-platform CI report runs
// (test:report --no-coverage) omit it: they want the failure/timing report
// without redundant, per-platform-divergent coverage measurement.
export const COVERAGE_ARG = '--coverage';
