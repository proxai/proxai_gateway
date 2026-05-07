import { expect, test } from 'bun:test';

import { buildSystemdUnit, defaultSystemdUnitPath } from 'cli/systemd-unit.ts';

test('emits a [Service] block with ExecStart', () => {
  const unit = buildSystemdUnit({ programPath: '/usr/local/bin/proxai-gateway' });
  expect(unit).toContain('[Service]');
  expect(unit).toContain('ExecStart=/usr/local/bin/proxai-gateway run');
  expect(unit).toContain('Restart=on-failure');
  expect(unit).not.toContain('Restart=always');
  expect(unit).toContain('RestartSec=10s');
});

test('overrides description when provided', () => {
  const unit = buildSystemdUnit({ programPath: '/x', description: 'Custom desc' });
  expect(unit).toContain('Description=Custom desc');
});

test('overrides programArgs when provided', () => {
  const unit = buildSystemdUnit({ programPath: '/x', programArgs: ['run', '--verbose'] });
  expect(unit).toContain('ExecStart=/x run --verbose');
});

test('overrides restartSec when provided', () => {
  const unit = buildSystemdUnit({ programPath: '/x', restartSec: 30 });
  expect(unit).toContain('RestartSec=30s');
});

test('uses defaults when only programPath given', () => {
  const unit = buildSystemdUnit({ programPath: '/x' });
  expect(unit).toContain('Description=ProxAI Gateway');
  expect(unit).toContain('After=network-online.target');
  expect(unit).toContain('WantedBy=default.target');
});

test('defaultSystemdUnitPath ends with default unit name', () => {
  expect(defaultSystemdUnitPath().endsWith('proxai-gateway.service')).toBe(true);
});

test('defaultSystemdUnitPath honors explicit unit name override', () => {
  expect(defaultSystemdUnitPath('alt.service').endsWith('alt.service')).toBe(true);
});
