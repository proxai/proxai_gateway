import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { autoUpgradeMachine } from 'services/state-machines/auto-upgrade/auto-upgrade.machine.ts';
import type { AutoUpgradeInput } from 'services/state-machines/auto-upgrade/auto-upgrade.types.ts';

function startBrew(): ReturnType<typeof createActor<typeof autoUpgradeMachine>> {
  const input: AutoUpgradeInput = {
    installSource: 'brew',
    currentVersion: '2026.5.1',
    binaryPath: null,
    updateAvailableSentinelPath: '/tmp/UPDATE_AVAILABLE',
  };
  const actor = createActor(autoUpgradeMachine, { input });
  actor.start();
  return actor;
}

function startInPlace(): ReturnType<typeof createActor<typeof autoUpgradeMachine>> {
  const input: AutoUpgradeInput = {
    installSource: 'install-script',
    currentVersion: '2026.5.1',
    binaryPath: '/usr/local/bin/proxai-gateway',
    updateAvailableSentinelPath: null,
  };
  const actor = createActor(autoUpgradeMachine, { input });
  actor.start();
  return actor;
}

function startUnsupported(): ReturnType<typeof createActor<typeof autoUpgradeMachine>> {
  const input: AutoUpgradeInput = {
    installSource: 'install-script',
    currentVersion: '2026.5.1',
    binaryPath: null,
    updateAvailableSentinelPath: null,
  };
  const actor = createActor(autoUpgradeMachine, { input });
  actor.start();
  return actor;
}

test('initial state is idle', () => {
  const actor = startBrew();
  expect(actor.getSnapshot().value).toBe('idle');
  actor.stop();
});

test('brew install source: START routes to brew_branch.fetching_version', () => {
  const actor = startBrew();
  actor.send({ type: 'START' });
  expect(actor.getSnapshot().matches({ brew_branch: 'fetching_version' })).toBe(true);
  actor.stop();
});

test('brew: VERSION_OK_UPDATE_AVAILABLE terminates at update_available -> done', () => {
  const actor = startBrew();
  actor.send({ type: 'START' });
  actor.send({
    type: 'VERSION_OK_UPDATE_AVAILABLE',
    latestVersion: '2026.5.10',
    assetUrl: 'https://example/asset',
  });
  const s = actor.getSnapshot();
  expect(s.value).toBe('done');
  expect(s.context.latestVersion).toBe('2026.5.10');
  expect(s.context.assetUrl).toBe('https://example/asset');
  actor.stop();
});

test('brew: VERSION_OK_NO_UPDATE terminates at up_to_date -> done', () => {
  const actor = startBrew();
  actor.send({ type: 'START' });
  actor.send({ type: 'VERSION_OK_NO_UPDATE', latestVersion: '2026.5.1' });
  expect(actor.getSnapshot().value).toBe('done');
  actor.stop();
});

test('brew: VERSION_NO_RELEASE terminates at no_release -> done', () => {
  const actor = startBrew();
  actor.send({ type: 'START' });
  actor.send({ type: 'VERSION_NO_RELEASE', reason: 'repo has no releases' });
  expect(actor.getSnapshot().value).toBe('done');
  expect(actor.getSnapshot().context.lastError).toBe('repo has no releases');
  actor.stop();
});

test('brew: VERSION_ERROR terminates at error -> done', () => {
  const actor = startBrew();
  actor.send({ type: 'START' });
  actor.send({ type: 'VERSION_ERROR', reason: 'network failure' });
  expect(actor.getSnapshot().value).toBe('done');
  expect(actor.getSnapshot().context.lastError).toBe('network failure');
  actor.stop();
});

test('non-brew with binary path: START routes to in_place_branch.fetching_release_meta', () => {
  const actor = startInPlace();
  actor.send({ type: 'START' });
  expect(actor.getSnapshot().matches({ in_place_branch: 'fetching_release_meta' })).toBe(true);
  actor.stop();
});

test('in_place happy path: fetching_release_meta -> resolving_asset -> downloading -> replacing_binary -> exiting_process -> exited -> done', () => {
  const actor = startInPlace();
  actor.send({ type: 'START' });
  actor.send({
    type: 'VERSION_OK_UPDATE_AVAILABLE',
    latestVersion: '2026.5.10',
    assetUrl: 'https://example/asset',
  });
  expect(actor.getSnapshot().matches({ in_place_branch: 'resolving_asset' })).toBe(true);

  actor.send({ type: 'ASSET_RESOLVED', assetUrl: 'https://example/asset' });
  expect(actor.getSnapshot().matches({ in_place_branch: 'downloading' })).toBe(true);

  actor.send({ type: 'DOWNLOAD_OK', bytes: 12_345_678 });
  expect(actor.getSnapshot().matches({ in_place_branch: 'replacing_binary' })).toBe(true);
  expect(actor.getSnapshot().context.downloadedBytes).toBe(12_345_678);

  actor.send({ type: 'BINARY_REPLACED' });
  expect(actor.getSnapshot().matches({ in_place_branch: 'exiting_process' })).toBe(true);

  actor.send({ type: 'EXIT', exitedAtUtc: '2026-05-25T12:00:00.000Z' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('done');
  expect(s.context.exitedAt).toBe('2026-05-25T12:00:00.000Z');
  actor.stop();
});

test('in_place: VERSION_OK_NO_UPDATE terminates at up_to_date -> done', () => {
  const actor = startInPlace();
  actor.send({ type: 'START' });
  actor.send({ type: 'VERSION_OK_NO_UPDATE', latestVersion: '2026.5.1' });
  expect(actor.getSnapshot().value).toBe('done');
  actor.stop();
});

test('in_place: ASSET_NOT_FOUND terminates at failed -> done', () => {
  const actor = startInPlace();
  actor.send({ type: 'START' });
  actor.send({
    type: 'VERSION_OK_UPDATE_AVAILABLE',
    latestVersion: '2026.5.10',
    assetUrl: null,
  });
  actor.send({ type: 'ASSET_NOT_FOUND' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('done');
  expect(s.context.lastError).toBe('no matching release asset');
  actor.stop();
});

test('in_place: DOWNLOAD_EMPTY terminates at failed -> done', () => {
  const actor = startInPlace();
  actor.send({ type: 'START' });
  actor.send({
    type: 'VERSION_OK_UPDATE_AVAILABLE',
    latestVersion: '2026.5.10',
    assetUrl: 'https://example/asset',
  });
  actor.send({ type: 'ASSET_RESOLVED', assetUrl: 'https://example/asset' });
  actor.send({ type: 'DOWNLOAD_EMPTY' });
  const s = actor.getSnapshot();
  expect(s.value).toBe('done');
  expect(s.context.lastError).toBe('download returned empty body');
  actor.stop();
});

test('non-brew without binary path: START routes directly to done', () => {
  const actor = startUnsupported();
  actor.send({ type: 'START' });
  expect(actor.getSnapshot().value).toBe('done');
  actor.stop();
});
