#!/usr/bin/env bun
// Entry point for `bun run test:cov` (and `test:report --no-coverage`). Wires
// the coverage-flow modules:
//   1. run the full suite (serial, coverage + bun --retry for flaky failures)
//   2. re-check flaky coverage GAPS via serial full re-runs        -> retry
//   3. render the debugging-focused report                         -> render
//   4. exit non-zero on genuine test failures or authentic coverage gaps
//
// With --no-coverage (cross-platform CI report runs) coverage measurement and
// the gap re-check are skipped: the report keeps heavy tests, failures with
// diffs, timing, and the summary, and the exit code depends only on genuine
// test failures. Flaky failures are still absorbed by bun's `--retry`. Extra
// CLI args are forwarded to every run.

import { parseRun } from './parse-run.ts';
import { renderReport } from './render.ts';
import { runBunTest } from './run-bun-test.ts';
import { runRetryFlow } from './retry.ts';
import type { RetryOutcome } from './types.ts';

const rawArgs = process.argv.slice(2);
const coverage = !rawArgs.includes('--no-coverage');
const mainArgs = rawArgs.filter((a) => a !== '--no-coverage');

const label = coverage ? 'running full suite (serial)' : 'running full suite (serial, no coverage)';
const mainRaw = await runBunTest(mainArgs, label, coverage);
const main = parseRun(mainRaw);

const noRetry: RetryOutcome = { ran: false, retries: 0, converged: true, gaps: [] };
const retry = coverage
  ? await runRetryFlow(main, {
      rerun: (l) => runBunTest(mainArgs, l, true),
      parse: parseRun,
    })
  : noRetry;

const { text, failing } = renderReport(main, retry, mainRaw.wallClockMs, coverage);
process.stdout.write(text);

process.exit(failing > 0 || !mainRaw.summarySeen ? 1 : 0);
