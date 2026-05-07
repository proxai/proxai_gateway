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
