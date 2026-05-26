import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { workerMachine } from 'services/state-machines/worker/worker.machine.ts';

function startWorker() {
  const actor = createActor(workerMachine, {
    input: { sourceApp: 'claude-code', workerId: 'w-1' },
  });
  actor.start();
  return actor;
}

test('initial state is spawned with null timestamps and no result', () => {
  const actor = startWorker();
  const s = actor.getSnapshot();
  expect(s.value).toBe('spawned');
  expect(s.context.startedAtUtc).toBeNull();
  expect(s.context.result).toBeNull();
  actor.stop();
});

test('BEGIN_RUN advances to running and records start time', () => {
  const actor = startWorker();
  actor.send({ type: 'BEGIN_RUN', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('running');
  expect(s.context.startedAtUtc).toBe('2026-05-25T12:00:00.000Z');
  actor.stop();
});

test('RESULT_POSTED advances running -> posting_result and stores result summary', () => {
  const actor = startWorker();
  actor.send({ type: 'BEGIN_RUN', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({
    type: 'RESULT_POSTED',
    result: { batchCount: 5, quarantineCount: 1, cursorCount: 2 },
    finishedAtUtc: '2026-05-25T12:00:05.000Z',
  });
  const s = actor.getSnapshot();
  expect(s.value).toBe('posting_result');
  expect(s.context.result).toEqual({ batchCount: 5, quarantineCount: 1, cursorCount: 2 });
  expect(s.context.finishedAtUtc).toBe('2026-05-25T12:00:05.000Z');
  actor.stop();
});

test('TERMINATE from posting_result reaches terminated terminal', () => {
  const actor = startWorker();
  actor.send({ type: 'BEGIN_RUN', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({
    type: 'RESULT_POSTED',
    result: { batchCount: 0, quarantineCount: 0, cursorCount: 0 },
    finishedAtUtc: '2026-05-25T12:00:05.000Z',
  });
  actor.send({ type: 'TERMINATE' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('terminated');
  expect(s.status).toBe('done');
  actor.stop();
});

test('ERROR in running transitions to errored with message', () => {
  const actor = startWorker();
  actor.send({ type: 'BEGIN_RUN', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({
    type: 'ERROR',
    message: 'discover failed',
    finishedAtUtc: '2026-05-25T12:00:02.000Z',
  });
  const s = actor.getSnapshot();
  expect(s.value).toBe('errored');
  expect(s.context.errorMessage).toBe('discover failed');
  actor.stop();
});

test('TERMINATE from errored reaches terminated terminal', () => {
  const actor = startWorker();
  actor.send({ type: 'BEGIN_RUN', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'ERROR', message: 'boom', finishedAtUtc: '2026-05-25T12:00:02.000Z' });
  actor.send({ type: 'TERMINATE' });
  expect(actor.getSnapshot().value).toBe('terminated');
  actor.stop();
});
