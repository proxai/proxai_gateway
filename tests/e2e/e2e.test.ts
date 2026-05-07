/**
 * End-to-end suite that drives the gateway against a single-process fake
 * nest server through the production capture -> buffer -> upload pipeline.
 *
 * Each scenario:
 *   1. spins up fake-nest and a fresh temp config dir,
 *   2. plants real source-file fixtures,
 *   3. invokes runSetup programmatically (where applicable),
 *   4. runs exactly one runPollCycle (no loop) for determinism,
 *   5. asserts against fake-nest's `received()` and the local buffer state.
 *
 * The fake-nest control surface (setKeyValid, seedWatermarks, received,
 * reset) lives in tests/e2e/fake-nest.ts. Helpers live in helpers.ts.
 */
import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { sha256Hex, zstdDecompressSync } from 'core/utils';
import { deriveHostId } from 'core/system';
import { generateUuidV7 } from 'core/utils';
import {
  countCursors,
  getCursor,
  insertBatch,
  insertReceipt,
  totalPendingBytes,
  countByStatus,
} from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import { pausePolling, resumePolling, isAuthFailed, isBufferFull } from 'services/polling';
import { startFakeNest } from './fake-nest.ts';
import type { FakeNestHandle, ServerWatermarkRow } from './fake-nest.ts';
import {
  appendClaudeCodeJsonl,
  mkTempProxaiDir,
  openEnvBuffer,
  plantClaudeCodeJsonl,
  runOneCycle,
  setupGateway,
} from './helpers.ts';
import type { TempEnv } from './helpers.ts';

const VALID_KEY = 'pxg-20260101-validkeysecret';
const ALT_KEY = 'pxg-20260202-secondvalidkey';
const MACHINE_UUID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const USER_ID = 'u_e2e_user';
const EXPECTED_HOST_ID = deriveHostId(MACHINE_UUID, USER_ID);

let nest: FakeNestHandle;
let env: TempEnv;

beforeEach(async () => {
  nest = await startFakeNest();
  env = await mkTempProxaiDir();
  nest.setKeyValid(VALID_KEY, true, { userId: USER_ID, keyName: 'e2e-test' });
});

afterEach(async () => {
  await nest.stop();
  await env.cleanup();
});

const SAMPLE_TURN_1 =
  '{"version":"2.1.122","type":"user","message":{"role":"user","content":"hello"}}\n';
const SAMPLE_TURN_2 =
  '{"version":"2.1.122","type":"assistant","message":{"role":"assistant","content":"hi"}}\n';
const SAMPLE_TURN_3 =
  '{"version":"2.1.122","type":"user","message":{"role":"user","content":"goodbye"}}\n';

describe('A — Happy path: capture, buffer, upload, receipt', () => {
  test('claude-code: 3 turns -> 1 batch -> nest receives -> receipt written', async () => {
    const jsonl = SAMPLE_TURN_1 + SAMPLE_TURN_2 + SAMPLE_TURN_3;
    await plantClaudeCodeJsonl(env, 'project-a', 'session-1.jsonl', jsonl);

    const setupResult = await setupGateway(env, {
      apiKey: VALID_KEY,
      nestUrl: nest.url,
      machineUuid: MACHINE_UUID,
    });
    expect(setupResult.exitCode).toBe(0);
    expect(setupResult.config.account.hostId).toBe(EXPECTED_HOST_ID);

    const buffer = openEnvBuffer(env);
    try {
      const cycle = await runOneCycle({
        env,
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: nest.url,
        buffer,
      });
      expect(cycle.paused).toBe(false);
      expect(cycle.authFailed).toBe(false);
      expect(cycle.bufferFull).toBe(false);
      expect(cycle.drainResult?.accepted).toBe(1);

      const received = nest.received();
      expect(received.records).toHaveLength(1);
      const rec = received.records[0]!;
      expect(rec.sourceApp).toBe('claude-code');
      expect(rec.bodyFormat).toBe('jsonl');
      expect(rec.watermarkKind).toBe('byte_range');
      expect(rec.watermarkStart).toBe(0);
      expect(rec.watermarkEnd).toBe(jsonl.length);
      expect(rec.hostId).toBe(EXPECTED_HOST_ID);

      // Body decompresses to original bytes (modulo redaction; sample has no
      // redactable secrets, so the redacted text equals the original).
      const decoded = Buffer.from(rec.body, 'base64');
      const decompressed = zstdDecompressSync(decoded);
      expect(new TextDecoder().decode(decompressed)).toBe(jsonl);

      // Buffer: 0 pending, 1 receipt.
      const counts = countByStatus(buffer);
      expect(counts.pending).toBe(0);
      expect(counts.failed).toBe(0);
      expect(counts.delivered).toBe(1);
    } finally {
      buffer.close();
    }
  });
});

describe('B — Multi-cycle continuation', () => {
  test('append after first cycle yields a second batch with non-overlapping range', async () => {
    const initial = SAMPLE_TURN_1 + SAMPLE_TURN_2;
    const filePath = await plantClaudeCodeJsonl(env, 'project-b', 'session-1.jsonl', initial);

    await setupGateway(env, {
      apiKey: VALID_KEY,
      nestUrl: nest.url,
      machineUuid: MACHINE_UUID,
    });

    const buffer = openEnvBuffer(env);
    try {
      await runOneCycle({
        env,
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: nest.url,
        buffer,
      });
      const firstBatch = nest.received().records;
      expect(firstBatch).toHaveLength(1);

      // Append more bytes to the same file and run a second cycle.
      await appendClaudeCodeJsonl(filePath, SAMPLE_TURN_3);

      await runOneCycle({
        env,
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: nest.url,
        buffer,
      });
      const records = nest.received().records;
      expect(records).toHaveLength(2);
      const a = records[0]!;
      const b = records[1]!;
      // Non-overlapping byte ranges with continuity.
      expect(a.watermarkEnd).toBe(initial.length);
      expect(b.watermarkStart).toBe(initial.length);
      expect(b.watermarkEnd).toBe(initial.length + SAMPLE_TURN_3.length);
      expect(a.sourcePathHash).toBe(b.sourcePathHash);
    } finally {
      buffer.close();
    }
  });
});

describe('C — Reinstall / watermark sync', () => {
  test('after wipe + re-setup, sync seeds cursor and capture starts from server watermark', async () => {
    const jsonl = SAMPLE_TURN_1 + SAMPLE_TURN_2 + SAMPLE_TURN_3;
    const filePath = await plantClaudeCodeJsonl(env, 'project-c', 'session-1.jsonl', jsonl);

    // First install + cycle: nest now has a watermark.
    await setupGateway(env, {
      apiKey: VALID_KEY,
      nestUrl: nest.url,
      machineUuid: MACHINE_UUID,
    });
    let buffer = openEnvBuffer(env);
    await runOneCycle({
      env,
      apiKey: VALID_KEY,
      hostId: EXPECTED_HOST_ID,
      nestUrl: nest.url,
      buffer,
    });
    const firstWave = nest.received().records;
    expect(firstWave).toHaveLength(1);
    buffer.close();

    // Simulate "reinstall": wipe local buffer + cursors + config. Re-run
    // setup with the same key + machine_uuid so the derived host_id stays
    // identical and the server's watermark for that host applies.
    const fs = await import('node:fs/promises');
    await fs.rm(env.bufferDbPath, { force: true });
    await fs.rm(env.configPath, { force: true });

    await setupGateway(env, {
      apiKey: VALID_KEY,
      nestUrl: nest.url,
      machineUuid: MACHINE_UUID,
    });

    // Fresh buffer; manually invoke watermark-sync (mirrors what runDaemon
    // does on first cycle). Then run one cycle.
    buffer = openEnvBuffer(env);
    try {
      const { syncServerWatermarks } = await import('services/polling');
      const { HttpClient } = await import('services/http');
      const http = new HttpClient({
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        endpoints: {
          ingest: `${nest.url}/v1/raw_records`,
          verifyKey: `${nest.url}/ingestion/verify-key`,
          watermarks: `${nest.url}/v1/watermarks`,
          registerHostId: `${nest.url}/v1/host-ids/register`,
        },
      });
      expect(countCursors(buffer)).toBe(0);
      const sync = await syncServerWatermarks({ buffer, http });
      expect(sync.fetched).toBeGreaterThanOrEqual(1);
      expect(sync.applied).toBeGreaterThanOrEqual(1);
      expect(countCursors(buffer)).toBeGreaterThan(0);

      const watermarkFetchesBefore = nest.received().watermarkFetches.length;
      expect(watermarkFetchesBefore).toBeGreaterThanOrEqual(1);

      // The synced cursor lives under inode=0 sentinel; the source poller's
      // discover phase will find the file with its real inode and use the
      // fallback lookup to inherit the synced position. With no new bytes,
      // no batch should be emitted.
      const beforeRecords = nest.received().records.length;
      await runOneCycle({
        env,
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: nest.url,
        buffer,
      });
      const afterRecords = nest.received().records.length;
      // Synced cursor at watermark = jsonl.length suppresses re-capture.
      expect(afterRecords).toBe(beforeRecords);

      // Append new bytes and verify capture resumes from the synced position.
      await appendClaudeCodeJsonl(filePath, SAMPLE_TURN_2);
      await runOneCycle({
        env,
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: nest.url,
        buffer,
      });
      const finalRecords = nest.received().records;
      expect(finalRecords.length).toBe(beforeRecords + 1);
      const last = finalRecords[finalRecords.length - 1]!;
      expect(last.watermarkStart).toBe(jsonl.length);
      expect(last.watermarkEnd).toBe(jsonl.length + SAMPLE_TURN_2.length);
    } finally {
      buffer.close();
    }
  });
});

describe('D — Watermark regression recovery', () => {
  test('local cursor at 0 with server at N -> 400 -> cursor reset -> next cycle resumes', async () => {
    const initial = SAMPLE_TURN_1 + SAMPLE_TURN_2;
    const filePath = await plantClaudeCodeJsonl(env, 'project-d', 'session-1.jsonl', initial);
    const sourcePathHash = sha256Hex(filePath);

    await setupGateway(env, {
      apiKey: VALID_KEY,
      nestUrl: nest.url,
      machineUuid: MACHINE_UUID,
    });

    // Pre-seed nest with a watermark ahead of the local cursor (which is 0
    // since the buffer is empty). The first capture will produce a batch
    // covering [0, initial.length); on upload the server returns 400
    // watermark_regression with current_server_watermark_end = initial.length,
    // which causes the gateway to reset the cursor and drop the batch.
    const seededEnd = initial.length;
    nest.seedWatermarks(EXPECTED_HOST_ID, [
      {
        source_app: 'claude-code',
        source_path_hash: sourcePathHash,
        watermark_kind: 'byte_range',
        watermark_end: seededEnd,
        watermark_table: null,
        last_delivered_at: '2026-04-29T10:42:00Z',
      },
    ]);

    const buffer = openEnvBuffer(env);
    try {
      const cycle1 = await runOneCycle({
        env,
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: nest.url,
        buffer,
      });
      expect(cycle1.drainResult?.recovered).toBe(1);
      // Cursor was rewritten to seededEnd. Records on server unchanged
      // (still none — the failed batch was dropped).
      expect(nest.received().records).toHaveLength(0);

      // Append new bytes and run another cycle: capture should resume from
      // seededEnd forward.
      await appendClaudeCodeJsonl(filePath, SAMPLE_TURN_3);
      const cycle2 = await runOneCycle({
        env,
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: nest.url,
        buffer,
      });
      expect(cycle2.drainResult?.accepted).toBe(1);
      const records = nest.received().records;
      expect(records).toHaveLength(1);
      const r = records[0]!;
      expect(r.watermarkStart).toBe(seededEnd);
      expect(r.watermarkEnd).toBe(seededEnd + SAMPLE_TURN_3.length);
    } finally {
      buffer.close();
    }
  });
});

describe('E — Invalid ingestion key (auth failure halt)', () => {
  test('upload to revoked key writes AUTH_FAILED; next cycle short-circuits; new key clears it', async () => {
    const jsonl = SAMPLE_TURN_1 + SAMPLE_TURN_2;
    await plantClaudeCodeJsonl(env, 'project-e', 'session-1.jsonl', jsonl);

    await setupGateway(env, {
      apiKey: VALID_KEY,
      nestUrl: nest.url,
      machineUuid: MACHINE_UUID,
    });

    // Simulate the key being revoked AFTER setup succeeded (so verify-key on
    // the upload path returns success: false). Setup itself succeeded
    // because we toggled validity off only now.
    nest.setKeyValid(VALID_KEY, false, { userId: USER_ID, keyName: 'e2e-test' });

    const buffer = openEnvBuffer(env);
    try {
      const cycle1 = await runOneCycle({
        env,
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: nest.url,
        buffer,
      });
      // The drain attempted one upload, hit 403, verify-key reported
      // success:false, the auth-failed sentinel was written, the batch
      // moved to status=failed.
      expect(cycle1.drainResult?.fatal).toBe(1);
      expect(await isAuthFailed(env.authFailedSentinelPath)).toBe(true);
      const failedCounts = countByStatus(buffer);
      expect(failedCounts.failed).toBe(1);
      expect(failedCounts.pending).toBe(0);

      // Next cycle: short-circuits before doing any work.
      const beforeRecords = nest.received().records.length;
      const cycle2 = await runOneCycle({
        env,
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: nest.url,
        buffer,
      });
      expect(cycle2.authFailed).toBe(true);
      expect(cycle2.drainResult).toBeNull();
      expect(nest.received().records.length).toBe(beforeRecords);

      // Re-setup with a NEW valid key clears the sentinel.
      nest.setKeyValid(ALT_KEY, true, { userId: USER_ID, keyName: 'rotated' });
      const fs = await import('node:fs/promises');
      await fs.rm(env.configPath, { force: true });
      const re = await setupGateway(env, {
        apiKey: ALT_KEY,
        nestUrl: nest.url,
        machineUuid: MACHINE_UUID,
      });
      expect(re.exitCode).toBe(0);
      expect(await isAuthFailed(env.authFailedSentinelPath)).toBe(false);

      // The next cycle with the new key proceeds (no AUTH_FAILED). The
      // failed batch from cycle1 stays in `failed` status (poller has no new
      // bytes; capture won't re-emit; status stays "failed"). The cycle
      // itself is not paused/authFailed.
      const cycle3 = await runOneCycle({
        env,
        apiKey: ALT_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: nest.url,
        buffer,
      });
      expect(cycle3.authFailed).toBe(false);
      expect(cycle3.paused).toBe(false);
    } finally {
      buffer.close();
    }
  });
});

describe('F — Buffer pressure -> BUFFER_FULL sentinel', () => {
  test('large inserted batches push pending bytes over soft-pause threshold', async () => {
    // No source fixtures: we insert mock pending batches directly. The plan
    // explicitly recommends this to avoid allocating real 700+ MB.
    await setupGateway(env, {
      apiKey: VALID_KEY,
      nestUrl: nest.url,
      machineUuid: MACHINE_UUID,
    });

    const buffer = openEnvBuffer(env);
    try {
      // Use bodies just under the 2 MB DTO validation limit so the first
      // upload attempt (which always validates) won't be marked fatal and
      // dropped — we want it to fail with a retriable network error so the
      // remaining batches stay pending and the pressure check fires.
      const perBatch = 2_000_000; // ~1.91 MiB, comfortably under 2 MiB cap
      const fakeBody = new Uint8Array(perBatch);
      const batchCount = 380; // 380 * 2_000_000 = 760 MB > 700 MB
      buffer.transaction(() => {
        for (let i = 0; i < batchCount; i++) {
          const b: NewBatch = {
            captureId: generateUuidV7(),
            sourceApp: 'claude-code',
            sourceKind: 'jsonl_append',
            sourcePath: `/tmp/fake-${i.toString()}.jsonl`,
            sourcePathHash: i.toString(16).padStart(64, '0'),
            sourceInode: 100 + i,
            watermarkKind: 'byte_range',
            watermarkStart: 0,
            watermarkEnd: perBatch,
            watermarkTable: null,
            agentSchemaVersion: '2.1.0',
            gatewayVersion: '@proxai/gateway 0.1.0-e2e',
            capturedAtUtc: '2026-04-29T10:42:00.123Z',
            bodyFormat: 'jsonl',
            bodyCompression: 'zstd',
            body: fakeBody,
          };
          insertBatch(buffer, b);
        }
      })();
      const pending = totalPendingBytes(buffer);
      expect(pending).toBeGreaterThan(700 * 1024 * 1024);

      // Force drain to fail with a retriable network error. We point the
      // gateway at a closed port so fetch fails immediately; the first
      // batch becomes retriable (status stays 'pending') and the loop
      // breaks. The pressure check then runs against the still-large
      // pending set and writes the BUFFER_FULL sentinel.
      const deadUrl = 'http://127.0.0.1:1';
      const cycle = await runOneCycle({
        env,
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: deadUrl,
        buffer,
      });
      expect(cycle.pressureResult?.shouldPause).toBe(true);
      expect(await isBufferFull(env.bufferFullSentinelPath)).toBe(true);

      // Next cycle short-circuits (still over threshold).
      const cycle2 = await runOneCycle({
        env,
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: deadUrl,
        buffer,
      });
      expect(cycle2.bufferFull).toBe(true);
      expect(cycle2.drainResult).toBeNull();
    } finally {
      buffer.close();
    }
  });
});

describe('G — Pause sentinel manual override', () => {
  test('cycle short-circuits when paused; resume restores normal capture', async () => {
    const jsonl = SAMPLE_TURN_1 + SAMPLE_TURN_2;
    await plantClaudeCodeJsonl(env, 'project-g', 'session-1.jsonl', jsonl);
    await setupGateway(env, {
      apiKey: VALID_KEY,
      nestUrl: nest.url,
      machineUuid: MACHINE_UUID,
    });

    await pausePolling(env.pauseSentinelPath, 'manual-test');

    const buffer = openEnvBuffer(env);
    try {
      const paused = await runOneCycle({
        env,
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: nest.url,
        buffer,
      });
      expect(paused.paused).toBe(true);
      expect(paused.drainResult).toBeNull();
      expect(nest.received().records).toHaveLength(0);

      await resumePolling(env.pauseSentinelPath);

      const resumed = await runOneCycle({
        env,
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: nest.url,
        buffer,
      });
      expect(resumed.paused).toBe(false);
      expect(resumed.drainResult?.accepted).toBe(1);
      expect(nest.received().records).toHaveLength(1);
    } finally {
      buffer.close();
    }
  });
});

describe('H — Time-based prune', () => {
  test('receipts older than retention window are deleted; recent ones remain', async () => {
    await setupGateway(env, {
      apiKey: VALID_KEY,
      nestUrl: nest.url,
      machineUuid: MACHINE_UUID,
    });

    const buffer = openEnvBuffer(env);
    try {
      // 5 receipts > 31 days old (default retention = 30).
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date().toISOString();
      for (let i = 0; i < 5; i++) {
        insertReceipt(buffer, {
          captureId: generateUuidV7(),
          sourceApp: 'claude-code',
          sourcePathHash: 'old' + i.toString(),
          watermarkKind: 'byte_range',
          watermarkStart: 0,
          watermarkEnd: 100,
          watermarkTable: null,
          deliveredAt: old,
          idempotentOnServer: false,
        });
      }
      for (let i = 0; i < 3; i++) {
        insertReceipt(buffer, {
          captureId: generateUuidV7(),
          sourceApp: 'claude-code',
          sourcePathHash: 'new' + i.toString(),
          watermarkKind: 'byte_range',
          watermarkStart: 0,
          watermarkEnd: 100,
          watermarkTable: null,
          deliveredAt: recent,
          idempotentOnServer: false,
        });
      }
      expect(countByStatus(buffer).delivered).toBe(8);

      const cycle = await runOneCycle({
        env,
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: nest.url,
        buffer,
      });
      expect(cycle.pruneResult?.receiptsDeleted).toBe(5);
      expect(countByStatus(buffer).delivered).toBe(3);
    } finally {
      buffer.close();
    }
  });
});

describe('I — Vacuum detection', () => {
  test('cursor (size + max-rowid drop) -> source_path rotated with #gen=1', async () => {
    // Plant a Cursor-style state.vscdb with cursorDiskKV table containing
    // composer / bubble rows. We seed a prior cursor row indicating size=5MB
    // and watermark_end=1000, then write the actual SQLite with a small
    // size and only ~5 rows — the vacuum detector should fire on
    // size_decreased (current size < 5MB) AND rowid_regressed (max rowid < 999).
    const { join: joinPath } = await import('node:path');
    const vscdbPath = joinPath(env.cursorRoot, 'globalStorage', 'state.vscdb');
    await (await import('core/io/fs')).ensureDir(joinPath(env.cursorRoot, 'globalStorage'));

    const seedDb = new (await import('bun:sqlite')).Database(vscdbPath);
    seedDb.run('CREATE TABLE cursorDiskKV (rowid INTEGER PRIMARY KEY, key TEXT, value TEXT)');
    const insert = seedDb.query('INSERT INTO cursorDiskKV (rowid, key, value) VALUES (?, ?, ?)');
    insert.run(1, 'composerData:abc', '{"_v":13,"role":"user","content":"hi"}');
    insert.run(2, 'bubbleId:def', '{"_v":7,"text":"hello"}');
    insert.run(3, 'composerData:xyz', '{"_v":13,"role":"assistant"}');
    seedDb.close();

    const sourcePathHash = sha256Hex(vscdbPath);

    await setupGateway(env, {
      apiKey: VALID_KEY,
      nestUrl: nest.url,
      machineUuid: MACHINE_UUID,
    });

    // Pre-seed the local cursor row pretending we previously processed up
    // to rowid 1000 with a 5MB file size.
    const buffer = openEnvBuffer(env);
    try {
      const { setCursor } = await import('services/buffer');
      setCursor(buffer, {
        sourceApp: 'cursor',
        sourcePathHash,
        sourcePath: vscdbPath,
        sourceInode: null,
        watermarkTable: null,
        watermarkEnd: 1000,
        lastSeenSizeBytes: 5_000_000,
        lastSeenPageCount: 1500,
      });

      const cycle = await runOneCycle({
        env,
        apiKey: VALID_KEY,
        hostId: EXPECTED_HOST_ID,
        nestUrl: nest.url,
        buffer,
      });
      // A new batch was captured under the rotated source identity.
      expect(cycle.drainResult?.accepted).toBe(1);
      const records = nest.received().records;
      expect(records).toHaveLength(1);
      // The rotated source_path is hashed before upload; assert the new
      // hash is NOT the original. Compute the rotated hash here.
      const rotatedHash = sha256Hex(`${vscdbPath}#gen=1`);
      expect(records[0]!.sourcePathHash).toBe(rotatedHash);
      expect(records[0]!.sourcePathHash).not.toBe(sourcePathHash);

      // The new cursor row exists under the rotated hash with watermark
      // covering the 3 rows present (rowid 1..3 -> watermarkEnd = 4).
      const newCursor = getCursor(buffer, {
        sourceApp: 'cursor',
        sourcePathHash: rotatedHash,
        sourceInode: null,
        watermarkTable: null,
      });
      expect(newCursor).not.toBeNull();
      expect(newCursor!.watermarkEnd).toBe(4);
    } finally {
      buffer.close();
    }
  });
});

// Re-export imported types so noUnusedLocals doesn't trip on the helper
// imports above (Database / ServerWatermarkRow are surfaced for tests that
// extend the suite).
export type { Database, ServerWatermarkRow };
