import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { sentinelRegistryMachine } from 'services/state-machines/sentinel-registry/sentinel-registry.machine.ts';
import { gateDecision } from 'services/state-machines/sentinel-registry/sentinel-registry.utils.ts';

function startRegistry() {
  const actor = createActor(sentinelRegistryMachine);
  actor.start();
  return actor;
}

test('initial parallel state has all five regions in their absent/ok variants', () => {
  const actor = startRegistry();
  const s = actor.getSnapshot();
  expect(s.matches({ auth: 'absent' })).toBe(true);
  expect(s.matches({ pause: 'absent' })).toBe(true);
  expect(s.matches({ bufferPressure: 'ok' })).toBe(true);
  expect(s.matches({ session: 'live' })).toBe(true);
  expect(s.matches({ brewUpdate: 'unknown' })).toBe(true);
  actor.stop();
});

test('AUTH_FAILED_WRITTEN moves auth region to present and records payload', () => {
  const actor = startRegistry();
  actor.send({
    type: 'AUTH_FAILED_WRITTEN',
    payload: { reason: 'invalid_key', detectedAtUtc: '2026-05-25T12:00:00.000Z' },
  });
  const s = actor.getSnapshot();
  expect(s.matches({ auth: 'present' })).toBe(true);
  expect(s.context.authPayload?.reason).toBe('invalid_key');
  actor.stop();
});

test('AUTH_FAILED_CLEARED returns auth region to absent and clears payload', () => {
  const actor = startRegistry();
  actor.send({
    type: 'AUTH_FAILED_WRITTEN',
    payload: { reason: 'invalid_key', detectedAtUtc: '2026-05-25T12:00:00.000Z' },
  });
  actor.send({ type: 'AUTH_FAILED_CLEARED' });
  const s = actor.getSnapshot();
  expect(s.matches({ auth: 'absent' })).toBe(true);
  expect(s.context.authPayload).toBeNull();
  actor.stop();
});

test('PAUSE_REQUESTED and RESUME_REQUESTED toggle the pause region', () => {
  const actor = startRegistry();
  actor.send({ type: 'PAUSE_REQUESTED', payload: { reason: 'manual' } });
  expect(actor.getSnapshot().matches({ pause: 'present' })).toBe(true);
  expect(actor.getSnapshot().context.pausePayload?.reason).toBe('manual');
  actor.send({ type: 'RESUME_REQUESTED' });
  expect(actor.getSnapshot().matches({ pause: 'absent' })).toBe(true);
  expect(actor.getSnapshot().context.pausePayload).toBeNull();
  actor.stop();
});

test('PRESSURE_CROSSED_PAUSE / PRESSURE_CROSSED_RESUME toggle bufferPressure', () => {
  const actor = startRegistry();
  actor.send({
    type: 'PRESSURE_CROSSED_PAUSE',
    payload: {
      pendingBytes: 60_000_000_000,
      thresholdBytes: 50_000_000_000,
      setAtUtc: '2026-05-25T12:00:00.000Z',
    },
  });
  expect(actor.getSnapshot().matches({ bufferPressure: 'full' })).toBe(true);
  actor.send({ type: 'PRESSURE_CROSSED_RESUME' });
  expect(actor.getSnapshot().matches({ bufferPressure: 'ok' })).toBe(true);
  actor.stop();
});

test('STOP_REQUESTED and BOOT_ID_MISMATCH cycle session region', () => {
  const actor = startRegistry();
  actor.send({
    type: 'STOP_REQUESTED',
    payload: { bootId: 'boot-123', setAtUtc: '2026-05-25T12:00:00.000Z' },
  });
  expect(actor.getSnapshot().matches({ session: 'stopped' })).toBe(true);
  actor.send({ type: 'BOOT_ID_MISMATCH' });
  expect(actor.getSnapshot().matches({ session: 'live' })).toBe(true);
  actor.stop();
});

test('BREW_UPDATE_AVAILABLE then BREW_UP_TO_DATE moves brewUpdate region', () => {
  const actor = startRegistry();
  actor.send({
    type: 'BREW_UPDATE_AVAILABLE',
    payload: {
      latestVersion: '2026.5.10',
      currentVersion: '2026.5.1',
      detectedAtUtc: '2026-05-25T12:00:00.000Z',
      assetUrl: null,
    },
  });
  expect(actor.getSnapshot().matches({ brewUpdate: 'available' })).toBe(true);
  expect(actor.getSnapshot().context.brewLatestKnownVersion).toBe('2026.5.10');
  actor.send({ type: 'BREW_UP_TO_DATE', latestVersion: '2026.5.10' });
  expect(actor.getSnapshot().matches({ brewUpdate: 'up_to_date' })).toBe(true);
  expect(actor.getSnapshot().context.brewUpdatePayload).toBeNull();
  actor.stop();
});

test('regions transition independently of each other', () => {
  const actor = startRegistry();
  actor.send({ type: 'PAUSE_REQUESTED', payload: { reason: 'manual' } });
  actor.send({
    type: 'AUTH_FAILED_WRITTEN',
    payload: { reason: 'invalid_key', detectedAtUtc: '2026-05-25T12:00:00.000Z' },
  });
  const s = actor.getSnapshot();
  expect(s.matches({ pause: 'present' })).toBe(true);
  expect(s.matches({ auth: 'present' })).toBe(true);
  expect(s.matches({ bufferPressure: 'ok' })).toBe(true);
  actor.stop();
});

test('gateDecision returns auth reason when auth payload present (highest priority)', () => {
  const actor = startRegistry();
  actor.send({
    type: 'AUTH_FAILED_WRITTEN',
    payload: { reason: 'invalid_key', detectedAtUtc: '2026-05-25T12:00:00.000Z' },
  });
  actor.send({ type: 'PAUSE_REQUESTED', payload: { reason: 'manual' } });
  const decision = gateDecision(actor.getSnapshot().context);
  expect(decision.reason).toBe('auth');
  expect(decision.skipCapture).toBe(true);
  expect(decision.skipDrain).toBe(true);
  expect(decision.skipHeartbeat).toBe(false);
  actor.stop();
});

test('gateDecision returns paused reason when only pause is present', () => {
  const actor = startRegistry();
  actor.send({ type: 'PAUSE_REQUESTED', payload: { reason: 'manual' } });
  const decision = gateDecision(actor.getSnapshot().context);
  expect(decision.reason).toBe('paused');
  expect(decision.skipHeartbeat).toBe(true);
  actor.stop();
});

test('gateDecision returns buffer_full reason when only pressure is full', () => {
  const actor = startRegistry();
  actor.send({
    type: 'PRESSURE_CROSSED_PAUSE',
    payload: {
      pendingBytes: 60_000_000_000,
      thresholdBytes: 50_000_000_000,
      setAtUtc: '2026-05-25T12:00:00.000Z',
    },
  });
  const decision = gateDecision(actor.getSnapshot().context);
  expect(decision.reason).toBe('buffer_full');
  expect(decision.skipCapture).toBe(true);
  expect(decision.skipDrain).toBe(false);
  expect(decision.skipHeartbeat).toBe(false);
  actor.stop();
});

test('gateDecision returns null reason and no skips when all sentinels are clear', () => {
  const actor = startRegistry();
  const decision = gateDecision(actor.getSnapshot().context);
  expect(decision.reason).toBeNull();
  expect(decision.skipCapture).toBe(false);
  expect(decision.skipDrain).toBe(false);
  expect(decision.skipHeartbeat).toBe(false);
  actor.stop();
});

test('brewUpdate region: unknown -> up_to_date via BREW_UP_TO_DATE then -> available', () => {
  const actor = startRegistry();
  actor.send({ type: 'BREW_UP_TO_DATE', latestVersion: '2026.5.1' });
  expect(actor.getSnapshot().matches({ brewUpdate: 'up_to_date' })).toBe(true);
  expect(actor.getSnapshot().context.brewLatestKnownVersion).toBe('2026.5.1');

  actor.send({
    type: 'BREW_UPDATE_AVAILABLE',
    payload: {
      latestVersion: '2026.5.10',
      currentVersion: '2026.5.1',
      detectedAtUtc: '2026-05-25T12:00:00.000Z',
      assetUrl: 'https://example/asset',
    },
  });
  expect(actor.getSnapshot().matches({ brewUpdate: 'available' })).toBe(true);
  expect(actor.getSnapshot().context.brewUpdatePayload?.assetUrl).toBe('https://example/asset');
  actor.stop();
});

test('brewUpdate region: up_to_date -> unknown via BREW_VERSION_UNKNOWN', () => {
  const actor = startRegistry();
  actor.send({ type: 'BREW_UP_TO_DATE', latestVersion: '2026.5.1' });
  actor.send({ type: 'BREW_VERSION_UNKNOWN' });
  expect(actor.getSnapshot().matches({ brewUpdate: 'unknown' })).toBe(true);
  actor.stop();
});

test('brewUpdate region: available -> unknown via BREW_VERSION_UNKNOWN clears payload', () => {
  const actor = startRegistry();
  actor.send({
    type: 'BREW_UPDATE_AVAILABLE',
    payload: {
      latestVersion: '2026.5.10',
      currentVersion: '2026.5.1',
      detectedAtUtc: '2026-05-25T12:00:00.000Z',
      assetUrl: null,
    },
  });
  expect(actor.getSnapshot().matches({ brewUpdate: 'available' })).toBe(true);
  actor.send({ type: 'BREW_VERSION_UNKNOWN' });
  expect(actor.getSnapshot().matches({ brewUpdate: 'unknown' })).toBe(true);
  expect(actor.getSnapshot().context.brewUpdatePayload).toBeNull();
  actor.stop();
});
