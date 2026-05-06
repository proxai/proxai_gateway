import { expect, test } from 'bun:test';

import { detectVacuum } from 'services/buffer';
import type { VacuumSignals } from 'services/buffer';

const HEALTHY_BASE: VacuumSignals = {
  cursorSizeBytes: 1_000_000,
  cursorPageCount: 256,
  cursorWatermarkEnd: 100,
  currentSizeBytes: 1_000_000,
  currentPageCount: 256,
  currentMaxRowid: 200,
};

test('returns vacuumed=false when nothing changed', () => {
  expect(detectVacuum(HEALTHY_BASE)).toEqual({ vacuumed: false, reason: null });
});

test('returns vacuumed=false when only forward progress (size grew, more pages, more rowids)', () => {
  expect(
    detectVacuum({
      ...HEALTHY_BASE,
      currentSizeBytes: 2_000_000,
      currentPageCount: 512,
      currentMaxRowid: 999,
    }),
  ).toEqual({ vacuumed: false, reason: null });
});

test('detects size_decreased and reports it as the reason', () => {
  const result = detectVacuum({
    ...HEALTHY_BASE,
    currentSizeBytes: 999_999,
  });
  expect(result.vacuumed).toBe(true);
  expect(result.reason).toBe('size_decreased');
});

test('detects page_count_decreased and reports it as the reason', () => {
  const result = detectVacuum({
    ...HEALTHY_BASE,
    currentPageCount: 255,
  });
  expect(result.vacuumed).toBe(true);
  expect(result.reason).toBe('page_count_decreased');
});

test('detects rowid_regressed when current max rowid falls below saved watermark_end', () => {
  const result = detectVacuum({
    ...HEALTHY_BASE,
    cursorWatermarkEnd: 500,
    currentMaxRowid: 50,
  });
  expect(result.vacuumed).toBe(true);
  expect(result.reason).toBe('rowid_regressed');
});

test('size_decreased takes priority over page_count and rowid signals', () => {
  const result = detectVacuum({
    ...HEALTHY_BASE,
    currentSizeBytes: 999_999,
    currentPageCount: 1,
    currentMaxRowid: 0,
  });
  expect(result.vacuumed).toBe(true);
  expect(result.reason).toBe('size_decreased');
});

test('page_count_decreased takes priority over rowid signal when size is unchanged', () => {
  const result = detectVacuum({
    ...HEALTHY_BASE,
    currentPageCount: 1,
    currentMaxRowid: 0,
  });
  expect(result.vacuumed).toBe(true);
  expect(result.reason).toBe('page_count_decreased');
});

test('null cursor size means the size signal is suppressed (first-time poll)', () => {
  // currentSizeBytes < cursorSizeBytes can't fire when cursor side is null.
  const result = detectVacuum({
    ...HEALTHY_BASE,
    cursorSizeBytes: null,
    currentSizeBytes: 0,
  });
  expect(result.vacuumed).toBe(false);
});

test('null cursor page count means the page_count signal is suppressed', () => {
  const result = detectVacuum({
    ...HEALTHY_BASE,
    cursorPageCount: null,
    currentPageCount: 0,
  });
  expect(result.vacuumed).toBe(false);
});

test('both cursor columns null and watermark unchanged -> vacuumed=false', () => {
  // First poll after the migration adds the columns; cursor row exists but
  // size/page_count are NULL, and the rowid space has only grown.
  const result = detectVacuum({
    cursorSizeBytes: null,
    cursorPageCount: null,
    cursorWatermarkEnd: 0,
    currentSizeBytes: 1024,
    currentPageCount: 4,
    currentMaxRowid: 0,
  });
  expect(result.vacuumed).toBe(false);
});

test('rowid signal still fires even when size and page_count cursors are null', () => {
  // Belt-and-suspenders: a cursor that pre-dates the size/page_count columns
  // can still get rotated via rowid regression.
  const result = detectVacuum({
    cursorSizeBytes: null,
    cursorPageCount: null,
    cursorWatermarkEnd: 1000,
    currentSizeBytes: 999_999,
    currentPageCount: 999,
    currentMaxRowid: 5,
  });
  expect(result.vacuumed).toBe(true);
  expect(result.reason).toBe('rowid_regressed');
});

test('current_max_rowid equal to watermark_end is healthy (watermark_end is exclusive upper bound)', () => {
  // watermark_end = lastRowid + 1, so when no new rows have arrived since the
  // last poll, currentMaxRowid will be exactly cursorWatermarkEnd - 1; equal
  // is also fine (e.g. one new row arrived after the cursor was written).
  const result = detectVacuum({
    ...HEALTHY_BASE,
    cursorWatermarkEnd: 100,
    currentMaxRowid: 100,
  });
  expect(result.vacuumed).toBe(false);
});

test('current_max_rowid one below watermark_end is healthy (no new rows since last poll)', () => {
  const result = detectVacuum({
    ...HEALTHY_BASE,
    cursorWatermarkEnd: 100,
    currentMaxRowid: 99,
  });
  expect(result.vacuumed).toBe(false);
});

test('current_max_rowid two below watermark_end trips rowid_regressed', () => {
  const result = detectVacuum({
    ...HEALTHY_BASE,
    cursorWatermarkEnd: 100,
    currentMaxRowid: 98,
  });
  expect(result.vacuumed).toBe(true);
  expect(result.reason).toBe('rowid_regressed');
});
