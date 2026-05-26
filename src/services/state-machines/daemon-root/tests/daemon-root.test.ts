import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { daemonRootMachine } from 'services/state-machines/daemon-root/daemon-root.machine.ts';

function startDaemon() {
  const actor = createActor(daemonRootMachine);
  actor.start();
  return actor;
}

test('initial state is boot.loading_config', () => {
  const actor = startDaemon();
  expect(actor.getSnapshot().matches({ boot: 'loading_config' })).toBe(true);
  actor.stop();
});

test('boot walks loading_config -> opening_buffer -> sync_decision -> ready, then onDone -> running', () => {
  const actor = startDaemon();
  actor.send({ type: 'CONFIG_LOADED' });
  expect(actor.getSnapshot().matches({ boot: 'opening_buffer' })).toBe(true);
  actor.send({ type: 'BUFFER_OPENED' });
  expect(actor.getSnapshot().matches({ boot: 'sync_decision' })).toBe(true);
  actor.send({ type: 'WATERMARKS_SYNCED' });
  expect(actor.getSnapshot().value).toBe('running');
  expect(actor.getSnapshot().context.watermarksSynced).toBe(true);
  actor.stop();
});

test('WATERMARKS_SKIPPED bypasses syncing and reaches running', () => {
  const actor = startDaemon();
  actor.send({ type: 'CONFIG_LOADED' });
  actor.send({ type: 'BUFFER_OPENED' });
  actor.send({ type: 'WATERMARKS_SKIPPED' });
  expect(actor.getSnapshot().value).toBe('running');
  expect(actor.getSnapshot().context.watermarksSynced).toBe(false);
  actor.stop();
});

test('SHUTDOWN from running transitions to draining_for_shutdown and records reason', () => {
  const actor = startDaemon();
  actor.send({ type: 'CONFIG_LOADED' });
  actor.send({ type: 'BUFFER_OPENED' });
  actor.send({ type: 'WATERMARKS_SYNCED' });
  actor.send({ type: 'SHUTDOWN', reason: 'sigterm' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('draining_for_shutdown');
  expect(s.context.shutdownReason).toBe('sigterm');
  actor.stop();
});

test('EXIT in draining_for_shutdown moves to exited (terminal) and records exitedAtUtc', () => {
  const actor = startDaemon();
  actor.send({ type: 'CONFIG_LOADED' });
  actor.send({ type: 'BUFFER_OPENED' });
  actor.send({ type: 'WATERMARKS_SYNCED' });
  actor.send({ type: 'SHUTDOWN', reason: 'sigterm' });
  actor.send({ type: 'EXIT', exitedAtUtc: '2026-05-25T15:00:00.000Z' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('exited');
  expect(s.context.exitedAtUtc).toBe('2026-05-25T15:00:00.000Z');
  actor.stop();
});

test('DRAIN_FOR_SHUTDOWN_COMPLETE also reaches exited', () => {
  const actor = startDaemon();
  actor.send({ type: 'CONFIG_LOADED' });
  actor.send({ type: 'BUFFER_OPENED' });
  actor.send({ type: 'WATERMARKS_SKIPPED' });
  actor.send({ type: 'SHUTDOWN', reason: 'upgrade' });
  actor.send({ type: 'DRAIN_FOR_SHUTDOWN_COMPLETE' });
  expect(actor.getSnapshot().value).toBe('exited');
  actor.stop();
});
