import type {
  BodyCompression,
  BodyFormat,
  CodexTable,
  SourceApp,
  SourceKind,
  SourcePlatform,
  SourceVariantSpec,
  WatermarkKind,
} from 'services/contract/contract.types.ts';

export const VALID_SOURCE_APPS: readonly SourceApp[] = [
  'claude-code',
  'cursor',
  'codex',
  'claude-desktop',
  'gemini',
];

export const VALID_SOURCE_PLATFORMS: readonly SourcePlatform[] = [
  'claude-code-cli',
  'claude-code-desktop',
  'claude-cowork-desktop',
  'codex-cli',
  'codex-desktop',
  'cursor-ide',
  'cursor-cli',
  'antigravity-cli',
  'antigravity-ide',
];

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

// Gemini/Antigravity token capture ships ONLY the content-free `gen_metadata`
// table (token counts + ids, no conversation content). Scoped per-variant so
// this source can never carry a codex table name and vice versa.
export const VALID_GEMINI_TABLES: readonly string[] = ['gen_metadata'];

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
    allowedTables: VALID_CODEX_TABLES,
  },
  {
    sourceApp: 'claude-desktop',
    sourceKind: 'jsonl_append',
    bodyFormat: 'jsonl',
    watermarkKind: 'byte_range',
    watermarkTableRequired: false,
  },
  {
    sourceApp: 'gemini',
    sourceKind: 'jsonl_append',
    bodyFormat: 'jsonl',
    watermarkKind: 'byte_range',
    watermarkTableRequired: false,
  },
  {
    // Gemini token capture: content-free `gen_metadata` rows (base64 proto),
    // stamped with the transcript's source_path so it lands on the same chat.
    sourceApp: 'gemini',
    sourceKind: 'sqlite_table_snapshot',
    bodyFormat: 'sqlite_rows_json',
    watermarkKind: 'rowid_range',
    watermarkTableRequired: true,
    allowedTables: VALID_GEMINI_TABLES,
  },
];

export const BODY_MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;

export const BODY_TARGET_COMPRESSED_BYTES = Math.floor(BODY_MAX_COMPRESSED_BYTES * 0.9);

export const BODY_MAX_DECOMPRESSED_BYTES = 10 * 1024 * 1024;

export const BODY_TARGET_DECOMPRESSED_BYTES = Math.floor(BODY_MAX_DECOMPRESSED_BYTES * 0.9);

export const MAX_SAFE_WATERMARK = Number.MAX_SAFE_INTEGER;

export const DEFAULT_ZSTD_LEVEL = 3;
