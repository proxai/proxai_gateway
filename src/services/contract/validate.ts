import { isUuidV7, ValidationError } from 'core/utils';
import {
  BODY_MAX_COMPRESSED_BYTES,
  MAX_SAFE_WATERMARK,
  SOURCE_VARIANTS,
  VALID_BODY_COMPRESSIONS,
  VALID_BODY_FORMATS,
  VALID_SOURCE_APPS,
  VALID_SOURCE_KINDS,
  VALID_SOURCE_PLATFORMS,
  VALID_WATERMARK_KINDS,
} from 'services/contract/contract.constants.ts';
import type {
  RawRecordDTO,
  SourceVariantSpec,
  Watermark,
} from 'services/contract/contract.types.ts';

export function validateRawRecordDTO(value: unknown): asserts value is RawRecordDTO {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('DTO must be an object');
  }
  const dto = value as Record<string, unknown>;

  if (!isUuidV7(asString(dto['capture_id'], 'capture_id'))) {
    throw new ValidationError('capture_id must be a UUIDv7');
  }
  asNonEmptyString(dto['host_id'], 'host_id');
  asNonEmptyString(dto['source_path'], 'source_path');
  asNonEmptyString(dto['source_path_hash'], 'source_path_hash');
  asNonEmptyString(dto['agent_schema_version'], 'agent_schema_version');
  asNonEmptyString(dto['gateway_version'], 'gateway_version');

  const sourceApp = dto['source_app'];
  if (!VALID_SOURCE_APPS.includes(sourceApp as never)) {
    throw new ValidationError(`source_app must be one of: ${VALID_SOURCE_APPS.join(', ')}`);
  }
  validateSourcePlatform(dto['source_platform']);
  const sourceKind = dto['source_kind'];
  if (!VALID_SOURCE_KINDS.includes(sourceKind as never)) {
    throw new ValidationError(`source_kind must be one of: ${VALID_SOURCE_KINDS.join(', ')}`);
  }
  const bodyFormat = dto['body_format'];
  if (!VALID_BODY_FORMATS.includes(bodyFormat as never)) {
    throw new ValidationError(`body_format must be one of: ${VALID_BODY_FORMATS.join(', ')}`);
  }
  const bodyCompression = dto['body_compression'];
  if (!VALID_BODY_COMPRESSIONS.includes(bodyCompression as never)) {
    throw new ValidationError(
      `body_compression must be one of: ${VALID_BODY_COMPRESSIONS.join(', ')}`,
    );
  }

  const watermark = dto['watermark'];
  if (typeof watermark !== 'object' || watermark === null) {
    throw new ValidationError('watermark must be an object');
  }
  const wm = watermark as Record<string, unknown>;
  const watermarkKind = wm['kind'];
  if (!VALID_WATERMARK_KINDS.includes(watermarkKind as never)) {
    throw new ValidationError(`watermark.kind must be one of: ${VALID_WATERMARK_KINDS.join(', ')}`);
  }

  const variant = SOURCE_VARIANTS.find(
    (v) =>
      v.sourceApp === sourceApp &&
      v.sourceKind === sourceKind &&
      v.bodyFormat === bodyFormat &&
      v.watermarkKind === watermarkKind,
  );
  if (variant === undefined) {
    throw new ValidationError(
      '(source_app, source_kind, body_format, watermark.kind) tuple is not in the allowed matrix',
    );
  }

  validateWatermark(wm, variant);
  validateSourceInode(dto['source_inode'], variant);
  validateCapturedAtUtc(dto['captured_at_utc']);
  validateBody(dto['body']);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`);
  }
  return value;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function validateSourcePlatform(value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== 'string' || !VALID_SOURCE_PLATFORMS.includes(value as never)) {
    throw new ValidationError(
      `source_platform must be one of: ${VALID_SOURCE_PLATFORMS.join(', ')}`,
    );
  }
}

function validateWatermark(wm: Record<string, unknown>, variant: SourceVariantSpec): Watermark {
  const start = wm['start'];
  const end = wm['end'];
  if (!Number.isInteger(start) || (start as number) < 0) {
    throw new ValidationError('watermark.start must be a non-negative integer');
  }
  if (!Number.isInteger(end) || (end as number) < 0) {
    throw new ValidationError('watermark.end must be a non-negative integer');
  }
  if ((start as number) > MAX_SAFE_WATERMARK || (end as number) > MAX_SAFE_WATERMARK) {
    throw new ValidationError(`watermark values must be <= ${MAX_SAFE_WATERMARK}`);
  }
  if ((start as number) >= (end as number)) {
    throw new ValidationError('watermark.start must be < watermark.end');
  }

  const table = wm['table'];
  if (variant.watermarkKind === 'byte_range') {
    if (table !== null) {
      throw new ValidationError('watermark.table must be null for byte_range');
    }
  } else if (variant.watermarkTableRequired) {
    if (typeof table !== 'string' || table.length === 0) {
      throw new ValidationError('watermark.table is required for sqlite_table_snapshot');
    }
    const allowedTables: readonly string[] = variant.allowedTables ?? [];
    if (!allowedTables.includes(table)) {
      throw new ValidationError(`watermark.table must be one of: ${allowedTables.join(', ')}`);
    }
  } else if (table !== null) {
    throw new ValidationError('watermark.table must be null for sqlite_kv_snapshot');
  }

  const startNum = start as number;
  const endNum = end as number;
  if (variant.watermarkKind === 'byte_range') {
    return { kind: 'byte_range', start: startNum, end: endNum, table: null };
  }
  return { kind: 'rowid_range', start: startNum, end: endNum, table: table as string | null };
}

function validateSourceInode(value: unknown, variant: SourceVariantSpec): void {
  const isSqliteSnapshot =
    variant.sourceKind === 'sqlite_kv_snapshot' || variant.sourceKind === 'sqlite_table_snapshot';
  if (isSqliteSnapshot) {
    if (value !== null) {
      throw new ValidationError('source_inode must be null for sqlite_*_snapshot');
    }
    return;
  }
  if (value === null) return;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ValidationError('source_inode must be a non-negative integer or null');
  }
}

function validateCapturedAtUtc(value: unknown): void {
  if (typeof value !== 'string') {
    throw new ValidationError('captured_at_utc must be a string');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
    throw new ValidationError('captured_at_utc must be ISO 8601 UTC ending with Z');
  }
  if (!Number.isFinite(Date.parse(value))) {
    throw new ValidationError('captured_at_utc is not a parseable date');
  }
}

function validateBody(value: unknown): void {
  if (typeof value !== 'string') {
    throw new ValidationError('body must be a base64 string');
  }
  if (value.length === 0) {
    throw new ValidationError('body must be a non-empty base64 string');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new ValidationError('body must be valid base64');
  }
  if (value.length % 4 !== 0) {
    throw new ValidationError('body length must be a multiple of 4 (valid base64)');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedBytes = (value.length * 3) / 4 - padding;
  if (decodedBytes > BODY_MAX_COMPRESSED_BYTES) {
    throw new ValidationError(
      `body exceeds compressed size limit of ${BODY_MAX_COMPRESSED_BYTES} bytes`,
    );
  }
}
