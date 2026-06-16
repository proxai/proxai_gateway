import { expect, test } from 'bun:test';

import {
  buildScheduledTaskXml,
  defaultScheduledTaskName,
  defaultScheduledTaskXmlPath,
  encodeScheduledTaskXml,
} from 'cli/service-unit/scheduled-task-xml.ts';

test('contains required Task tags', () => {
  const xml = buildScheduledTaskXml({
    programPath: 'C:\\Program Files\\proxai\\proxai-gateway.exe',
  });
  expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>');
  expect(xml).toContain('<Task version="1.2"');
  expect(xml).toContain('<LogonTrigger>');
  expect(xml).toContain('<Principal id="Author">');
  expect(xml).toContain('<Command>C:\\Program Files\\proxai\\proxai-gateway.exe</Command>');
  expect(xml).toContain('<Arguments>&quot;run&quot;</Arguments>');
  expect(xml).toContain('<Count>10</Count>');
});

test('embeds the provided userId in trigger and principal', () => {
  const xml = buildScheduledTaskXml({
    programPath: 'C:\\p.exe',
    userId: 'MYDOMAIN\\testuser',
  });
  expect(xml).toContain('<UserId>MYDOMAIN\\testuser</UserId>');

  const occurrences = xml.split('MYDOMAIN\\testuser').length - 1;
  expect(occurrences).toBe(2);
});

test('falls back to INTERACTIVE when userId not provided', () => {
  const xml = buildScheduledTaskXml({ programPath: 'C:\\p.exe' });
  expect(xml).toContain('<UserId>INTERACTIVE</UserId>');
});

test('quotes each programArg so embedded spaces survive Task Scheduler exec', () => {
  const xml = buildScheduledTaskXml({
    programPath: 'C:\\p.exe',
    programArgs: ['run', '--config', 'C:\\Program Files\\proxai\\cfg.toml'],
  });
  expect(xml).toContain(
    '<Arguments>&quot;run&quot; &quot;--config&quot; &quot;C:\\Program Files\\proxai\\cfg.toml&quot;</Arguments>',
  );
});

test('escapes XML-significant characters in path and userId', () => {
  const xml = buildScheduledTaskXml({
    programPath: 'C:\\p&q<r>.exe',
    userId: 'a&b<c>',
  });
  expect(xml).toContain('C:\\p&amp;q&lt;r&gt;.exe');
  expect(xml).toContain('a&amp;b&lt;c&gt;');
});

test('defaultScheduledTaskName equals constant', () => {
  expect(defaultScheduledTaskName()).toBe('ProxAI Gateway');
});

test('defaultScheduledTaskXmlPath ends with scheduled-task.xml', () => {
  const p = defaultScheduledTaskXmlPath('/some/config/dir');
  expect(p.endsWith('scheduled-task.xml')).toBe(true);
});

test('encodeScheduledTaskXml prepends UTF-16 BOM and uses 2 bytes per char', () => {
  const xml = '<a/>';
  const bytes = encodeScheduledTaskXml(xml);

  expect(bytes.byteLength).toBe(10);

  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xfe);

  expect(bytes[2]).toBe(0x3c);
  expect(bytes[3]).toBe(0x00);
});
