import { expect, test } from 'bun:test';

import { localizeStatusJsonTimes } from 'cli/commands/status/build-json.ts';
import { toLocalIsoString } from 'core/utils/format.ts';

test('localizeStatusJsonTimes converts ISO-UTC strings to local ISO, deeply', () => {
  const iso = '2026-05-28T00:00:00.000Z';
  const local = toLocalIsoString(new Date(iso));
  const input = {
    startedAt: iso,
    label: 'claude-code',
    count: 3,
    flag: true,
    nothing: null,
    nested: { lastSuccessAt: iso, note: 'ok' },
    list: [iso, 'not-a-date', 7],
  };
  const expected = {
    startedAt: local,
    label: 'claude-code',
    count: 3,
    flag: true,
    nothing: null,
    nested: { lastSuccessAt: local, note: 'ok' },
    list: [local, 'not-a-date', 7],
  };
  expect(localizeStatusJsonTimes(input)).toEqual(expected);
});

test('localizeStatusJsonTimes leaves regex-matching but invalid timestamps untouched', () => {
  const invalid = '2026-99-99T99:99:99Z';
  expect(localizeStatusJsonTimes(invalid)).toBe(invalid);
});

test('localizeStatusJsonTimes passes through primitives unchanged', () => {
  expect(localizeStatusJsonTimes(42)).toBe(42);
  expect(localizeStatusJsonTimes(null)).toBeNull();
});
