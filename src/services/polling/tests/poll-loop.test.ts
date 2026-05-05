import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openInMemoryBufferDb } from 'services/buffer';
import { HttpClient } from 'services/http';
import { runPollLoop } from 'services/polling';
import type { PollCycleContext, PollCycleResult, RegisteredSource } from 'services/polling';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-poll-loop-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rm(dir, { recursive: true, force: true });
});

function fakeFetch(): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ accepted: true, idempotent: false, capture_id: 'x' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

function makeContext(sources: RegisteredSource[]): PollCycleContext {
  return {
    buffer,
    http: new HttpClient({
      apiKey: 'pxg_test',
      hostId: 'h_test',
      endpoints: {
        ingest: 'https://api.example.com/v1/raw_records',
        authValidate: 'https://api.example.com/v1/auth/validate',
        health: 'https://api.example.com/v1/health',
        latestVersion: 'https://api.example.com/v1/gateway/latest_version',
        allowedHosts: 'https://api.example.com/v1/api-keys',
      },
      fetch: fakeFetch(),
    }),
    hostId: 'h_test',
    gatewayVersion: 'gw-0.1',
    sources,
    pauseSentinelPath: join(dir, 'PAUSED'),
  };
}

function counter(): { source: RegisteredSource; calls: number } {
  const state = { calls: 0 };
  const source: RegisteredSource = {
    name: 'counter',
    poll: async () => {
      state.calls++;
      return { filesProcessed: 0, capturedBatches: 0, capturedBytes: 0, errors: [] };
    },
  };
  return Object.assign(state, { source });
}

test('exits immediately when abort signal is already aborted', async () => {
  const c = counter();
  const ctrl = new AbortController();
  ctrl.abort();
  await runPollLoop(makeContext([c.source]), { abortSignal: ctrl.signal });
  expect(c.calls).toBe(0);
});

test('runs at least one cycle and stops on abort', async () => {
  const c = counter();
  const ctrl = new AbortController();
  const cycles: PollCycleResult[] = [];
  const promise = runPollLoop(makeContext([c.source]), {
    intervalMs: 5_000,
    abortSignal: ctrl.signal,
    onCycleComplete: (r) => {
      cycles.push(r);
      ctrl.abort();
    },
  });
  await promise;
  expect(c.calls).toBe(1);
  expect(cycles).toHaveLength(1);
});

test('runs multiple cycles until aborted', async () => {
  const c = counter();
  const ctrl = new AbortController();
  let observed = 0;
  const promise = runPollLoop(makeContext([c.source]), {
    intervalMs: 10,
    abortSignal: ctrl.signal,
    onCycleComplete: () => {
      observed++;
      if (observed >= 3) ctrl.abort();
    },
  });
  await promise;
  expect(c.calls).toBeGreaterThanOrEqual(3);
});

test('callback errors do not break the loop', async () => {
  const c = counter();
  const ctrl = new AbortController();
  let observed = 0;
  const promise = runPollLoop(makeContext([c.source]), {
    intervalMs: 5,
    abortSignal: ctrl.signal,
    onCycleComplete: () => {
      observed++;
      if (observed >= 2) ctrl.abort();
      throw new Error('callback boom');
    },
  });
  await promise;
  expect(c.calls).toBeGreaterThanOrEqual(2);
});

test('uses default interval when none provided and exits on abort', async () => {
  const c = counter();
  const ctrl = new AbortController();
  const promise = runPollLoop(makeContext([c.source]), {
    abortSignal: ctrl.signal,
    onCycleComplete: () => {
      ctrl.abort();
    },
  });
  await promise;
  expect(c.calls).toBe(1);
});

test('runs without abort signal but caller ends loop via callback that aborts elsewhere', async () => {
  const c = counter();
  const ctrl = new AbortController();
  await runPollLoop(makeContext([c.source]), {
    intervalMs: 1,
    abortSignal: ctrl.signal,
    onCycleComplete: () => ctrl.abort(),
  });
  expect(c.calls).toBe(1);
});
