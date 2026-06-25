import { expect, test } from 'bun:test';

import type { CursorDiskKvRow } from 'sources/cursor/cursor.types.ts';
import {
  computeCursorSchemaAxes,
  formatAgentSchemaVersion,
} from 'sources/cursor/extract-version.ts';

function row(key: string, value: unknown): CursorDiskKvRow {
  return { rowid: 0, key, value: typeof value === 'string' ? value : JSON.stringify(value) };
}

test('computeCursorSchemaAxes: empty rows -> both null', () => {
  expect(computeCursorSchemaAxes([])).toEqual({ composer: null, bubble: null });
});

test('computeCursorSchemaAxes: MAX composer _v wins, not first', () => {
  const rows = [
    row('composerData:a', { _v: 10 }),
    row('composerData:b', { _v: 16 }),
    row('composerData:c', { _v: 1 }),
  ];
  expect(computeCursorSchemaAxes(rows).composer).toBe('16');
});

test('computeCursorSchemaAxes: MAX bubble _v wins, ancient outlier ignored', () => {
  const rows = [
    row('bubbleId:a:b1', { _v: 2 }),
    row('bubbleId:a:b2', { _v: 3 }),
    row('bubbleId:a:b3', { _v: 2 }),
  ];
  expect(computeCursorSchemaAxes(rows).bubble).toBe('3');
});

test('computeCursorSchemaAxes: unparseable / missing _v rows are skipped', () => {
  const rows = [
    row('composerData:a', 'not json'),
    row('composerData:b', { composerId: 'no-version' }),
    row('composerData:c', { _v: 14 }),
    row('bubbleId:a:b1', { checkpointId: 'x' }),
    row('bubbleId:a:b2', { _v: 3 }),
  ];
  expect(computeCursorSchemaAxes(rows)).toEqual({ composer: '14', bubble: '3' });
});

test('computeCursorSchemaAxes: numeric string _v is coerced', () => {
  expect(computeCursorSchemaAxes([row('bubbleId:a:b1', { _v: '3' })]).bubble).toBe('3');
});

// Acceptance criterion (1) in unit form: a fresh _v=3 bubble + modern composer -> 16:3.
test('compute + format: fresh _v=3 bubble and _v=16 composer -> 16:3', () => {
  const rows = [
    row('composerData:mod', { _v: 16 }),
    row('bubbleId:fresh:b1', { _v: 3, type: 1, text: 'hi' }),
  ];
  const axes = computeCursorSchemaAxes(rows);
  expect(axes).toEqual({ composer: '16', bubble: '3' });
  expect(formatAgentSchemaVersion(axes)).toBe('16:3');
});

test('formatAgentSchemaVersion: both axes present', () => {
  expect(formatAgentSchemaVersion({ composer: '16', bubble: '3' })).toBe('16:3');
});

test('formatAgentSchemaVersion: bubble-only batch falls back to cycle composer', () => {
  expect(formatAgentSchemaVersion({ composer: null, bubble: '3' }, '16')).toBe('16:3');
});

test('formatAgentSchemaVersion: composer-only batch keeps bubble unknown', () => {
  expect(formatAgentSchemaVersion({ composer: '13', bubble: null })).toBe('13:unknown');
});

test('formatAgentSchemaVersion: nothing known -> single "unknown" token', () => {
  expect(formatAgentSchemaVersion({ composer: null, bubble: null })).toBe('unknown');
});

// Rare edge: a cycle with NO composer rows at all (fallback also null) -> 'unknown:3'.
// Unchanged from pre-fix behavior for such files; Cursor records a composer for every bubble.
test('formatAgentSchemaVersion: no composer anywhere -> unknown composer axis', () => {
  expect(formatAgentSchemaVersion({ composer: null, bubble: '3' }, null)).toBe('unknown:3');
});
