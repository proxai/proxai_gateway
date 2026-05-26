#!/usr/bin/env bun
// Runs `bun test --coverage --parallel --timeout 30000` and force-exits after
// the test summary has been printed. Bun's coverage worker pool occasionally
// deadlocks during finalization on GitHub-hosted ubuntu runners — the actual
// tests have already passed by then, so we detect the summary line and give
// the process a short grace period to exit cleanly before sending SIGTERM.
//
// Exit code:
//   - bun's own exit code if it completes naturally
//   - 0 if the summary printed and we force-killed (tests passed)
//   - 1 if the summary printed but contained any '(fail)'
//   - 124 if no summary appeared within OVERALL_TIMEOUT_MS

import { spawn } from 'node:child_process';

const OVERALL_TIMEOUT_MS = 6 * 60 * 1000;
const GRACE_AFTER_SUMMARY_MS = 15_000;
const SUMMARY_REGEX = /Ran \d+ tests across \d+ files/;
const FAILURE_REGEX = /\b\d+ fail\b/;

const child = spawn(
  'bun',
  ['test', '--coverage', '--parallel', '--timeout', '30000', ...process.argv.slice(2)],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

let summarySeen = false;
let sawFailure = false;
let forcedExit = false;
let forcedExitCode = 0;
let buffer = '';
let stderrBuffer = '';

function scan(chunk: string): void {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf('\n');
    if (FAILURE_REGEX.test(line) && !/\b0 fail\b/.test(line)) sawFailure = true;
    if (!summarySeen && SUMMARY_REGEX.test(line)) {
      summarySeen = true;
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          console.error(
            `[run-coverage] summary printed; bun did not exit after ${GRACE_AFTER_SUMMARY_MS.toString()}ms — sending SIGTERM`,
          );
          forcedExit = true;
          forcedExitCode = sawFailure ? 1 : 0;
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGKILL');
            }
          }, 3_000);
        }
      }, GRACE_AFTER_SUMMARY_MS);
    }
  }
}

child.stdout.on('data', (b: Buffer) => {
  const s = b.toString('utf8');
  process.stdout.write(s);
  scan(s);
});
child.stderr.on('data', (b: Buffer) => {
  const s = b.toString('utf8');
  process.stderr.write(s);
  stderrBuffer += s;
  scan(s);
});

const overallTimer = setTimeout(() => {
  if (child.exitCode === null && child.signalCode === null) {
    console.error(
      `[run-coverage] no test summary after ${OVERALL_TIMEOUT_MS.toString()}ms — killing`,
    );
    forcedExit = true;
    forcedExitCode = 124;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3_000);
  }
}, OVERALL_TIMEOUT_MS);

child.on('exit', (code, signal) => {
  clearTimeout(overallTimer);
  void stderrBuffer;
  if (forcedExit) {
    process.exit(forcedExitCode);
  }
  if (signal !== null) {
    process.exit(128 + (signal === 'SIGTERM' ? 15 : 9));
  }
  process.exit(code ?? 0);
});
