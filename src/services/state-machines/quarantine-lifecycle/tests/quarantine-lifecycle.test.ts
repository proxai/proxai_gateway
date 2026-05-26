import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { quarantineLifecycleMachine } from 'services/state-machines/quarantine-lifecycle/quarantine-lifecycle.machine.ts';
import type { QuarantinedRecord } from 'services/state-machines/quarantine-lifecycle/quarantine-lifecycle.types.ts';

const SAMPLE_RECORD: QuarantinedRecord = {
  sourceApp: 'claude-code',
  sourcePathHash: 'abc123',
  watermarkTable: null,
  watermarkPosition: 4096,
  redactedSizeBytes: 12_000_000,
  reason: 'oversized_decompressed_slice',
  quarantinedAtUtc: '2026-05-01T00:00:00.000Z',
  gatewayVersion: '2026.5.1',
};

test('machine starts in quarantined state with input record', () => {
  const actor = createActor(quarantineLifecycleMachine, { input: { record: SAMPLE_RECORD } });
  actor.start();
  const snapshot = actor.getSnapshot();
  expect(snapshot.value).toBe('quarantined');
  expect(snapshot.context.record).toEqual(SAMPLE_RECORD);
  expect(snapshot.context.prunedAtUtc).toBeNull();
  actor.stop();
});

test('PRUNE event transitions to pruned and records timestamp', () => {
  const actor = createActor(quarantineLifecycleMachine, { input: { record: SAMPLE_RECORD } });
  actor.start();
  actor.send({ type: 'PRUNE', prunedAtUtc: '2026-06-01T00:00:00.000Z' });
  const snapshot = actor.getSnapshot();
  expect(snapshot.value).toBe('pruned');
  expect(snapshot.context.prunedAtUtc).toBe('2026-06-01T00:00:00.000Z');
  expect(snapshot.status).toBe('done');
  actor.stop();
});

test('PRUNE event in pruned state is ignored (final state)', () => {
  const actor = createActor(quarantineLifecycleMachine, { input: { record: SAMPLE_RECORD } });
  actor.start();
  actor.send({ type: 'PRUNE', prunedAtUtc: '2026-06-01T00:00:00.000Z' });
  actor.send({ type: 'PRUNE', prunedAtUtc: '2026-07-01T00:00:00.000Z' });
  const snapshot = actor.getSnapshot();
  expect(snapshot.context.prunedAtUtc).toBe('2026-06-01T00:00:00.000Z');
  actor.stop();
});
