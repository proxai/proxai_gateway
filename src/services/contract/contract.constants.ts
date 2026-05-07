import type {
  BodyCompression,
  BodyFormat,
  CodexTable,
  SourceApp,
  SourceKind,
  SourceVariantSpec,
  WatermarkKind,
} from 'services/contract/contract.types.ts';

export const VALID_SOURCE_APPS: readonly SourceApp[] = ['claude-code', 'cursor', 'codex'];

export const VALID_SOURCE_KINDS: readonly SourceKind[] = [
  'jsonl_append',
  'sqlite_kv_snapshot',
  'sqlite_table_snapshot',
];

export const VALID_BODY_FORMATS: readonly BodyFormat[] = [
  'jsonl',
  'kv_pairs_json',
  'sqlite_rows_json',
];

export const VALID_BODY_COMPRESSIONS: readonly BodyCompression[] = ['zstd'];

export const VALID_WATERMARK_KINDS: readonly WatermarkKind[] = ['byte_range', 'rowid_range'];

export const VALID_CODEX_TABLES: readonly CodexTable[] = [
  'threads',
  'thread_dynamic_tools',
  'thread_spawn_edges',
];

export const SOURCE_VARIANTS: readonly SourceVariantSpec[] = [
  {
    sourceApp: 'claude-code',
    sourceKind: 'jsonl_append',
    bodyFormat: 'jsonl',
    watermarkKind: 'byte_range',
    watermarkTableRequired: false,
  },
  {
    sourceApp: 'codex',
    sourceKind: 'jsonl_append',
    bodyFormat: 'jsonl',
    watermarkKind: 'byte_range',
    watermarkTableRequired: false,
  },
  {
    sourceApp: 'cursor',
    sourceKind: 'sqlite_kv_snapshot',
    bodyFormat: 'kv_pairs_json',
    watermarkKind: 'rowid_range',
    watermarkTableRequired: false,
  },
  {
    sourceApp: 'codex',
    sourceKind: 'sqlite_table_snapshot',
    bodyFormat: 'sqlite_rows_json',
    watermarkKind: 'rowid_range',
    watermarkTableRequired: true,
  },
];

export const BODY_MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;

/**
 * Capture-time chunking threshold. The server enforces
 * `BODY_MAX_COMPRESSED_BYTES` as a hard cap; the gateway aims for 90% of that
 * so realistic compression-ratio variation between capture and validation
 * never trips the limit. Slices whose compressed body exceeds this threshold
 * are split at safe boundaries before insertion.
 */
export const BODY_TARGET_COMPRESSED_BYTES = Math.floor(BODY_MAX_COMPRESSED_BYTES * 0.9);

export const BODY_MAX_DECOMPRESSED_BYTES = 10 * 1024 * 1024;

export const MAX_SAFE_WATERMARK = Number.MAX_SAFE_INTEGER;

export const DEFAULT_ZSTD_LEVEL = 3;
