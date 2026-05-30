// Spawn one `bun test --coverage` (optionally scoped to specific files), capture
// its console + JUnit output, and resolve a RawRun. bun's own output is forced
// plain (NO_COLOR) so the parsers see clean text. Includes the finalization
// hang-guard and a progress indicator (spinner on a TTY, heartbeat in CI).

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUN_TEST_BASE_ARGS,
  CLEAR_LINE,
  COVERAGE_ARG,
  GRACE_AFTER_SUMMARY_MS,
  HEARTBEAT_MS,
  OVERALL_TIMEOUT_MS,
  SUMMARY_REGEX,
} from './constants.ts';
import type { RawRun } from './types.ts';

export function runBunTest(extraArgs: string[], label: string, coverage = true): Promise<RawRun> {
  const junitDir = mkdtempSync(join(tmpdir(), 'proxai-coverage-flow-'));
  const junitPath = join(junitDir, 'junit.xml');
  const child = spawn(
    'bun',
    [
      ...BUN_TEST_BASE_ARGS,
      ...(coverage ? [COVERAGE_ARG] : []),
      '--reporter=junit',
      `--reporter-outfile=${junitPath}`,
      ...extraArgs,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } },
  );

  let captured = '';
  let summarySeen = false;
  let settled = false;
  const startedAt = Date.now();
  const isTty = process.stderr.isTTY === true;

  // Deferred: keep `resolve` out of the Promise executor so it is provably
  // settled exactly once (guarded by `settled`).
  let resolveRun: (run: RawRun) => void = () => undefined;
  const result = new Promise<RawRun>((res) => {
    resolveRun = res;
  });

  const onChunk = (s: string): void => {
    captured += s;
    if (!summarySeen && SUMMARY_REGEX.test(s)) {
      summarySeen = true;
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          }, 3_000);
        }
      }, GRACE_AFTER_SUMMARY_MS);
    }
  };
  child.stdout.on('data', (b: Buffer) => onChunk(b.toString('utf8')));
  child.stderr.on('data', (b: Buffer) => onChunk(b.toString('utf8')));

  let tick = 0;
  const progress = setInterval(
    () => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      if (isTty) {
        process.stderr.write(`\r${label}... ${secs}s`);
      } else if (tick > 0 && tick % (HEARTBEAT_MS / 1000) === 0) {
        process.stderr.write(`[coverage-flow] ${label}... ${secs}s elapsed\n`);
      }
      tick++;
    },
    isTty ? 200 : 1000,
  );

  const overall = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3_000);
    }
  }, OVERALL_TIMEOUT_MS);

  const finish = (code: number | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(overall);
    clearInterval(progress);
    if (isTty) process.stderr.write(CLEAR_LINE);
    let junitXml = '';
    try {
      junitXml = readFileSync(junitPath, 'utf8');
    } catch {
      junitXml = '';
    }
    rmSync(junitDir, { recursive: true, force: true });
    resolveRun({
      junitXml,
      consoleText: captured,
      wallClockMs: Date.now() - startedAt,
      summarySeen,
      exitCode: code,
    });
  };
  child.on('exit', (code) => finish(code));

  return result;
}
