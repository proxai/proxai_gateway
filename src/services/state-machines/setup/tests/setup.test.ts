import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { setupMachine } from 'services/state-machines/setup/setup.machine.ts';

function startSetup() {
  const actor = createActor(setupMachine);
  actor.start();
  return actor;
}

test('initial state is prompting_consent', () => {
  const actor = startSetup();
  expect(actor.getSnapshot().value).toBe('prompting_consent');
  actor.stop();
});

test('CONSENT_DECLINED transitions directly to cancelled (terminal)', () => {
  const actor = startSetup();
  actor.send({ type: 'CONSENT_DECLINED' });
  expect(actor.getSnapshot().value).toBe('cancelled');
  actor.stop();
});

test('happy path: consent -> key -> verify -> config -> sentinel -> done', () => {
  const actor = startSetup();
  actor.send({ type: 'CONSENT_ACCEPTED' });
  expect(actor.getSnapshot().value).toBe('collecting_ingestion_key');
  expect(actor.getSnapshot().context.consentAccepted).toBe(true);

  actor.send({ type: 'KEY_PROVIDED', maskedKey: 'sk_...abc' });
  expect(actor.getSnapshot().value).toBe('verifying_key');

  actor.send({ type: 'KEY_VERIFY_SUCCESS' });
  expect(actor.getSnapshot().value).toBe('writing_config');

  actor.send({ type: 'CONFIG_WRITTEN' });
  expect(actor.getSnapshot().value).toBe('writing_consent_sentinel');

  actor.send({ type: 'SENTINEL_WRITTEN' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('done');
  expect(s.context.keyVerified).toBe(true);
  expect(s.context.configWritten).toBe(true);
  expect(s.context.sentinelWritten).toBe(true);
  actor.stop();
});

test('KEY_VERIFY_FAILURE returns to collecting_ingestion_key and records error', () => {
  const actor = startSetup();
  actor.send({ type: 'CONSENT_ACCEPTED' });
  actor.send({ type: 'KEY_PROVIDED', maskedKey: 'sk_...xxx' });
  actor.send({ type: 'KEY_VERIFY_FAILURE', reason: 'invalid key' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('collecting_ingestion_key');
  expect(s.context.lastError).toBe('invalid key');
  actor.stop();
});

test('ERROR sends machine to failed state', () => {
  const actor = startSetup();
  actor.send({ type: 'CONSENT_ACCEPTED' });
  actor.send({ type: 'ERROR', message: 'something broke' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('failed');
  expect(s.context.lastError).toBe('something broke');
  actor.stop();
});
