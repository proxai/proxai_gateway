import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfigFromFile, loadConfigFromString } from 'services/config';

const minimalToml = `
[account]
api_key = "k"
user_id = "u_1"
host_id = "h"
installed_at = "2026-04-28T22:30:00Z"
install_source = "bun"
`;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-config-loader-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('loadConfigFromString parses a minimal valid config', () => {
  const config = loadConfigFromString(minimalToml);
  expect(config.account.apiKey).toBe('k');
  expect(config.account.hostId).toBe('h');
  expect(config.account.installSource).toBe('bun');
});

test('loadConfigFromString rejects malformed TOML', () => {
  expect(() => loadConfigFromString('this is = not = valid')).toThrow();
});

test('loadConfigFromString rejects empty input (no [account] section)', () => {
  expect(() => loadConfigFromString('')).toThrow();
});

test('loadConfigFromFile rejects a missing file', async () => {
  await expect(loadConfigFromFile(join(dir, 'no-such-file.toml'))).rejects.toThrow();
});

test('loadConfigFromFile reads valid TOML from disk', async () => {
  const filePath = join(dir, 'minimal.toml');
  await Bun.write(filePath, minimalToml);
  const config = await loadConfigFromFile(filePath);
  expect(config.account.apiKey).toBe('k');
});
