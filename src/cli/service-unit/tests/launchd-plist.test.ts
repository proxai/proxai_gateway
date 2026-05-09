import { expect, test } from 'bun:test';
import { sep as pathSep } from 'node:path';

import { buildLaunchdPlist, defaultLaunchdPlistPath } from 'cli/service-unit/launchd-plist.ts';

test('contains required plist tags and Label', () => {
  const xml = buildLaunchdPlist({ programPath: '/usr/local/bin/proxai-gateway' });
  expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  expect(xml).toContain('<key>Label</key>');
  expect(xml).toContain('<string>co.proxai.gateway</string>');
  expect(xml).toContain('<key>ProgramArguments</key>');
  expect(xml).toContain('<string>/usr/local/bin/proxai-gateway</string>');
  expect(xml).toContain('<string>run</string>');
  expect(xml).toContain('<key>RunAtLoad</key>');
  expect(xml).toContain('<key>KeepAlive</key>');
});

test('KeepAlive is a dict with SuccessfulExit=false (restart only on failure)', () => {
  const xml = buildLaunchdPlist({ programPath: '/x' });
  expect(xml).toContain('<key>KeepAlive</key>');
  expect(xml).toContain('<key>SuccessfulExit</key>');

  const ka = xml.slice(xml.indexOf('<key>KeepAlive</key>'));
  expect(ka).toMatch(
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
  );
  expect(xml).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
});

test('overrides label when provided', () => {
  const xml = buildLaunchdPlist({
    programPath: '/x',
    label: 'co.example.gw',
  });
  expect(xml).toContain('<string>co.example.gw</string>');
});

test('overrides program args when provided', () => {
  const xml = buildLaunchdPlist({
    programPath: '/x',
    programArgs: ['run', '--config', '/etc/cfg.toml'],
  });
  expect(xml).toContain('<string>--config</string>');
  expect(xml).toContain('<string>/etc/cfg.toml</string>');
});

test('emits stdout/stderr blocks when paths provided', () => {
  const xml = buildLaunchdPlist({
    programPath: '/x',
    stdoutPath: '/tmp/out.log',
    stderrPath: '/tmp/err.log',
  });
  expect(xml).toContain('<key>StandardOutPath</key>');
  expect(xml).toContain('<string>/tmp/out.log</string>');
  expect(xml).toContain('<key>StandardErrorPath</key>');
  expect(xml).toContain('<string>/tmp/err.log</string>');
});

test('omits stdout/stderr blocks when not provided', () => {
  const xml = buildLaunchdPlist({ programPath: '/x' });
  expect(xml).not.toContain('StandardOutPath');
  expect(xml).not.toContain('StandardErrorPath');
});

test('escapes special XML characters in paths and label', () => {
  const xml = buildLaunchdPlist({
    programPath: '/path/with <special> & "chars"',
    label: 'l<&>l',
  });
  expect(xml).toContain('&lt;special&gt;');
  expect(xml).toContain('&amp;');
  expect(xml).toContain('&quot;');
  expect(xml).toContain('l&lt;&amp;&gt;l');
});

test('defaultLaunchdPlistPath ends with the label and .plist', () => {
  const path = defaultLaunchdPlistPath();
  expect(path.endsWith('co.proxai.gateway.plist')).toBe(true);
  expect(path).toContain(`Library${pathSep}LaunchAgents`);
});

test('defaultLaunchdPlistPath honors explicit label override', () => {
  expect(defaultLaunchdPlistPath('co.x.y').endsWith('co.x.y.plist')).toBe(true);
});
