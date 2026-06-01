import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAuthRecoveryLoop } from 'services/polling/auth-recovery.ts';
import {
  clearAuthFailedSentinel,
  isAuthFailed,
  readAuthFailedSentinel,
  writeAuthFailedSentinel,
} from 'services/polling/auth-failed-sentinel.ts';

let dir: string;
let sentinelPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-auth-recovery-'));
  sentinelPath = join(dir, 'AUTH_FAILED');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function abortAfter(
  n: number,
  ctrl: AbortController,
): (ms: number, signal?: AbortSignal) => Promise<void> {
  let calls = 0;
  return async (_ms, signal) => {
    calls += 1;
    if (calls >= n) ctrl.abort();
    if (signal?.aborted === true) return;
  };
}

interface Entry {
  level: string;
  msg: string;
}
function fakeLogger(entries: Entry[]): {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
  debug: (...a: unknown[]) => void;
  fatal: (...a: unknown[]) => void;
  trace: (...a: unknown[]) => void;
  child: () => ReturnType<typeof fakeLogger>;
} {
  const rec =
    (level: string) =>
    (...args: unknown[]): void => {
      const last = args[args.length - 1];
      entries.push({ level, msg: typeof last === 'string' ? last : JSON.stringify(last) });
    };
  const logger = {
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    debug: rec('debug'),
    fatal: rec('fatal'),
    trace: rec('trace'),
    child: () => logger,
  };
  return logger;
}

test('clears AUTH_FAILED and resumes when verify-key succeeds', async () => {
  const ctrl = new AbortController();
  await writeAuthFailedSentinel(sentinelPath, 'boom');
  const entries: Entry[] = [];

  await runAuthRecoveryLoop(
    {
      verifyKey: async () => ({ success: true }),
      authFailedSentinelPath: sentinelPath,
      logger: fakeLogger(entries),
    },
    { baseDelayMs: 1, idleMs: 1, abortSignal: ctrl.signal, sleep: abortAfter(3, ctrl) },
  );

  expect(await isAuthFailed(sentinelPath)).toBe(false);
  expect(entries.some((e) => e.level === 'info' && e.msg.includes('re-verified'))).toBe(true);
});

test('retries with backoff and marks exhausted after maxRetries failures', async () => {
  const ctrl = new AbortController();
  await writeAuthFailedSentinel(sentinelPath, 'boom');
  let verifyCalls = 0;
  const entries: Entry[] = [];

  await runAuthRecoveryLoop(
    {
      verifyKey: async () => {
        verifyCalls += 1;
        return { success: false };
      },
      authFailedSentinelPath: sentinelPath,
      logger: fakeLogger(entries),
    },
    {
      baseDelayMs: 1,
      idleMs: 1,
      maxRetries: 3,
      abortSignal: ctrl.signal,
      sleep: abortAfter(25, ctrl),
    },
  );

  expect(verifyCalls).toBe(3);
  const payload = await readAuthFailedSentinel(sentinelPath);
  expect(payload?.retry?.attempts).toBe(3);
  expect(payload?.retry?.maxRetries).toBe(3);
  expect(payload?.retry?.exhausted).toBe(true);
  expect(payload?.retry?.lastError).toBe('gateway key rejected by server');
  // both the non-exhausted ("will retry") and exhausted warns fire
  expect(entries.some((e) => e.level === 'warn' && e.msg.includes('will retry'))).toBe(true);
  expect(entries.some((e) => e.level === 'warn' && e.msg.includes('exhausted'))).toBe(true);
});

test('records the thrown error message when verify-key throws', async () => {
  const ctrl = new AbortController();
  await writeAuthFailedSentinel(sentinelPath, 'boom');

  await runAuthRecoveryLoop(
    {
      verifyKey: async () => {
        throw new Error('nest down');
      },
      authFailedSentinelPath: sentinelPath,
    },
    {
      baseDelayMs: 1,
      idleMs: 1,
      maxRetries: 2,
      abortSignal: ctrl.signal,
      sleep: abortAfter(15, ctrl),
    },
  );

  const payload = await readAuthFailedSentinel(sentinelPath);
  expect(payload?.retry?.lastError).toBe('nest down');
  expect(payload?.retry?.exhausted).toBe(true);
});

test('stringifies a non-Error thrown by verify-key', async () => {
  const ctrl = new AbortController();
  await writeAuthFailedSentinel(sentinelPath, 'boom');

  await runAuthRecoveryLoop(
    {
      verifyKey: async () => {
        throw 'plain-string-failure';
      },
      authFailedSentinelPath: sentinelPath,
    },
    {
      baseDelayMs: 1,
      idleMs: 1,
      maxRetries: 1,
      abortSignal: ctrl.signal,
      sleep: abortAfter(8, ctrl),
    },
  );

  const payload = await readAuthFailedSentinel(sentinelPath);
  expect(payload?.retry?.lastError).toBe('plain-string-failure');
});

test('resets without verifying when AUTH_FAILED clears during the backoff wait', async () => {
  const ctrl = new AbortController();
  await writeAuthFailedSentinel(sentinelPath, 'boom');
  let verifyCalls = 0;
  let sleepCalls = 0;
  const sleep = async (_ms: number, signal?: AbortSignal): Promise<void> => {
    sleepCalls += 1;
    if (sleepCalls === 1) await clearAuthFailedSentinel(sentinelPath);
    if (sleepCalls >= 4) ctrl.abort();
    if (signal?.aborted === true) return;
  };

  await runAuthRecoveryLoop(
    {
      verifyKey: async () => {
        verifyCalls += 1;
        return { success: false };
      },
      authFailedSentinelPath: sentinelPath,
    },
    { baseDelayMs: 1, idleMs: 1, abortSignal: ctrl.signal, sleep },
  );

  expect(verifyCalls).toBe(0);
});

test('returns without verifying when aborted during the backoff wait', async () => {
  const ctrl = new AbortController();
  await writeAuthFailedSentinel(sentinelPath, 'boom');
  let verifyCalls = 0;

  await runAuthRecoveryLoop(
    {
      verifyKey: async () => {
        verifyCalls += 1;
        return { success: true };
      },
      authFailedSentinelPath: sentinelPath,
    },
    {
      baseDelayMs: 1,
      idleMs: 1,
      abortSignal: ctrl.signal,
      sleep: async () => {
        ctrl.abort();
      },
    },
  );

  expect(verifyCalls).toBe(0);
  expect(await isAuthFailed(sentinelPath)).toBe(true);
});

test('idles without verifying while no AUTH_FAILED sentinel is present', async () => {
  const ctrl = new AbortController();
  let verifyCalls = 0;

  await runAuthRecoveryLoop(
    {
      verifyKey: async () => {
        verifyCalls += 1;
        return { success: true };
      },
      authFailedSentinelPath: sentinelPath,
    },
    { baseDelayMs: 1, idleMs: 1, abortSignal: ctrl.signal, sleep: abortAfter(2, ctrl) },
  );

  expect(verifyCalls).toBe(0);
});

test('returns immediately with default options when already aborted', async () => {
  const ctrl = new AbortController();
  ctrl.abort();

  await runAuthRecoveryLoop(
    { verifyKey: async () => ({ success: true }), authFailedSentinelPath: sentinelPath },
    { abortSignal: ctrl.signal },
  );

  expect(await isAuthFailed(sentinelPath)).toBe(false);
});
