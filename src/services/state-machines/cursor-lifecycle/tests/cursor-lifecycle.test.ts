import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { cursorLifecycleMachine } from 'services/state-machines/cursor-lifecycle/cursor-lifecycle.machine.ts';
import type { CursorIdentity } from 'services/state-machines/cursor-lifecycle/cursor-lifecycle.types.ts';

const SAMPLE_IDENTITY: CursorIdentity = {
  sourceApp: 'claude-code',
  sourcePathHash: 'b'.repeat(64),
  sourceInode: 12345,
  watermarkTable: null,
};

function startCursor() {
  const actor = createActor(cursorLifecycleMachine, { input: { identity: SAMPLE_IDENTITY } });
  actor.start();
  return actor;
}

test('initial state is unseeded with zero watermark', () => {
  const actor = startCursor();
  const s = actor.getSnapshot();
  expect(s.value).toBe('unseeded');
  expect(s.context.watermarkEnd).toBe(0);
  expect(s.context.consecutiveErrors).toBe(0);
  expect(s.context.generation).toBe(0);
  actor.stop();
});

test('SYNCED transitions unseeded -> healthy with server watermark', () => {
  const actor = startCursor();
  actor.send({ type: 'SYNCED', watermarkEnd: 4096, polledAtUtc: '2026-05-25T12:00:00.000Z' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('healthy');
  expect(s.context.watermarkEnd).toBe(4096);
  expect(s.context.lastPolledAt).toBe('2026-05-25T12:00:00.000Z');
  actor.stop();
});

test('POLL_SUCCESS from unseeded advances directly to healthy', () => {
  const actor = startCursor();
  actor.send({
    type: 'POLL_SUCCESS',
    watermarkEnd: 8192,
    polledAtUtc: '2026-05-25T12:00:00.000Z',
    lastSeenSizeBytes: 65_536,
    lastSeenPageCount: 16,
  });
  const s = actor.getSnapshot();
  expect(s.value).toBe('healthy');
  expect(s.context.watermarkEnd).toBe(8192);
  actor.stop();
});

test('POLL_SUCCESS in healthy resets consecutiveErrors to zero', () => {
  const actor = startCursor();
  actor.send({ type: 'SYNCED', watermarkEnd: 4096, polledAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'POLL_ERROR', polledAtUtc: '2026-05-25T12:01:00.000Z' });
  actor.send({ type: 'POLL_ERROR', polledAtUtc: '2026-05-25T12:02:00.000Z' });
  expect(actor.getSnapshot().context.consecutiveErrors).toBe(2);
  actor.send({
    type: 'POLL_SUCCESS',
    watermarkEnd: 4200,
    polledAtUtc: '2026-05-25T12:03:00.000Z',
    lastSeenSizeBytes: 65_536,
    lastSeenPageCount: 16,
  });
  expect(actor.getSnapshot().context.consecutiveErrors).toBe(0);
  actor.stop();
});

test('POLL_ERROR in healthy increments consecutiveErrors without changing watermark', () => {
  const actor = startCursor();
  actor.send({ type: 'SYNCED', watermarkEnd: 4096, polledAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'POLL_ERROR', polledAtUtc: '2026-05-25T12:01:00.000Z' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('healthy');
  expect(s.context.consecutiveErrors).toBe(1);
  expect(s.context.watermarkEnd).toBe(4096);
  actor.stop();
});

test('VACUUM_DETECTED transitions healthy -> vacuumed', () => {
  const actor = startCursor();
  actor.send({ type: 'SYNCED', watermarkEnd: 4096, polledAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'VACUUM_DETECTED' });
  expect(actor.getSnapshot().value).toBe('vacuumed');
  actor.stop();
});

test('NEW_GENERATION_CREATED transitions vacuumed -> healthy with reset watermark and bumped generation', () => {
  const actor = startCursor();
  actor.send({ type: 'SYNCED', watermarkEnd: 4096, polledAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'VACUUM_DETECTED' });
  actor.send({ type: 'NEW_GENERATION_CREATED' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('healthy');
  expect(s.context.watermarkEnd).toBe(0);
  expect(s.context.generation).toBe(1);
  expect(s.context.consecutiveErrors).toBe(0);
  actor.stop();
});

test('WATERMARK_REGRESSED transitions healthy -> regressed and stores server watermark', () => {
  const actor = startCursor();
  actor.send({ type: 'SYNCED', watermarkEnd: 8192, polledAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'WATERMARK_REGRESSED', serverWatermarkEnd: 4096 });
  const s = actor.getSnapshot();
  expect(s.value).toBe('regressed');
  expect(s.context.lastServerWatermarkEnd).toBe(4096);
  actor.stop();
});

test('REGRESSION_APPLIED transitions regressed -> healthy and adopts server watermark', () => {
  const actor = startCursor();
  actor.send({ type: 'SYNCED', watermarkEnd: 8192, polledAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'WATERMARK_REGRESSED', serverWatermarkEnd: 4096 });
  actor.send({ type: 'REGRESSION_APPLIED' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('healthy');
  expect(s.context.watermarkEnd).toBe(4096);
  expect(s.context.lastServerWatermarkEnd).toBeNull();
  expect(s.context.consecutiveErrors).toBe(0);
  actor.stop();
});
