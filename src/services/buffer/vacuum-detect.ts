/**
 * Detects whether a source SQLite database has been VACUUM'd between polls.
 *
 * Vacuum rewrites the file: rowids may be reassigned, the file shrinks, and
 * page_count drops. The rowid-range cursor we keep in `source_cursors` is no
 * longer reliable — captures past the watermark would silently miss rows that
 * now occupy lower rowids. We must re-key the source via the `#gen=N`
 * source_path pattern (see planning/nest-contract.md §6.3) so the server treats
 * it as a fresh stream starting at watermark 0.
 *
 * Three signals are tracked, ANY of which trips re-keying:
 *
 * 1. file size decreased — vacuum reduces file size; growth-only sources never
 *    shrink under normal operation.
 * 2. PRAGMA page_count decreased — vacuum and auto_vacuum reduce page_count.
 *    Belt-and-suspenders against odd filesystems where size tracking lies.
 * 3. max(rowid) + 1 < cursor.watermark_end — direct evidence the rowid space
 *    rotated; this is the symptom we actually care about. We compare the
 *    max rowid against `watermark_end - 1` (the last rowid we successfully
 *    captured) so that quiet polls — where no new rows arrived and
 *    max(rowid) == watermark_end - 1 — are not misdiagnosed as vacuum.
 *
 * On a first-time poll (cursor null or columns NULL on the cursor row), the
 * size/page-count signals can't fire; only rowid regression can — and even
 * that requires watermark_end > max_rowid, which can't happen until at least
 * one prior poll wrote the watermark.
 */
export interface VacuumSignals {
  cursorSizeBytes: number | null;
  cursorPageCount: number | null;
  cursorWatermarkEnd: number;
  currentSizeBytes: number;
  currentPageCount: number;
  currentMaxRowid: number;
}

export type VacuumReason = 'size_decreased' | 'page_count_decreased' | 'rowid_regressed';

export interface VacuumDetectionResult {
  vacuumed: boolean;
  reason: VacuumReason | null;
}

export function detectVacuum(s: VacuumSignals): VacuumDetectionResult {
  if (s.cursorSizeBytes !== null && s.currentSizeBytes < s.cursorSizeBytes) {
    return { vacuumed: true, reason: 'size_decreased' };
  }
  if (s.cursorPageCount !== null && s.currentPageCount < s.cursorPageCount) {
    return { vacuumed: true, reason: 'page_count_decreased' };
  }
  if (s.currentMaxRowid + 1 < s.cursorWatermarkEnd) {
    return { vacuumed: true, reason: 'rowid_regressed' };
  }
  return { vacuumed: false, reason: null };
}
