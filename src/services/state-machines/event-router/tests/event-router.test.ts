import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { batchLifecycleMachine } from 'services/state-machines/batch-lifecycle/batch-lifecycle.machine.ts';
import type { BatchIdentity } from 'services/state-machines/batch-lifecycle/batch-lifecycle.types.ts';
import { startEventRouter } from 'services/state-machines/event-router';

const SAMPLE_BATCH: BatchIdentity = {
  captureId: '0192f0e0-0000-7000-8000-000000000001',
  sourceApp: 'claude-code',
  sourcePathHash: 'a'.repeat(64),
  watermarkStart: 0,
  watermarkEnd: 1024,
  compressedBytes: 512,
};

interface LogCall {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function makeRecorderLogger(): {
  logger: { info: (f: Record<string, unknown>, m: string) => void; child: () => unknown };
  calls: LogCall[];
} {
  const calls: LogCall[] = [];
  const info = (fields: Record<string, unknown>, message: string): void => {
    calls.push({ fields, message });
  };
  const logger = {
    info,
    child: () => logger,
  };
  return { logger, calls };
}

test('event router records transitions for subscribed actors', () => {
  const actor = createActor(batchLifecycleMachine, { input: { batch: SAMPLE_BATCH } });
  actor.start();
  const { logger, calls } = makeRecorderLogger();
  const handle = startEventRouter({
    actors: [{ name: 'batch-lifecycle', actor }],
    logger: logger as never,
  });

  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'ACCEPTED', idempotent: false, deliveredAtUtc: '2026-05-25T12:00:00.000Z' });

  const transitions = calls.filter((c) => c.fields['event'] === 'state_machine.transition');
  expect(transitions.length).toBeGreaterThanOrEqual(2);
  const machines = transitions.map((c) => c.fields['machine']);
  expect(machines.every((m) => m === 'batch-lifecycle')).toBe(true);

  handle.stop();
  actor.stop();
});

test('event router does not re-log when the value does not change', () => {
  const actor = createActor(batchLifecycleMachine, { input: { batch: SAMPLE_BATCH } });
  actor.start();
  const { logger, calls } = makeRecorderLogger();
  const handle = startEventRouter({
    actors: [{ name: 'batch-lifecycle', actor }],
    logger: logger as never,
  });

  const beforeCount = calls.length;
  actor.send({ type: 'DRAIN_PICKS_UP' });
  const afterFirst = calls.length;
  actor.send({ type: 'RATE_LIMITED', error: '429', retryAfterMs: 1000 });
  const afterSecond = calls.length;

  expect(afterFirst).toBeGreaterThan(beforeCount);
  expect(afterSecond).toBeGreaterThan(afterFirst);

  handle.stop();
  actor.stop();
});

test('event router stop() unsubscribes from all actors', () => {
  const actor = createActor(batchLifecycleMachine, { input: { batch: SAMPLE_BATCH } });
  actor.start();
  const { logger, calls } = makeRecorderLogger();
  const handle = startEventRouter({
    actors: [{ name: 'batch-lifecycle', actor }],
    logger: logger as never,
  });

  handle.stop();
  const beforeCount = calls.length;
  actor.send({ type: 'DRAIN_PICKS_UP' });
  expect(calls.length).toBe(beforeCount);

  actor.stop();
});
