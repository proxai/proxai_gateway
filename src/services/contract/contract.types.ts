export type SourceApp = 'claude-code' | 'cursor' | 'codex';

export type SourceKind = 'jsonl_append' | 'sqlite_kv_snapshot' | 'sqlite_table_snapshot';

export type BodyFormat = 'jsonl' | 'kv_pairs_json' | 'sqlite_rows_json';

export type BodyCompression = 'zstd';

export type WatermarkKind = 'byte_range' | 'rowid_range';

export type CodexTable = 'threads' | 'thread_dynamic_tools' | 'thread_spawn_edges';

export interface ByteRangeWatermark {
  kind: 'byte_range';
  start: number;
  end: number;
  table: null;
}

export interface RowidRangeWatermark {
  kind: 'rowid_range';
  start: number;
  end: number;
  table: string | null;
}

export type Watermark = ByteRangeWatermark | RowidRangeWatermark;

export interface SourceVariantSpec {
  sourceApp: SourceApp;
  sourceKind: SourceKind;
  bodyFormat: BodyFormat;
  watermarkKind: WatermarkKind;
  watermarkTableRequired: boolean;
}

export interface RawRecordDTO {
  capture_id: string;
  host_id: string;
  source_app: SourceApp;
  source_kind: SourceKind;
  source_path: string;
  source_path_hash: string;
  source_inode: number | null;
  watermark: Watermark;
  agent_schema_version: string;
  gateway_version: string;
  captured_at_utc: string;
  body_format: BodyFormat;
  body_compression: BodyCompression;
  body: string;
}
