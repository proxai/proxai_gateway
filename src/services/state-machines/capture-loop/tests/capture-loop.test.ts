import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { captureLoopMachine } from 'services/state-machines/capture-loop/capture-loop.machine.ts';

function startLoop() {
  const actor = createActor(captureLoopMachine, { input: { intervalMs: 120_000 } });
  actor.start();
  return actor;
}

test('initial state is waiting with zero counters', () => {
  const actor = startLoop();
  const s = actor.getSnapshot();
  expect(s.value).toBe('waiting');
  expect(s.context.cyclesCompleted).toBe(0);
  expect(s.context.cyclesSkipped).toBe(0);
  actor.stop();
});

test('TICK advances waiting -> evaluating_gate and records start time', () => {
  const actor = startLoop();
  actor.send({ type: 'TICK', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  expect(actor.getSnapshot().value).toBe('evaluating_gate');
  expect(actor.getSnapshot().context.lastCycleAtUtc).toBe('2026-05-25T12:00:00.000Z');
  actor.stop();
});

test('GATE_BLOCKED transitions to skipped and increments cyclesSkipped', () => {
  const actor = startLoop();
  actor.send({ type: 'TICK', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'GATE_BLOCKED', reason: 'auth' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('skipped');
  expect(s.context.cyclesSkipped).toBe(1);
  expect(s.context.lastSkipReason).toBe('auth');
  actor.stop();
});

test('METRICS_PERSISTED from skipped returns to waiting without bumping cyclesCompleted', () => {
  const actor = startLoop();
  actor.send({ type: 'TICK', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'GATE_BLOCKED', reason: 'auth' });
  actor.send({
    type: 'METRICS_PERSISTED',
    finishedAtUtc: '2026-05-25T12:00:01.000Z',
    durationMs: 1000,
  });
  const s = actor.getSnapshot();
  expect(s.value).toBe('waiting');
  expect(s.context.cyclesCompleted).toBe(0);
  expect(s.context.lastCycleDurationMs).toBe(1000);
  actor.stop();
});

test('happy path walks evaluating_gate -> running_cycle -> committing -> checking_pressure -> persisting_metrics -> waiting', () => {
  const actor = startLoop();
  actor.send({ type: 'TICK', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'GATE_CLEAR' });
  expect(actor.getSnapshot().value).toBe('running_cycle');

  actor.send({ type: 'POLL_COMPLETE', batchesEmitted: 3, quarantineEmitted: 0 });
  expect(actor.getSnapshot().value).toBe('committing');

  actor.send({ type: 'COMMITTED' });
  expect(actor.getSnapshot().value).toBe('checking_pressure');

  actor.send({ type: 'PRESSURE_EVALUATED', pendingBytes: 1_000_000, shouldPause: false });
  expect(actor.getSnapshot().value).toBe('persisting_metrics');

  actor.send({
    type: 'METRICS_PERSISTED',
    finishedAtUtc: '2026-05-25T12:00:05.000Z',
    durationMs: 5000,
  });
  const s = actor.getSnapshot();
  expect(s.value).toBe('waiting');
  expect(s.context.cyclesCompleted).toBe(1);
  expect(s.context.lastBatchesEmitted).toBe(3);
  expect(s.context.lastCycleDurationMs).toBe(5000);
  expect(s.context.pendingBytes).toBe(1_000_000);
  expect(s.context.bufferFull).toBe(false);
  actor.stop();
});

test('PRESSURE_EVALUATED with shouldPause=true sets bufferFull flag', () => {
  const actor = startLoop();
  actor.send({ type: 'TICK', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'GATE_CLEAR' });
  actor.send({ type: 'POLL_COMPLETE', batchesEmitted: 0, quarantineEmitted: 0 });
  actor.send({ type: 'COMMITTED' });
  actor.send({ type: 'PRESSURE_EVALUATED', pendingBytes: 60_000_000_000, shouldPause: true });
  expect(actor.getSnapshot().context.bufferFull).toBe(true);
  actor.stop();
});
