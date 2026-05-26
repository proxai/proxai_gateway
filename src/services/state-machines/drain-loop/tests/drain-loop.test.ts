import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { drainLoopMachine } from 'services/state-machines/drain-loop/drain-loop.machine.ts';

function startLoop() {
  const actor = createActor(drainLoopMachine, { input: { intervalMs: 30_000 } });
  actor.start();
  return actor;
}

test('initial state is waiting', () => {
  const actor = startLoop();
  expect(actor.getSnapshot().value).toBe('waiting');
  actor.stop();
});

test('GATE_BLOCKED transitions to skipped and increments cyclesSkipped', () => {
  const actor = startLoop();
  actor.send({ type: 'TICK', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'GATE_BLOCKED', reason: 'paused' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('skipped');
  expect(s.context.cyclesSkipped).toBe(1);
  expect(s.context.lastSkipReason).toBe('paused');
  actor.stop();
});

test('happy path: evaluating_gate -> draining -> pruning -> checking_resume -> persisting_metrics -> waiting', () => {
  const actor = startLoop();
  actor.send({ type: 'TICK', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'GATE_CLEAR' });
  expect(actor.getSnapshot().value).toBe('draining');

  actor.send({
    type: 'DRAIN_COMPLETE',
    accepted: 10,
    retriable: 1,
    fatal: 0,
    recovered: 0,
    acceptedBytes: 5_000_000,
    consecutiveRetriableBreak: false,
  });
  expect(actor.getSnapshot().value).toBe('pruning');

  actor.send({ type: 'PRUNE_COMPLETE' });
  expect(actor.getSnapshot().value).toBe('checking_resume');

  actor.send({ type: 'RESUME_EVALUATED', clearedBufferFull: true });
  expect(actor.getSnapshot().value).toBe('persisting_metrics');

  actor.send({
    type: 'METRICS_PERSISTED',
    finishedAtUtc: '2026-05-25T12:00:10.000Z',
    durationMs: 10_000,
  });
  const s = actor.getSnapshot();
  expect(s.value).toBe('waiting');
  expect(s.context.cyclesCompleted).toBe(1);
  expect(s.context.lastAccepted).toBe(10);
  expect(s.context.lastAcceptedBytes).toBe(5_000_000);
  expect(s.context.bufferFullCleared).toBe(true);
  actor.stop();
});

test('consecutiveRetriableBreak flag is recorded from DRAIN_COMPLETE', () => {
  const actor = startLoop();
  actor.send({ type: 'TICK', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'GATE_CLEAR' });
  actor.send({
    type: 'DRAIN_COMPLETE',
    accepted: 0,
    retriable: 3,
    fatal: 0,
    recovered: 0,
    acceptedBytes: 0,
    consecutiveRetriableBreak: true,
  });
  expect(actor.getSnapshot().context.consecutiveRetriableBreak).toBe(true);
  actor.stop();
});
