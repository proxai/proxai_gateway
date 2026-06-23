import { expect, it, test } from 'bun:test';

import { ValidationError } from 'core/utils';
import {
  BODY_MAX_COMPRESSED_BYTES,
  MAX_SAFE_WATERMARK,
  SOURCE_VARIANTS,
  validateRawRecordDTO,
  type RawRecordDTO,
} from 'services/contract';

const VALID_UUIDV7 = '01943f5a-7b1c-7e92-9c01-a0f3b40d77e3';
const VALID_SHA256 = 'a'.repeat(64);
const VALID_BODY = 'aGVsbG8gd29ybGQ=';

function claudeCodeDto(overrides: Partial<RawRecordDTO> = {}): RawRecordDTO {
  return {
    capture_id: VALID_UUIDV7,
    host_id: 'h_test',
    source_app: 'claude-code',
    source_kind: 'jsonl_append',
    source_path: '/Users/test/.claude/projects/example/session.jsonl',
    source_path_hash: VALID_SHA256,
    source_inode: 12345678,
    watermark: { kind: 'byte_range', start: 0, end: 1024, table: null },
    agent_schema_version: '2.1.122',
    gateway_version: '@proxai/gateway 0.1.0',
    captured_at_utc: '2026-04-29T10:42:00.123Z',
    body_format: 'jsonl',
    body_compression: 'zstd',
    body: VALID_BODY,
    ...overrides,
  };
}

function codexRolloutDto(overrides: Partial<RawRecordDTO> = {}): RawRecordDTO {
  return claudeCodeDto({
    source_app: 'codex',
    source_path: '/Users/test/.codex/sessions/2026/04/29/rollout-x.jsonl',
    ...overrides,
  });
}

function cursorDto(overrides: Partial<RawRecordDTO> = {}): RawRecordDTO {
  return {
    capture_id: VALID_UUIDV7,
    host_id: 'h_test',
    source_app: 'cursor',
    source_kind: 'sqlite_kv_snapshot',
    source_path: '/Users/test/Library/Application Support/Cursor/User/globalStorage/state.vscdb',
    source_path_hash: VALID_SHA256,
    source_inode: null,
    watermark: { kind: 'rowid_range', start: 100, end: 200, table: null },
    agent_schema_version: '13:3',
    gateway_version: '@proxai/gateway 0.1.0',
    captured_at_utc: '2026-04-29T10:42:00.123Z',
    body_format: 'kv_pairs_json',
    body_compression: 'zstd',
    body: VALID_BODY,
    ...overrides,
  };
}

function codexThreadsDto(overrides: Partial<RawRecordDTO> = {}): RawRecordDTO {
  return {
    capture_id: VALID_UUIDV7,
    host_id: 'h_test',
    source_app: 'codex',
    source_kind: 'sqlite_table_snapshot',
    source_path: '/Users/test/.codex/state_5.sqlite',
    source_path_hash: VALID_SHA256,
    source_inode: null,
    watermark: { kind: 'rowid_range', start: 1, end: 50, table: 'threads' },
    agent_schema_version: '0.126.0-alpha.8',
    gateway_version: '@proxai/gateway 0.1.0',
    captured_at_utc: '2026-04-29T10:42:00.123Z',
    body_format: 'sqlite_rows_json',
    body_compression: 'zstd',
    body: VALID_BODY,
    ...overrides,
  };
}

test('accepts valid claude-code DTO', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto())).not.toThrow();
});

test('accepts valid codex rollout DTO', () => {
  expect(() => validateRawRecordDTO(codexRolloutDto())).not.toThrow();
});

test('accepts valid cursor DTO', () => {
  expect(() => validateRawRecordDTO(cursorDto())).not.toThrow();
});

test('accepts valid codex threads DTO', () => {
  expect(() => validateRawRecordDTO(codexThreadsDto())).not.toThrow();
});

test('accepts each codex table value', () => {
  for (const table of ['threads', 'thread_dynamic_tools', 'thread_spawn_edges'] as const) {
    expect(() =>
      validateRawRecordDTO(
        codexThreadsDto({ watermark: { kind: 'rowid_range', start: 1, end: 5, table } }),
      ),
    ).not.toThrow();
  }
});

test('accepts a present, valid source_platform', () => {
  for (const sp of [
    'claude-code-cli',
    'claude-code-desktop',
    'claude-cowork-desktop',
    'codex-cli',
    'codex-desktop',
    'cursor-ide',
    'cursor-cli',
  ] as const) {
    expect(() => validateRawRecordDTO(claudeCodeDto({ source_platform: sp }))).not.toThrow();
  }
});

test('accepts an absent source_platform', () => {
  const dto = claudeCodeDto();
  delete (dto as { source_platform?: unknown }).source_platform;
  expect(() => validateRawRecordDTO(dto)).not.toThrow();
});

test('accepts a null source_platform', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ source_platform: null }))).not.toThrow();
});

test('rejects a present, invalid source_platform string', () => {
  expect(() =>
    validateRawRecordDTO(claudeCodeDto({ source_platform: 'codex-ide' as never })),
  ).toThrow(/source_platform/);
});

test('rejects a non-string source_platform', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ source_platform: 42 as never }))).toThrow(
    /source_platform/,
  );
});

test('rejects non-object DTO', () => {
  expect(() => validateRawRecordDTO(null)).toThrow(ValidationError);
  expect(() => validateRawRecordDTO('string')).toThrow(ValidationError);
  expect(() => validateRawRecordDTO([])).toThrow(ValidationError);
});

test('rejects v4 UUID for capture_id', () => {
  expect(() =>
    validateRawRecordDTO(claudeCodeDto({ capture_id: '00000000-0000-4000-8000-000000000000' })),
  ).toThrow(/capture_id/);
});

test('rejects malformed capture_id', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ capture_id: 'not-a-uuid' }))).toThrow(
    /capture_id/,
  );
});

test('rejects empty host_id', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ host_id: '' }))).toThrow(/host_id/);
});

test('rejects invalid source_app', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ source_app: 'antigravity' as never }))).toThrow(
    /source_app/,
  );
});

test('rejects invalid body_compression', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ body_compression: 'gzip' as never }))).toThrow(
    /body_compression/,
  );
});

test('rejects (source_app, source_kind) outside the matrix', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ source_app: 'cursor' as never }))).toThrow(
    /matrix/,
  );
  expect(() =>
    validateRawRecordDTO(claudeCodeDto({ source_kind: 'sqlite_kv_snapshot' as never })),
  ).toThrow(/matrix/);
});

test('rejects watermark.start >= end', () => {
  expect(() =>
    validateRawRecordDTO(
      claudeCodeDto({ watermark: { kind: 'byte_range', start: 100, end: 100, table: null } }),
    ),
  ).toThrow(/start must be < watermark\.end/);
  expect(() =>
    validateRawRecordDTO(
      claudeCodeDto({ watermark: { kind: 'byte_range', start: 200, end: 100, table: null } }),
    ),
  ).toThrow(/start must be < watermark\.end/);
});

test('rejects negative watermark values', () => {
  expect(() =>
    validateRawRecordDTO(
      claudeCodeDto({ watermark: { kind: 'byte_range', start: -1, end: 5, table: null } }),
    ),
  ).toThrow(/watermark\.start/);
});

test('rejects non-integer watermark values', () => {
  expect(() =>
    validateRawRecordDTO(
      claudeCodeDto({ watermark: { kind: 'byte_range', start: 0, end: 1.5, table: null } }),
    ),
  ).toThrow(/watermark\.end/);
});

test('rejects byte_range with non-null table', () => {
  expect(() =>
    validateRawRecordDTO(
      claudeCodeDto({
        watermark: { kind: 'byte_range', start: 0, end: 100, table: 'threads' as never },
      }),
    ),
  ).toThrow(/watermark\.table must be null for byte_range/);
});

test('rejects sqlite_kv_snapshot with non-null table', () => {
  expect(() =>
    validateRawRecordDTO(
      cursorDto({
        watermark: { kind: 'rowid_range', start: 1, end: 5, table: 'threads' },
      }),
    ),
  ).toThrow(/watermark\.table must be null for sqlite_kv_snapshot/);
});

test('rejects sqlite_table_snapshot with missing table', () => {
  expect(() =>
    validateRawRecordDTO(
      codexThreadsDto({
        watermark: { kind: 'rowid_range', start: 1, end: 5, table: null },
      }),
    ),
  ).toThrow(/watermark\.table is required/);
});

test('rejects sqlite_table_snapshot with table outside the allowlist', () => {
  expect(() =>
    validateRawRecordDTO(
      codexThreadsDto({
        watermark: { kind: 'rowid_range', start: 1, end: 5, table: 'auth' },
      }),
    ),
  ).toThrow(/watermark\.table must be one of/);
});

test('rejects non-null source_inode for cursor', () => {
  expect(() => validateRawRecordDTO(cursorDto({ source_inode: 12 as never }))).toThrow(
    /source_inode must be null for sqlite_\*_snapshot/,
  );
});

test('rejects non-null source_inode for codex state', () => {
  expect(() => validateRawRecordDTO(codexThreadsDto({ source_inode: 12 as never }))).toThrow(
    /source_inode/,
  );
});

test('rejects negative source_inode for jsonl_append', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ source_inode: -1 }))).toThrow(/source_inode/);
});

test('accepts null source_inode for jsonl_append', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ source_inode: null }))).not.toThrow();
});

test('rejects body that is not base64', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ body: 'not!valid base64' }))).toThrow(/body/);
});

test('rejects empty body', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ body: '' }))).toThrow(/body/);
});

test('rejects body exceeding compressed size limit', () => {
  const oversized = 'a'.repeat(BODY_MAX_COMPRESSED_BYTES * 2);
  expect(() => validateRawRecordDTO(claudeCodeDto({ body: oversized }))).toThrow(
    /body exceeds compressed size limit/,
  );
});

test('rejects captured_at_utc without Z suffix', () => {
  expect(() =>
    validateRawRecordDTO(claudeCodeDto({ captured_at_utc: '2026-04-29T10:42:00.123' })),
  ).toThrow(/captured_at_utc/);
});

test('rejects captured_at_utc with timezone offset', () => {
  expect(() =>
    validateRawRecordDTO(claudeCodeDto({ captured_at_utc: '2026-04-29T10:42:00.123-08:00' })),
  ).toThrow(/captured_at_utc/);
});

test('rejects captured_at_utc that is not a date', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ captured_at_utc: 'not-a-date' }))).toThrow(
    /captured_at_utc/,
  );
});

test('rejects empty agent_schema_version and gateway_version', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ agent_schema_version: '' }))).toThrow(
    /agent_schema_version/,
  );
  expect(() => validateRawRecordDTO(claudeCodeDto({ gateway_version: '' }))).toThrow(
    /gateway_version/,
  );
});

test('rejects empty source_path and source_path_hash', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ source_path: '' }))).toThrow(/source_path/);
  expect(() => validateRawRecordDTO(claudeCodeDto({ source_path_hash: '' }))).toThrow(
    /source_path_hash/,
  );
});

test('rejects non-string capture_id', () => {
  const dto = claudeCodeDto();
  (dto as { capture_id: unknown }).capture_id = 42;
  expect(() => validateRawRecordDTO(dto)).toThrow(/capture_id/);
});

test('rejects invalid source_kind', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ source_kind: 'csv_dump' as never }))).toThrow(
    /source_kind/,
  );
});

test('rejects invalid body_format', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ body_format: 'msgpack' as never }))).toThrow(
    /body_format/,
  );
});

test('rejects non-object watermark', () => {
  const dto = claudeCodeDto();
  (dto as { watermark: unknown }).watermark = 'byte_range';
  expect(() => validateRawRecordDTO(dto)).toThrow(/watermark must be an object/);
});

test('rejects invalid watermark.kind', () => {
  const dto = claudeCodeDto();
  (dto as { watermark: unknown }).watermark = {
    kind: 'unknown_kind',
    start: 0,
    end: 1,
    table: null,
  };
  expect(() => validateRawRecordDTO(dto)).toThrow(/watermark\.kind/);
});

test('rejects watermark values exceeding MAX_SAFE_WATERMARK', () => {
  expect(() =>
    validateRawRecordDTO(
      claudeCodeDto({
        watermark: { kind: 'byte_range', start: 0, end: MAX_SAFE_WATERMARK + 1, table: null },
      }),
    ),
  ).toThrow(/watermark values must be/);
  expect(() =>
    validateRawRecordDTO(
      claudeCodeDto({
        watermark: {
          kind: 'byte_range',
          start: MAX_SAFE_WATERMARK + 1,
          end: MAX_SAFE_WATERMARK + 2,
          table: null,
        },
      }),
    ),
  ).toThrow(/watermark values must be/);
});

test('rejects non-string captured_at_utc', () => {
  const dto = claudeCodeDto();
  (dto as { captured_at_utc: unknown }).captured_at_utc = 1234567890;
  expect(() => validateRawRecordDTO(dto)).toThrow(/captured_at_utc/);
});

test('rejects captured_at_utc that matches regex but is not a real date', () => {
  expect(() =>
    validateRawRecordDTO(claudeCodeDto({ captured_at_utc: '9999-99-99T99:99:99Z' })),
  ).toThrow(/captured_at_utc/);
});

test('rejects non-string body', () => {
  const dto = claudeCodeDto();
  (dto as { body: unknown }).body = 12345;
  expect(() => validateRawRecordDTO(dto)).toThrow(/body/);
});

test('rejects body whose base64 length is not a multiple of 4', () => {
  expect(() => validateRawRecordDTO(claudeCodeDto({ body: 'abc' }))).toThrow(/body/);
});

it('gemini source variant is jsonl_append/jsonl/byte_range (no watermark table)', () => {
  const v = SOURCE_VARIANTS.find((s) => s.sourceApp === 'gemini');
  expect(v).toMatchObject({
    sourceKind: 'jsonl_append',
    bodyFormat: 'jsonl',
    watermarkKind: 'byte_range',
    watermarkTableRequired: false,
  });
});
