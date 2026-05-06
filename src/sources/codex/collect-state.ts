import type { Database } from 'bun:sqlite';

import { openReadOnly, snapshotSqlite, tableExists } from 'core/io/sqlite';
import { generateUuidV7, nowIsoUtc, zstdCompressSync } from 'core/utils';
import { getCursorWithFallback, insertBatch, setCursor } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import type { CodexTable } from 'services/contract';
import { applyRedaction } from 'services/redaction';
import {
  CODEX_ALLOWED_STATE_TABLES,
  CODEX_BODY_COMPRESSION,
  CODEX_DEFAULT_AGENT_SCHEMA_VERSION,
  CODEX_SOURCE_APP,
  CODEX_STATE_BODY_FORMAT,
  CODEX_STATE_SOURCE_KIND,
  CODEX_THREADS_TABLE,
} from 'sources/codex/codex.constants.ts';
import type {
  CodexCollectorContext,
  CodexCollectorResult,
  CodexStateCollectorResult,
  DiscoveredCodexStateFile,
} from 'sources/codex/codex.types.ts';

export async function collectCodexState(
  file: DiscoveredCodexStateFile,
  context: CodexCollectorContext,
): Promise<CodexStateCollectorResult> {
  const result: CodexCollectorResult = {
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  let snapshot: { path: string; cleanup: () => Promise<void> } | null = null;
  let agentSchemaVersion = CODEX_DEFAULT_AGENT_SCHEMA_VERSION;

  try {
    snapshot = await snapshotSqlite(file.sourcePath);
    const db = openReadOnly(snapshot.path);

    try {
      agentSchemaVersion = sampleCliVersion(db);

      for (const table of CODEX_ALLOWED_STATE_TABLES) {
        try {
          collectOneTable(db, file, context, table, agentSchemaVersion, result);
        } catch (err) {
          result.errors.push({
            sourcePath: file.sourcePath,
            reason: err instanceof Error ? err.message : String(err),
            table,
          });
        }
      }
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

  return { agentSchemaVersion, result };
}

function sampleCliVersion(db: Database): string {
  if (!tableExists(db, CODEX_THREADS_TABLE)) {
    return CODEX_DEFAULT_AGENT_SCHEMA_VERSION;
  }
  try {
    const row = db
      .query<
        { cli_version: string | null },
        []
      >(`SELECT cli_version FROM "${CODEX_THREADS_TABLE}" ORDER BY rowid DESC LIMIT 1`)
      .get();
    if (row !== null && typeof row.cli_version === 'string' && row.cli_version.length > 0) {
      return row.cli_version;
    }
    return CODEX_DEFAULT_AGENT_SCHEMA_VERSION;
  } catch {
    return CODEX_DEFAULT_AGENT_SCHEMA_VERSION;
  }
}

function collectOneTable(
  db: Database,
  file: DiscoveredCodexStateFile,
  context: CodexCollectorContext,
  table: CodexTable,
  agentSchemaVersion: string,
  result: CodexCollectorResult,
): void {
  if (!tableExists(db, table)) return;

  const cursor = getCursorWithFallback(context.buffer, {
    sourceApp: CODEX_SOURCE_APP,
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: table,
  });
  const lastMaxRowid = (cursor?.watermarkEnd ?? 1) - 1;

  const escaped = table.replace(/"/g, '""');
  const rows = db
    .query<
      Record<string, unknown> & { rowid: number },
      [number]
    >(`SELECT rowid, * FROM "${escaped}" WHERE rowid > ? ORDER BY rowid ASC`)
    .all(lastMaxRowid);
  if (rows.length === 0) return;

  const jsonString = JSON.stringify(rows);
  const redaction = applyRedaction(jsonString);
  const compressed = zstdCompressSync(redaction.redacted);

  const firstRow = rows[0]!;
  const lastRow = rows[rows.length - 1]!;
  const watermarkStart = firstRow.rowid;
  const watermarkEnd = lastRow.rowid + 1;

  const batch: NewBatch = {
    captureId: generateUuidV7(),
    sourceApp: CODEX_SOURCE_APP,
    sourceKind: CODEX_STATE_SOURCE_KIND,
    sourcePath: file.sourcePath,
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkKind: 'rowid_range',
    watermarkStart,
    watermarkEnd,
    watermarkTable: table,
    agentSchemaVersion,
    gatewayVersion: context.gatewayVersion,
    capturedAtUtc: nowIsoUtc(),
    bodyFormat: CODEX_STATE_BODY_FORMAT,
    bodyCompression: CODEX_BODY_COMPRESSION,
    body: compressed,
  };

  insertBatch(context.buffer, batch);

  setCursor(context.buffer, {
    sourceApp: CODEX_SOURCE_APP,
    sourcePathHash: file.sourcePathHash,
    sourcePath: file.sourcePath,
    sourceInode: null,
    watermarkTable: table,
    watermarkEnd,
  });

  result.capturedBatches += 1;
  result.capturedBytes += compressed.byteLength;
}
