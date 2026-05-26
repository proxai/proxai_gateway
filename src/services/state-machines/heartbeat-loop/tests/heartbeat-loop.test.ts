import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { heartbeatLoopMachine } from 'services/state-machines/heartbeat-loop/heartbeat-loop.machine.ts';

function startLoop() {
  const actor = createActor(heartbeatLoopMachine, {
    input: { intervalMs: 3_600_000, versionCheckIntervalMs: 14_400_000 },
  });
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
  actor.send({ type: 'GATE_BLOCKED' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('skipped');
  expect(s.context.cyclesSkipped).toBe(1);
  actor.stop();
});

test('happy path with throttle allowing and upgrade running: evaluating_gate -> checking_freshness -> throttle_check -> version_check_branch -> persisting_metrics -> waiting', () => {
  const actor = startLoop();
  actor.send({ type: 'TICK', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'GATE_CLEAR' });
  expect(actor.getSnapshot().value).toBe('checking_freshness');

  actor.send({ type: 'FRESHNESS_CHECKED', status: 'fresh' });
  expect(actor.getSnapshot().value).toBe('throttle_check');
  expect(actor.getSnapshot().context.lastFreshness).toBe('fresh');

  actor.send({ type: 'THROTTLE_ALLOWS' });
  expect(actor.getSnapshot().value).toBe('version_check_branch');

  actor.send({
    type: 'VERSION_CHECK_COMPLETE',
    ranAutoUpgrade: true,
    checkedAtUtc: '2026-05-25T12:00:30.000Z',
  });
  expect(actor.getSnapshot().value).toBe('persisting_metrics');

  actor.send({
    type: 'METRICS_PERSISTED',
    finishedAtUtc: '2026-05-25T12:01:00.000Z',
    durationMs: 60_000,
  });
  const s = actor.getSnapshot();
  expect(s.value).toBe('waiting');
  expect(s.context.cyclesCompleted).toBe(1);
  expect(s.context.ranAutoUpgrade).toBe(true);
  expect(s.context.lastVersionCheckAtUtc).toBe('2026-05-25T12:00:30.000Z');
  actor.stop();
});

test('THROTTLE_BLOCKS short-circuits to persisting_metrics without running version check', () => {
  const actor = startLoop();
  actor.send({ type: 'TICK', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'GATE_CLEAR' });
  actor.send({ type: 'FRESHNESS_CHECKED', status: 'fresh' });
  actor.send({ type: 'THROTTLE_BLOCKS' });
  expect(actor.getSnapshot().value).toBe('persisting_metrics');
  actor.send({
    type: 'METRICS_PERSISTED',
    finishedAtUtc: '2026-05-25T12:00:01.000Z',
    durationMs: 1000,
  });
  expect(actor.getSnapshot().value).toBe('waiting');
  expect(actor.getSnapshot().context.cyclesCompleted).toBe(1);
  expect(actor.getSnapshot().context.ranAutoUpgrade).toBe(false);
  actor.stop();
});

test('METRICS_PERSISTED from skipped returns to waiting without bumping cyclesCompleted', () => {
  const actor = startLoop();
  actor.send({ type: 'TICK', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'GATE_BLOCKED' });
  actor.send({
    type: 'METRICS_PERSISTED',
    finishedAtUtc: '2026-05-25T12:00:01.000Z',
    durationMs: 1_000,
  });
  const s = actor.getSnapshot();
  expect(s.value).toBe('waiting');
  expect(s.context.cyclesCompleted).toBe(0);
  expect(s.context.cyclesSkipped).toBe(1);
  expect(s.context.lastCycleDurationMs).toBe(1_000);
  actor.stop();
});

test('FRESHNESS_CHECKED with stale_paused status is recorded in context', () => {
  const actor = startLoop();
  actor.send({ type: 'TICK', startedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'GATE_CLEAR' });
  actor.send({ type: 'FRESHNESS_CHECKED', status: 'stale_paused' });
  expect(actor.getSnapshot().context.lastFreshness).toBe('stale_paused');
  actor.stop();
});
