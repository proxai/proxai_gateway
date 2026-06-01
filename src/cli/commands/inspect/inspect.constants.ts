export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
export const SPINNER_INTERVAL_MS = 80;

export const INSPECT_SOURCES = ['claude-code', 'cursor', 'codex', 'claude-desktop'] as const;

export const INSPECT_MAX_DECOMPRESSED_BYTES = 10 * 1024 * 1024;

export const FALLBACK_COMPRESSION_RATIO = '6.0';

export const TABLE_INNER_WIDTH = 78;

export const DISK_TABLE_SEGMENTS = [16, 10, 11, 14, 12, 10] as const;
export const UPLOAD_TABLE_SEGMENTS = [14, 10, 17, 15, 18] as const;

export const DISK_TITLE = ' TELEMETRY SOURCES ON DISK (HISTORICAL RAW DATA)';
export const UPLOAD_TITLE = ' ESTIMATED UPLOAD METRICS (IF FULLY UPLOADED)';
