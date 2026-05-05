import { openReadOnly, snapshotSqlite, tableExists } from 'core/io/sqlite';
import { generateUuidV7, nowIsoUtc, zstdCompressSync } from 'core/utils';
import { getCursor, insertBatch, setCursor } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import { applyStage1 } from 'services/redaction';
import {
  CURSOR_BODY_COMPRESSION,
  CURSOR_BODY_FORMAT,
  CURSOR_DEFAULT_AGENT_SCHEMA_VERSION,
  CURSOR_DISK_KV_TABLE,
  CURSOR_KEY_PREFIX_BUBBLE,
  CURSOR_KEY_PREFIX_COMPOSER,
  CURSOR_SOURCE_APP,
  CURSOR_SOURCE_KIND,
} from 'sources/cursor/cursor.constants.ts';
import type {
  CursorCollectorContext,
  CursorCollectorResult,
  CursorDiskKvRow,
  DiscoveredCursorFile,
} from 'sources/cursor/cursor.types.ts';

const SELECT_ROWS_SQL = `
  SELECT rowid, key, value
  FROM ${CURSOR_DISK_KV_TABLE}
  WHERE rowid > ?
    AND (key LIKE '${CURSOR_KEY_PREFIX_COMPOSER}%' OR key LIKE '${CURSOR_KEY_PREFIX_BUBBLE}%')
  ORDER BY rowid ASC
`;

interface KvRow {
  rowid: number;
  key: string;
  value: string;
}

export async function collectCursorFile(
  file: DiscoveredCursorFile,
  context: CursorCollectorContext,
): Promise<CursorCollectorResult> {
  const result: CursorCollectorResult = {
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  let snapshot: { path: string; cleanup: () => Promise<void> } | null = null;

  try {
    const cursor = getCursor(context.buffer, {
      sourceApp: CURSOR_SOURCE_APP,
      sourcePathHash: file.sourcePathHash,
      sourceInode: null,
      watermarkTable: null,
    });

    const lastMaxRowid = (cursor?.watermarkEnd ?? 1) - 1;

    snapshot = await snapshotSqlite(file.sourcePath);
    const db = openReadOnly(snapshot.path);

    try {
      if (!tableExists(db, CURSOR_DISK_KV_TABLE)) {
        return result;
      }

      const rows = db.query<KvRow, [number]>(SELECT_ROWS_SQL).all(lastMaxRowid);
      if (rows.length === 0) {
        return result;
      }

      const kvRows: CursorDiskKvRow[] = rows.map((r) => ({
        rowid: r.rowid,
        key: r.key,
        value: r.value,
      }));

      const jsonString = JSON.stringify(kvRows);
      const redaction = applyStage1(jsonString);
      const agentSchemaVersion = extractAgentSchemaVersion(kvRows);
      const compressed = zstdCompressSync(redaction.redacted);

      const firstRow = rows[0]!;
      const lastRow = rows[rows.length - 1]!;
      const watermarkStart = firstRow.rowid;
      const watermarkEnd = lastRow.rowid + 1;

      const batch: NewBatch = {
        captureId: generateUuidV7(),
        sourceApp: CURSOR_SOURCE_APP,
        sourceKind: CURSOR_SOURCE_KIND,
        sourcePath: file.sourcePath,
        sourcePathHash: file.sourcePathHash,
        sourceInode: null,
        watermarkKind: 'rowid_range',
        watermarkStart,
        watermarkEnd,
        watermarkTable: null,
        agentSchemaVersion,
        gatewayVersion: context.gatewayVersion,
        capturedAtUtc: nowIsoUtc(),
        bodyFormat: CURSOR_BODY_FORMAT,
        bodyCompression: CURSOR_BODY_COMPRESSION,
        body: compressed,
      };

      insertBatch(context.buffer, batch);

      setCursor(context.buffer, {
        sourceApp: CURSOR_SOURCE_APP,
        sourcePathHash: file.sourcePathHash,
        sourcePath: file.sourcePath,
        sourceInode: null,
        watermarkTable: null,
        watermarkEnd,
      });

      result.capturedBatches = 1;
      result.capturedBytes = compressed.byteLength;
    } finally {
      db.close();
    }
  } catch (err) {
    result.errors.push({
      sourcePath: file.sourcePath,
      reason: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (snapshot !== null) {
      await snapshot.cleanup();
    }
  }

  return result;
}

function extractAgentSchemaVersion(rows: CursorDiskKvRow[]): string {
  let composerVersion: string | null = null;
  let bubbleVersion: string | null = null;

  for (const row of rows) {
    if (composerVersion === null && row.key.startsWith(CURSOR_KEY_PREFIX_COMPOSER)) {
      composerVersion = parseInnerVersion(row.value);
    }
    if (bubbleVersion === null && row.key.startsWith(CURSOR_KEY_PREFIX_BUBBLE)) {
      bubbleVersion = parseInnerVersion(row.value);
    }
    if (composerVersion !== null && bubbleVersion !== null) break;
  }

  if (composerVersion === null && bubbleVersion === null) {
    return CURSOR_DEFAULT_AGENT_SCHEMA_VERSION;
  }
  return `${composerVersion ?? CURSOR_DEFAULT_AGENT_SCHEMA_VERSION}:${bubbleVersion ?? CURSOR_DEFAULT_AGENT_SCHEMA_VERSION}`;
}

function parseInnerVersion(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const v = parsed['_v'];
    if (typeof v === 'number' || typeof v === 'string') {
      return String(v);
    }
    return null;
  } catch {
    return null;
  }
}
