import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { pacerMachine } from 'services/state-machines/pacer/pacer.machine.ts';
import { PACER_MAX_BACKOFF_STEPS } from 'services/state-machines/pacer/pacer.constants.ts';

function startPacer() {
  const actor = createActor(pacerMachine, {
    input: { maxBatchesPerSec: 10, maxBytesPerMinute: 1_000_000 },
  });
  actor.start();
  return actor;
}

test('initial state is ready with full token buckets', () => {
  const actor = startPacer();
  const s = actor.getSnapshot();
  expect(s.value).toBe('ready');
  expect(s.context.rateTokens).toBe(10);
  expect(s.context.bytesTokens).toBe(1_000_000);
  expect(s.context.rate429Step).toBe(0);
  expect(s.context.rate5xxStep).toBe(0);
  actor.stop();
});

test('ACQUIRE_STARTED transitions ready -> throttling.applying_retry_after', () => {
  const actor = startPacer();
  actor.send({ type: 'ACQUIRE_STARTED', payloadBytes: 1024 });
  const s = actor.getSnapshot();
  expect(s.matches({ throttling: 'applying_retry_after' })).toBe(true);
  expect(s.context.lastAcquireBytes).toBe(1024);
  actor.stop();
});

test('flow walks applying_retry_after -> applying_429 -> applying_5xx -> applying_token_bucket -> debiting -> ready', () => {
  const actor = startPacer();
  actor.send({ type: 'ACQUIRE_STARTED', payloadBytes: 512 });
  expect(actor.getSnapshot().matches({ throttling: 'applying_retry_after' })).toBe(true);

  actor.send({ type: 'ENTER_429_BACKOFF' });
  expect(actor.getSnapshot().matches({ throttling: 'applying_429_backoff' })).toBe(true);

  actor.send({ type: 'ENTER_5XX_BACKOFF' });
  expect(actor.getSnapshot().matches({ throttling: 'applying_5xx_backoff' })).toBe(true);

  actor.send({ type: 'ENTER_TOKEN_BUCKET' });
  expect(actor.getSnapshot().matches({ throttling: 'applying_token_bucket' })).toBe(true);

  actor.send({ type: 'ENTER_DEBITING' });
  expect(actor.getSnapshot().matches({ throttling: 'debiting' })).toBe(true);

  actor.send({ type: 'ACQUIRE_COMPLETE', rateTokens: 9, bytesTokens: 999_488, debitedAtMs: 1000 });
  const s = actor.getSnapshot();
  expect(s.value).toBe('ready');
  expect(s.context.rateTokens).toBe(9);
  expect(s.context.bytesTokens).toBe(999_488);
  expect(s.context.lastDebitedAtMs).toBe(1000);
  actor.stop();
});

test('NOTIFY_429 sets pending flag, applied on next ACQUIRE_STARTED', () => {
  const actor = startPacer();
  actor.send({ type: 'NOTIFY_429' });
  expect(actor.getSnapshot().context.pendingNotify429).toBe(true);
  expect(actor.getSnapshot().context.rate429Step).toBe(0);

  actor.send({ type: 'ACQUIRE_STARTED', payloadBytes: 0 });
  const s = actor.getSnapshot();
  expect(s.context.rate429Step).toBe(1);
  expect(s.context.pendingNotify429).toBe(false);
  actor.stop();
});

test('429 step counter caps at PACER_MAX_BACKOFF_STEPS', () => {
  const actor = startPacer();
  for (let i = 0; i < PACER_MAX_BACKOFF_STEPS + 5; i++) {
    actor.send({ type: 'NOTIFY_429' });
    actor.send({ type: 'ACQUIRE_STARTED', payloadBytes: 0 });
    actor.send({ type: 'ENTER_429_BACKOFF' });
    actor.send({ type: 'ENTER_5XX_BACKOFF' });
    actor.send({ type: 'ENTER_TOKEN_BUCKET' });
    actor.send({ type: 'ENTER_DEBITING' });
    actor.send({
      type: 'ACQUIRE_COMPLETE',
      rateTokens: 10,
      bytesTokens: 1_000_000,
      debitedAtMs: i * 100,
    });
  }
  expect(actor.getSnapshot().context.rate429Step).toBe(PACER_MAX_BACKOFF_STEPS);
  actor.stop();
});

test('ACQUIRE_STARTED with no pending 429 resets step to zero', () => {
  const actor = startPacer();
  actor.send({ type: 'NOTIFY_429' });
  actor.send({ type: 'ACQUIRE_STARTED', payloadBytes: 0 });
  expect(actor.getSnapshot().context.rate429Step).toBe(1);

  actor.send({ type: 'ENTER_429_BACKOFF' });
  actor.send({ type: 'ENTER_5XX_BACKOFF' });
  actor.send({ type: 'ENTER_TOKEN_BUCKET' });
  actor.send({ type: 'ENTER_DEBITING' });
  actor.send({ type: 'ACQUIRE_COMPLETE', rateTokens: 10, bytesTokens: 1_000_000, debitedAtMs: 1 });

  actor.send({ type: 'ACQUIRE_STARTED', payloadBytes: 0 });
  expect(actor.getSnapshot().context.rate429Step).toBe(0);
  actor.stop();
});

test('NOTIFY_5XX with floor takes the max floor seen', () => {
  const actor = startPacer();
  actor.send({ type: 'NOTIFY_5XX', floorMs: 2_000 });
  expect(actor.getSnapshot().context.rate5xxFloorMs).toBe(2_000);
  actor.send({ type: 'NOTIFY_5XX', floorMs: 1_000 });
  expect(actor.getSnapshot().context.rate5xxFloorMs).toBe(2_000);
  actor.send({ type: 'NOTIFY_5XX', floorMs: 5_000 });
  expect(actor.getSnapshot().context.rate5xxFloorMs).toBe(5_000);
  actor.stop();
});

test('NOTIFY_RETRY_AFTER stores the largest absolute future deadline', () => {
  const actor = startPacer();
  actor.send({ type: 'NOTIFY_RETRY_AFTER', untilMs: 10_000 });
  expect(actor.getSnapshot().context.retryAfterUntilMs).toBe(10_000);
  actor.send({ type: 'NOTIFY_RETRY_AFTER', untilMs: 5_000 });
  expect(actor.getSnapshot().context.retryAfterUntilMs).toBe(10_000);
  actor.send({ type: 'NOTIFY_RETRY_AFTER', untilMs: 20_000 });
  expect(actor.getSnapshot().context.retryAfterUntilMs).toBe(20_000);
  actor.stop();
});

test('CLEAR_429_PENDING and CLEAR_5XX_PENDING remove pending flags without affecting step counters', () => {
  const actor = startPacer();
  actor.send({ type: 'NOTIFY_429' });
  actor.send({ type: 'NOTIFY_5XX', floorMs: 2_000 });
  actor.send({ type: 'CLEAR_429_PENDING' });
  actor.send({ type: 'CLEAR_5XX_PENDING' });
  const s = actor.getSnapshot();
  expect(s.context.pendingNotify429).toBe(false);
  expect(s.context.pendingNotify5xx).toBe(false);
  expect(s.context.rate429Step).toBe(0);
  expect(s.context.rate5xxStep).toBe(0);
  actor.stop();
});

test('ACQUIRE_COMPLETE resets retry_after and 5xx floor to null/zero', () => {
  const actor = startPacer();
  actor.send({ type: 'NOTIFY_RETRY_AFTER', untilMs: 10_000 });
  actor.send({ type: 'NOTIFY_5XX', floorMs: 3_000 });
  actor.send({ type: 'ACQUIRE_STARTED', payloadBytes: 0 });
  actor.send({ type: 'ENTER_429_BACKOFF' });
  actor.send({ type: 'ENTER_5XX_BACKOFF' });
  actor.send({ type: 'ENTER_TOKEN_BUCKET' });
  actor.send({ type: 'ENTER_DEBITING' });
  actor.send({ type: 'ACQUIRE_COMPLETE', rateTokens: 10, bytesTokens: 1_000_000, debitedAtMs: 1 });
  const s = actor.getSnapshot();
  expect(s.context.retryAfterUntilMs).toBeNull();
  expect(s.context.rate5xxFloorMs).toBe(0);
  actor.stop();
});
