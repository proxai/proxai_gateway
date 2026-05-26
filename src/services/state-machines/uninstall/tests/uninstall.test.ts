import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { uninstallMachine } from 'services/state-machines/uninstall/uninstall.machine.ts';

function startUninstall(resetMode = false) {
  const actor = createActor(uninstallMachine, { input: { resetMode } });
  actor.start();
  return actor;
}

test('initial state is idle and resetMode is recorded', () => {
  const actor = startUninstall(true);
  const s = actor.getSnapshot();
  expect(s.value).toBe('idle');
  expect(s.context.resetMode).toBe(true);
  actor.stop();
});

test('happy path visits each cleanup phase and reaches done', () => {
  const actor = startUninstall();
  actor.send({ type: 'BEGIN' });
  expect(actor.getSnapshot().value).toBe('stopping_service');

  actor.send({ type: 'SERVICE_STOPPED' });
  expect(actor.getSnapshot().value).toBe('sweeping_paths');
  expect(actor.getSnapshot().context.serviceStopped).toBe(true);

  actor.send({ type: 'PATHS_SWEPT', count: 4 });
  expect(actor.getSnapshot().value).toBe('removing_buffer');
  expect(actor.getSnapshot().context.pathsSwept).toBe(4);

  actor.send({ type: 'BUFFER_REMOVED' });
  expect(actor.getSnapshot().value).toBe('removing_sentinels');
  expect(actor.getSnapshot().context.bufferRemoved).toBe(true);

  actor.send({ type: 'SENTINELS_REMOVED', count: 6 });
  const s = actor.getSnapshot();
  expect(s.value).toBe('done');
  expect(s.context.sentinelsRemoved).toBe(6);
  actor.stop();
});

test('ERROR sends machine to failed and records message', () => {
  const actor = startUninstall();
  actor.send({ type: 'BEGIN' });
  actor.send({ type: 'ERROR', message: 'cannot kill daemon' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('failed');
  expect(s.context.lastError).toBe('cannot kill daemon');
  actor.stop();
});
