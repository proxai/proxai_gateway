import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { serviceManagerMachine } from 'services/state-machines/service-manager/service-manager.machine.ts';

function start(platform: 'launchd' | 'systemd' | 'windows-task' = 'launchd') {
  const actor = createActor(serviceManagerMachine, { input: { platform } });
  actor.start();
  return actor;
}

test('initial state is not_installed and platform is recorded', () => {
  const actor = start('launchd');
  const s = actor.getSnapshot();
  expect(s.value).toBe('not_installed');
  expect(s.context.platform).toBe('launchd');
  actor.stop();
});

test('full install/start/stop/uninstall cycle visits expected states', () => {
  const actor = start();
  actor.send({ type: 'INSTALL' });
  expect(actor.getSnapshot().value).toBe('installing');
  actor.send({ type: 'INSTALL_COMPLETE' });
  expect(actor.getSnapshot().value).toBe('installed');
  actor.send({ type: 'START' });
  expect(actor.getSnapshot().value).toBe('starting');
  actor.send({ type: 'START_COMPLETE' });
  expect(actor.getSnapshot().value).toBe('running');
  actor.send({ type: 'STOP' });
  expect(actor.getSnapshot().value).toBe('stopping');
  actor.send({ type: 'STOP_COMPLETE' });
  expect(actor.getSnapshot().value).toBe('stopped');
  actor.send({ type: 'UNINSTALL' });
  expect(actor.getSnapshot().value).toBe('uninstalling');
  actor.send({ type: 'UNINSTALL_COMPLETE' });
  expect(actor.getSnapshot().value).toBe('uninstalled');
  actor.stop();
});

test('uninstall from installed (without starting) is allowed', () => {
  const actor = start();
  actor.send({ type: 'INSTALL' });
  actor.send({ type: 'INSTALL_COMPLETE' });
  actor.send({ type: 'UNINSTALL' });
  expect(actor.getSnapshot().value).toBe('uninstalling');
  actor.stop();
});

test('start from stopped restarts the running flow', () => {
  const actor = start();
  actor.send({ type: 'INSTALL' });
  actor.send({ type: 'INSTALL_COMPLETE' });
  actor.send({ type: 'START' });
  actor.send({ type: 'START_COMPLETE' });
  actor.send({ type: 'STOP' });
  actor.send({ type: 'STOP_COMPLETE' });
  actor.send({ type: 'START' });
  expect(actor.getSnapshot().value).toBe('starting');
  actor.stop();
});

test('ERROR from any state moves to failed and records message', () => {
  const actor = start();
  actor.send({ type: 'INSTALL' });
  actor.send({ type: 'ERROR', message: 'permission denied' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('failed');
  expect(s.context.lastError).toBe('permission denied');
  actor.stop();
});

test('failed state can recover by retrying any transition event', () => {
  const actor = start();
  actor.send({ type: 'INSTALL' });
  actor.send({ type: 'ERROR', message: 'permission denied' });
  actor.send({ type: 'INSTALL' });
  expect(actor.getSnapshot().value).toBe('installing');
  actor.stop();
});
