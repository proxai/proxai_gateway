import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import {
  deleteUpgradeRestoreState,
  readUpgradeRestoreState,
  UPGRADE_RESTORE_STATE_FILE,
  writeUpgradeRestoreState,
} from 'services/upgrade/upgrade-restore-state.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-upgrade-restore-state-'));
});

afterEach(async () => {
  await rmRecursive(dir);
}, 30_000);

test('write then read round-trips devWasRunning true', async () => {
  await writeUpgradeRestoreState(dir, { devWasRunning: true });
  expect(readUpgradeRestoreState(dir)).toEqual({ devWasRunning: true });
});

test('write then read round-trips devWasRunning false', async () => {
  await writeUpgradeRestoreState(dir, { devWasRunning: false });
  expect(readUpgradeRestoreState(dir)).toEqual({ devWasRunning: false });
});

test('read returns null when the state file is missing', () => {
  expect(readUpgradeRestoreState(dir)).toBeNull();
});

test('read returns null on corrupt JSON body', () => {
  writeFileSync(join(dir, UPGRADE_RESTORE_STATE_FILE), '{not valid json');
  expect(readUpgradeRestoreState(dir)).toBeNull();
});

test('read returns null when body is not a record', () => {
  writeFileSync(join(dir, UPGRADE_RESTORE_STATE_FILE), JSON.stringify(['array']));
  expect(readUpgradeRestoreState(dir)).toBeNull();
});

test('read returns null when devWasRunning is not a boolean', () => {
  writeFileSync(join(dir, UPGRADE_RESTORE_STATE_FILE), JSON.stringify({ devWasRunning: 'yes' }));
  expect(readUpgradeRestoreState(dir)).toBeNull();
});

test('delete removes the state file', async () => {
  await writeUpgradeRestoreState(dir, { devWasRunning: true });
  expect(existsSync(join(dir, UPGRADE_RESTORE_STATE_FILE))).toBe(true);
  deleteUpgradeRestoreState(dir);
  expect(existsSync(join(dir, UPGRADE_RESTORE_STATE_FILE))).toBe(false);
});

test('delete is a no-op when the state file is already absent', () => {
  deleteUpgradeRestoreState(dir);
  expect(existsSync(join(dir, UPGRADE_RESTORE_STATE_FILE))).toBe(false);
});
