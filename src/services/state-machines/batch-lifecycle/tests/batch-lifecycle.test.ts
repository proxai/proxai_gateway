import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { batchLifecycleMachine } from 'services/state-machines/batch-lifecycle/batch-lifecycle.machine.ts';
import type { BatchIdentity } from 'services/state-machines/batch-lifecycle/batch-lifecycle.types.ts';

const SAMPLE_BATCH: BatchIdentity = {
  captureId: '0192f0e0-0000-7000-8000-000000000001',
  sourceApp: 'claude-code',
  sourcePathHash: 'a'.repeat(64),
  watermarkStart: 0,
  watermarkEnd: 1024,
  compressedBytes: 512,
};

function startActor() {
  const actor = createActor(batchLifecycleMachine, { input: { batch: SAMPLE_BATCH } });
  actor.start();
  return actor;
}

test('initial state is pending with zero attempts', () => {
  const actor = startActor();
  const s = actor.getSnapshot();
  expect(s.value).toBe('pending');
  expect(s.context.attempts).toBe(0);
  expect(s.context.batch).toEqual(SAMPLE_BATCH);
  actor.stop();
});

test('DRAIN_PICKS_UP advances to uploading and increments attempts', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('uploading');
  expect(s.context.attempts).toBe(1);
  actor.stop();
});

test('ACCEPTED transitions uploading -> delivered', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'ACCEPTED', idempotent: false, deliveredAtUtc: '2026-05-25T12:00:00.000Z' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('delivered');
  expect(s.context.idempotentOnServer).toBe(false);
  expect(s.context.deliveredAtUtc).toBe('2026-05-25T12:00:00.000Z');
  actor.stop();
});

test('ACCEPTED with idempotent=true records the flag', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'ACCEPTED', idempotent: true, deliveredAtUtc: '2026-05-25T12:00:00.000Z' });
  expect(actor.getSnapshot().context.idempotentOnServer).toBe(true);
  actor.stop();
});

test('WATERMARK_REGRESSED transitions to recovered (terminal)', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'WATERMARK_REGRESSED', serverWatermarkEnd: 4096 });
  const s = actor.getSnapshot();
  expect(s.value).toBe('recovered');
  expect(s.context.recoveredServerWatermarkEnd).toBe(4096);
  expect(s.status).toBe('done');
  actor.stop();
});

test('VALIDATION_FAILED transitions to failed.validation', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({
    type: 'VALIDATION_FAILED',
    error: 'bad watermark',
    failedAtUtc: '2026-05-25T12:00:00.000Z',
  });
  const s = actor.getSnapshot();
  expect(s.matches({ failed: 'validation' })).toBe(true);
  expect(s.context.lastFailureReason).toBe('validation');
  actor.stop();
});

test('OVERSIZED transitions to failed.oversized', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'OVERSIZED', error: 'too big', failedAtUtc: '2026-05-25T12:00:00.000Z' });
  const s = actor.getSnapshot();
  expect(s.matches({ failed: 'oversized' })).toBe(true);
  expect(s.context.lastFailureReason).toBe('oversized');
  actor.stop();
});

test('UNKNOWN_ERROR transitions to failed.unknown', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'UNKNOWN_ERROR', error: 'mystery', failedAtUtc: '2026-05-25T12:00:00.000Z' });
  const s = actor.getSnapshot();
  expect(s.matches({ failed: 'unknown' })).toBe(true);
  actor.stop();
});

test('AUTH_ERROR transitions to verifying_auth', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'AUTH_ERROR', error: '401' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('verifying_auth');
  expect(s.context.lastError).toBe('401');
  actor.stop();
});

test('VERIFY_THREW_AUTH transitions verifying_auth -> failed.auth_invalid', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'AUTH_ERROR', error: '401' });
  actor.send({
    type: 'VERIFY_THREW_AUTH',
    error: 'definitive',
    failedAtUtc: '2026-05-25T12:00:00.000Z',
  });
  expect(actor.getSnapshot().matches({ failed: 'auth_invalid' })).toBe(true);
  actor.stop();
});

test('VERIFY_SUCCESS_FALSE transitions verifying_auth -> failed.auth_invalid', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'AUTH_ERROR', error: '401' });
  actor.send({
    type: 'VERIFY_SUCCESS_FALSE',
    error: 'rejected',
    failedAtUtc: '2026-05-25T12:00:00.000Z',
  });
  expect(actor.getSnapshot().matches({ failed: 'auth_invalid' })).toBe(true);
  actor.stop();
});

test('VERIFY_SUCCESS_TRUE transitions verifying_auth -> retriable_pending', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'AUTH_ERROR', error: '401' });
  actor.send({ type: 'VERIFY_SUCCESS_TRUE', error: '401' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('retriable_pending');
  expect(s.context.lastRetriableReason).toBe('auth_unconfirmed');
  actor.stop();
});

test('VERIFY_THREW_OTHER transitions verifying_auth -> retriable_pending', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'AUTH_ERROR', error: '401' });
  actor.send({ type: 'VERIFY_THREW_OTHER', error: 'network during verify' });
  expect(actor.getSnapshot().value).toBe('retriable_pending');
  actor.stop();
});

test('RATE_LIMITED transitions uploading -> retriable_pending with retry-after', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'RATE_LIMITED', error: '429', retryAfterMs: 5_000 });
  const s = actor.getSnapshot();
  expect(s.value).toBe('retriable_pending');
  expect(s.context.lastRetriableReason).toBe('rate_limit');
  expect(s.context.retryAfterMs).toBe(5_000);
  actor.stop();
});

test('SERVICE_UNAVAILABLE transitions uploading -> retriable_pending', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'SERVICE_UNAVAILABLE', error: '503', retryAfterMs: null });
  const s = actor.getSnapshot();
  expect(s.value).toBe('retriable_pending');
  expect(s.context.lastRetriableReason).toBe('service_unavailable');
  actor.stop();
});

test('NETWORK_ERROR transitions uploading -> retriable_pending', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'NETWORK_ERROR', error: 'ETIMEDOUT' });
  expect(actor.getSnapshot().context.lastRetriableReason).toBe('network');
  actor.stop();
});

test('RETURN_TO_QUEUE cycles retriable_pending -> pending; next DRAIN_PICKS_UP increments attempts to 2', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'NETWORK_ERROR', error: 'ETIMEDOUT' });
  actor.send({ type: 'RETURN_TO_QUEUE' });
  expect(actor.getSnapshot().value).toBe('pending');
  actor.send({ type: 'DRAIN_PICKS_UP' });
  expect(actor.getSnapshot().context.attempts).toBe(2);
  actor.stop();
});

test('RETENTION_EXPIRED prunes a delivered batch', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'ACCEPTED', idempotent: false, deliveredAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'RETENTION_EXPIRED', prunedAtUtc: '2026-06-25T12:00:00.000Z' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('pruned');
  expect(s.context.prunedAtUtc).toBe('2026-06-25T12:00:00.000Z');
  actor.stop();
});

test('RETENTION_EXPIRED prunes a failed batch from any failure substate', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'VALIDATION_FAILED', error: 'bad', failedAtUtc: '2026-05-25T12:00:00.000Z' });
  actor.send({ type: 'RETENTION_EXPIRED', prunedAtUtc: '2026-06-25T12:00:00.000Z' });
  expect(actor.getSnapshot().value).toBe('pruned');
  actor.stop();
});

test('recovered terminal does not accept RETENTION_EXPIRED (no row to prune)', () => {
  const actor = startActor();
  actor.send({ type: 'DRAIN_PICKS_UP' });
  actor.send({ type: 'WATERMARK_REGRESSED', serverWatermarkEnd: 4096 });
  actor.send({ type: 'RETENTION_EXPIRED', prunedAtUtc: '2026-06-25T12:00:00.000Z' });
  expect(actor.getSnapshot().value).toBe('recovered');
  expect(actor.getSnapshot().context.prunedAtUtc).toBeNull();
  actor.stop();
});
