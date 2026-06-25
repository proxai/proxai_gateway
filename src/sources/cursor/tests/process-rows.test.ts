// src/sources/cursor/tests/process-rows.test.ts
import { describe, expect, it } from 'bun:test';

import { isRowExcludedByPlan, processRows } from 'sources/cursor/process-rows.ts';
import type {
  CursorCollectorContext,
  CursorCollectorResult,
  CursorDiskKvRow,
} from 'sources/cursor/cursor.types.ts';
import type { CursorGlobalExclusionPlan } from 'sources/cursor/exclusion.ts';
import { deleteBatch, nextPendingBatch, openInMemoryBufferDb } from 'services/buffer';
import { requireDefined, zstdDecompressSync } from 'core/utils';

function row(rowid: number, key: string, value: unknown): CursorDiskKvRow {
  return { rowid, key, value: JSON.stringify(value) };
}

describe('processRows — exclusion plan drops excluded rows', () => {
  it('drops excluded composer/bubble rows and excluded-only blobs, keeps the rest', () => {
    const buffer = openInMemoryBufferDb();
    const ctx: CursorCollectorContext = {
      buffer,
      gatewayVersion: 'gw',
      maxDecompressedBytes: 9 * 1024 * 1024,
    };
    const result: CursorCollectorResult = { capturedBatches: 0, capturedBytes: 0, errors: [] };

    const rows: CursorDiskKvRow[] = [
      row(1, 'composerData:nest1', { conversationState: '~' }),
      row(2, 'bubbleId:nest1:b1', { type: 1, text: 'secret', bubbleId: 'b1' }),
      row(3, 'bubbleId:web1:b2', { type: 1, text: 'public', bubbleId: 'b2' }),
      row(4, 'agentKv:blob:aaaa', { role: 'user', content: 'secret blob' }),
      row(5, 'agentKv:blob:bbbb', { role: 'user', content: 'shared blob' }),
    ];

    const plan: CursorGlobalExclusionPlan = {
      excludedComposerIds: new Set(['nest1']),
      blobsToDrop: new Set(['aaaa']), // 'bbbb' retained (shared)
    };

    processRows({
      rows,
      context: ctx,
      cycleComposerVersion: '16',
      effectiveSourcePath: '/x/globalStorage/state.vscdb',
      effectiveSourcePathHash: 'h',
      currentSizeBytes: 4096,
      currentPageCount: 1,
      finalWatermarkEnd: 6,
      result,
      exclusionPlan: plan,
    });

    // Drain the pending queue and decode each zstd body (mirrors parsing.test.ts).
    const DECODER = new TextDecoder();
    let joined = '';
    for (let b = nextPendingBatch(buffer); b !== null; b = nextPendingBatch(buffer)) {
      joined += DECODER.decode(zstdDecompressSync(b.body));
      deleteBatch(buffer, b.captureId);
    }
    expect(joined).not.toContain('secret');
    expect(joined).not.toContain('"agentKv:blob:aaaa"');
    expect(joined).toContain('"bubbleId:web1:b2"');
    expect(joined).toContain('"agentKv:blob:bbbb"');
  });
});

describe('isRowExcludedByPlan', () => {
  const plan = { excludedComposerIds: new Set(['nest1']), blobsToDrop: new Set(['aaaa']) };
  it('drops excluded composer + bubble + excluded-only blob', () => {
    expect(isRowExcludedByPlan('composerData:nest1', plan)).toBe(true);
    expect(isRowExcludedByPlan('bubbleId:nest1:b1', plan)).toBe(true);
    expect(isRowExcludedByPlan('agentKv:blob:aaaa', plan)).toBe(true);
  });
  it('keeps non-excluded composer + bubble + shared blob', () => {
    expect(isRowExcludedByPlan('composerData:web1', plan)).toBe(false);
    expect(isRowExcludedByPlan('bubbleId:web1:b2', plan)).toBe(false);
    expect(isRowExcludedByPlan('agentKv:blob:bbbb', plan)).toBe(false);
  });
  it('classifies an agentKv blob purely on blobsToDrop membership of the sliced hash', () => {
    // Exercises the agentKv:blob branch on its own (true when the post-prefix hash is in
    // blobsToDrop, false otherwise) — the slice must strip exactly the 'agentKv:blob:' prefix.
    const blobPlan = {
      excludedComposerIds: new Set<string>(),
      blobsToDrop: new Set(['deadbeef']),
    };
    expect(isRowExcludedByPlan('agentKv:blob:deadbeef', blobPlan)).toBe(true);
    expect(isRowExcludedByPlan('agentKv:blob:cafe', blobPlan)).toBe(false);
    // A bare prefix with no hash slices to '' — not in the set, so kept (false).
    expect(isRowExcludedByPlan('agentKv:blob:', blobPlan)).toBe(false);
  });
});

describe('processRows — per-batch agent_schema_version', () => {
  function vctx(buffer: ReturnType<typeof openInMemoryBufferDb>): CursorCollectorContext {
    return { buffer, gatewayVersion: 'gw', maxDecompressedBytes: 9 * 1024 * 1024 };
  }
  function runOne(
    buffer: ReturnType<typeof openInMemoryBufferDb>,
    rows: CursorDiskKvRow[],
    cycleComposerVersion: string | null,
  ) {
    const result: CursorCollectorResult = { capturedBatches: 0, capturedBytes: 0, errors: [] };
    processRows({
      rows,
      context: vctx(buffer),
      cycleComposerVersion,
      effectiveSourcePath: '/x/globalStorage/state.vscdb',
      effectiveSourcePathHash: 'h',
      currentSizeBytes: 4096,
      currentPageCount: 1,
      finalWatermarkEnd: rows.length + 1,
      result,
    });
    return requireDefined(nextPendingBatch(buffer), 'batch');
  }

  it('labels a single batch from its own rows (MAX per axis)', () => {
    const buffer = openInMemoryBufferDb();
    const batch = runOne(
      buffer,
      [
        row(1, 'composerData:c1', { _v: 16 }),
        row(2, 'bubbleId:c1:b1', { _v: 3, type: 1, text: 'hi' }),
      ],
      '16',
    );
    expect(batch.agentSchemaVersion).toBe('16:3');
  });

  it('bubble-only batch with a null cycle fallback labels the composer axis "unknown"', () => {
    const buffer = openInMemoryBufferDb();
    const batch = runOne(buffer, [row(1, 'bubbleId:c1:b1', { _v: 3, type: 1, text: 'hi' })], null);
    expect(batch.agentSchemaVersion).toBe('unknown:3');
  });
});
