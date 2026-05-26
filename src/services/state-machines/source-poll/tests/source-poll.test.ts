import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { sourcePollMachine } from 'services/state-machines/source-poll/source-poll.machine.ts';

function startPoll() {
  const actor = createActor(sourcePollMachine, { input: { sourceApp: 'claude-code' } });
  actor.start();
  return actor;
}

test('initial state is idle with zeroed counters', () => {
  const actor = startPoll();
  const s = actor.getSnapshot();
  expect(s.value).toBe('idle');
  expect(s.context.filesDiscovered).toBe(0);
  expect(s.context.batchesEmitted).toBe(0);
  actor.stop();
});

test('BEGIN_POLL transitions idle -> discovering and records start time', () => {
  const actor = startPoll();
  actor.send({ type: 'BEGIN_POLL', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('discovering');
  expect(s.context.startedAtUtc).toBe('2026-05-25T12:00:00.000Z');
  actor.stop();
});

test('FILES_FOUND transitions discovering -> processing and records count', () => {
  const actor = startPoll();
  actor.send({ type: 'BEGIN_POLL', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'FILES_FOUND', count: 5 });
  const s = actor.getSnapshot();
  expect(s.value).toBe('processing');
  expect(s.context.filesDiscovered).toBe(5);
  actor.stop();
});

test('NO_FILES transitions discovering -> emitting_results', () => {
  const actor = startPoll();
  actor.send({ type: 'BEGIN_POLL', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'NO_FILES' });
  expect(actor.getSnapshot().value).toBe('emitting_results');
  actor.stop();
});

test('FILE_PROCESSED accumulates counters in processing', () => {
  const actor = startPoll();
  actor.send({ type: 'BEGIN_POLL', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'FILES_FOUND', count: 3 });
  actor.send({ type: 'FILE_PROCESSED', batchesEmitted: 2, quarantineEmitted: 0, cursorUpdates: 1 });
  actor.send({ type: 'FILE_PROCESSED', batchesEmitted: 1, quarantineEmitted: 1, cursorUpdates: 1 });
  const s = actor.getSnapshot();
  expect(s.context.filesProcessed).toBe(2);
  expect(s.context.batchesEmitted).toBe(3);
  expect(s.context.quarantineEmitted).toBe(1);
  expect(s.context.cursorUpdates).toBe(2);
  actor.stop();
});

test('FILE_FAILED records error and increments filesFailed', () => {
  const actor = startPoll();
  actor.send({ type: 'BEGIN_POLL', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'FILES_FOUND', count: 3 });
  actor.send({ type: 'FILE_FAILED', message: 'permission denied' });
  const s = actor.getSnapshot();
  expect(s.context.filesFailed).toBe(1);
  expect(s.context.lastError).toBe('permission denied');
  expect(s.value).toBe('processing');
  actor.stop();
});

test('ALL_FILES_PROCESSED transitions processing -> emitting_results', () => {
  const actor = startPoll();
  actor.send({ type: 'BEGIN_POLL', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'FILES_FOUND', count: 1 });
  actor.send({ type: 'FILE_PROCESSED', batchesEmitted: 1, quarantineEmitted: 0, cursorUpdates: 1 });
  actor.send({ type: 'ALL_FILES_PROCESSED' });
  expect(actor.getSnapshot().value).toBe('emitting_results');
  actor.stop();
});

test('EMIT_COMPLETE transitions emitting_results -> done with finish time', () => {
  const actor = startPoll();
  actor.send({ type: 'BEGIN_POLL', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'NO_FILES' });
  actor.send({ type: 'EMIT_COMPLETE', finishedAtUtc: '2026-05-25T12:00:05.000Z' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('done');
  expect(s.context.finishedAtUtc).toBe('2026-05-25T12:00:05.000Z');
  actor.stop();
});

test('DISCOVERY_ERROR transitions discovering -> errored', () => {
  const actor = startPoll();
  actor.send({ type: 'BEGIN_POLL', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'DISCOVERY_ERROR', message: 'glob failed' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('errored');
  expect(s.context.lastError).toBe('glob failed');
  actor.stop();
});

test('BEGIN_POLL from done resets counters and starts over', () => {
  const actor = startPoll();
  actor.send({ type: 'BEGIN_POLL', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'NO_FILES' });
  actor.send({ type: 'EMIT_COMPLETE', finishedAtUtc: '2026-05-25T12:00:05.000Z' });
  expect(actor.getSnapshot().value).toBe('done');

  actor.send({ type: 'BEGIN_POLL', startedAtUtc: '2026-05-25T12:02:00.000Z' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('discovering');
  expect(s.context.startedAtUtc).toBe('2026-05-25T12:02:00.000Z');
  expect(s.context.finishedAtUtc).toBeNull();
  expect(s.context.batchesEmitted).toBe(0);
  actor.stop();
});

test('BEGIN_POLL from errored resets the cycle', () => {
  const actor = startPoll();
  actor.send({ type: 'BEGIN_POLL', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'DISCOVERY_ERROR', message: 'glob failed' });
  expect(actor.getSnapshot().value).toBe('errored');

  actor.send({ type: 'BEGIN_POLL', startedAtUtc: '2026-05-25T12:02:00.000Z' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('discovering');
  expect(s.context.lastError).toBeNull();
  actor.stop();
});
