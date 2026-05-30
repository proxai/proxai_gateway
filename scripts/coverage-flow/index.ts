#!/usr/bin/env bun
// Entry point for `bun run test:cov`. Wires the coverage-flow modules:
//   1. run the full suite (serial, coverage + bun --retry for flaky failures)
//   2. re-check flaky coverage GAPS via serial full re-runs        -> retry
//   3. render the debugging-focused report                         -> render
//   4. exit non-zero on genuine test failures or authentic coverage gaps
//
// Flaky test failures are absorbed in-process by bun's `--retry`
// (BUN_TEST_BASE_ARGS); coverage-flow's retry covers only flaky coverage gaps,
// which bun cannot re-measure. Extra CLI args are forwarded to every run.

import { parseRun } from './parse-run.ts';
import { renderReport } from './render.ts';
import { runBunTest } from './run-bun-test.ts';
import { runRetryFlow } from './retry.ts';

const mainArgs = process.argv.slice(2);
const mainRaw = await runBunTest(mainArgs, 'running full suite (serial)');
const main = parseRun(mainRaw);

const retry = await runRetryFlow(main, {
  rerun: (label) => runBunTest(mainArgs, label),
  parse: parseRun,
});

const { text, failing } = renderReport(main, retry, mainRaw.wallClockMs);
process.stdout.write(text);

process.exit(failing > 0 || !mainRaw.summarySeen ? 1 : 0);
