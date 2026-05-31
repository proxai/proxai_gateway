import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import { generateUuidV7, nowIsoUtc, requireDefined } from 'core/utils';
import { runLogs } from 'cli/commands/logs/index.ts';
import type { LogsCommandDeps, LogsCommandOptions } from 'cli/commands/logs/logs.types.ts';
import { captureOutput } from 'cli/output.ts';
import type { ReadableInputStream } from 'cli/commands/status/key-handler.types.ts';
import type { NewBatch } from 'services/buffer';
import {
  getBatch,
  insertBatch,
  markBatchDelivered,
  markBatchFailed,
  openInMemoryBufferDb,
} from 'services/buffer';

function stripAnsi(s: string): string {
  const ESC = String.fromCharCode(27);
  const ESC2 = String.fromCharCode(155);
  const ANSI_PATTERN = new RegExp(
    '[' + ESC + ESC2 + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]',
    'g',
  );
  return s.replace(ANSI_PATTERN, '');
}

function autoQuitStdin(): ReadableInputStream {
  return {
    isTTY: false,
    on(event, listener): unknown {
      if (event === 'data') {
        setTimeout(() => {
          (listener as (chunk: Buffer) => void)(Buffer.from('q'));
        }, 50);
      }
      return this;
    },
    off(): unknown {
      return this;
    },
  };
}

let buffer: Database;

beforeEach(() => {
  buffer = openInMemoryBufferDb();
});

afterEach(() => {
  buffer.close();
});

function makeDeps(extras: Partial<LogsCommandDeps> = {}): LogsCommandDeps {
  return {
    output: captureOutput(),
    buffer,
    ...extras,
  };
}

function makeBatch(overrides: Partial<NewBatch> = {}): NewBatch {
  return {
    captureId: generateUuidV7(),
    sourceApp: 'claude-code',
    sourceKind: 'jsonl_append',
    sourcePath: '/home/user/project/session.jsonl',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: 42,
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: 100,
    watermarkTable: null,
    agentSchemaVersion: 'claude-code/1.0.0',
    gatewayVersion: '2026.5.28',
    capturedAtUtc: nowIsoUtc(),
    bodyFormat: 'jsonl',
    bodyCompression: 'zstd',
    body: new Uint8Array([1, 2, 3, 4]),
    ...overrides,
  };
}

function seedDelivered(): void {
  const batch = makeBatch();
  insertBatch(buffer, batch);
  markBatchDelivered(buffer, requireDefined(getBatch(buffer, batch.captureId)), {
    idempotentOnServer: false,
  });
}

function seedFailed(): void {
  const batch = makeBatch();
  insertBatch(buffer, batch);
  markBatchFailed(buffer, batch.captureId, 'server returned 500');
}

test('rejects an invalid --since duration with a validation error', async () => {
  const out = captureOutput();
  const result = await runLogs(makeDeps({ output: out }), { static: true, since: 'banana' });
  expect(result.exitCode).toBe(2);
  expect(out.lines.some((l) => l.msg.includes('invalid --since'))).toBe(true);
});

test('accepts a valid --since duration and renders normally', async () => {
  seedDelivered();
  const out = captureOutput();
  const result = await runLogs(makeDeps({ output: out }), { static: true, since: '24h' });
  expect(result.exitCode).toBe(0);
  const rendered = stripAnsi(out.lines.map((l) => l.msg).join('\n'));
  expect(rendered).toContain('Uploaded');
});

test('reports unavailable buffer in static mode', async () => {
  const out = captureOutput();
  const result = await runLogs(makeDeps({ output: out, buffer: null }), { static: true });
  expect(result.exitCode).toBe(1);
  expect(out.lines.some((l) => l.msg.includes('buffer database is unavailable'))).toBe(true);
});

test('json mode emits a serialized frame and exits ok', async () => {
  seedDelivered();
  const out = captureOutput();
  const result = await runLogs(makeDeps({ output: out }), { json: true });
  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(requireDefined(out.lines[0]).msg) as { uploaded: unknown[] };
  expect(payload.uploaded).toHaveLength(1);
});

test('static mode renders an uploaded frame with the same view for everyone', async () => {
  seedDelivered();
  const out = captureOutput();
  const result = await runLogs(makeDeps({ output: out }), { static: true });
  expect(result.exitCode).toBe(0);
  const rendered = stripAnsi(out.lines.map((l) => l.msg).join('\n'));
  expect(rendered).toContain('Uploaded');
  expect(rendered).toContain('claude-code');
});

test('static mode --failed renders failed records', async () => {
  seedFailed();
  const out = captureOutput();
  const result = await runLogs(makeDeps({ output: out }), { static: true, failed: true });
  expect(result.exitCode).toBe(0);
  const rendered = stripAnsi(out.lines.map((l) => l.msg).join('\n'));
  expect(rendered).toContain('Failed');
});

test('--id implies static and renders a single record detail', async () => {
  const batch = makeBatch();
  insertBatch(buffer, batch);
  markBatchDelivered(buffer, requireDefined(getBatch(buffer, batch.captureId)), {
    idempotentOnServer: false,
  });
  const out = captureOutput();
  const result = await runLogs(makeDeps({ output: out }), { id: batch.captureId });
  expect(result.exitCode).toBe(0);
  const rendered = stripAnsi(out.lines.map((l) => l.msg).join('\n'));
  expect(rendered).toContain('capture_id');
});

test('watch mode renders a frame and exits when the user quits', async () => {
  seedDelivered();
  const out = captureOutput();
  const result = await runLogs(makeDeps({ output: out }), {
    stdin: autoQuitStdin(),
    intervalMs: 1_000_000,
  });
  expect(result.exitCode).toBe(0);
  const rendered = stripAnsi(out.lines.map((l) => l.msg).join('\n'));
  expect(rendered).toContain('Uploaded');
});

test('watch mode re-ticks across the refresh interval until quit', async () => {
  seedDelivered();
  const out = captureOutput();
  const result = await runLogs(makeDeps({ output: out }), {
    stdin: autoQuitStdin(),
    intervalMs: 5,
  });
  expect(result.exitCode).toBe(0);
  const rendered = stripAnsi(out.lines.map((l) => l.msg).join('\n'));
  expect(rendered).toContain('Uploaded');
});

test('watch mode reports unavailable buffer from inside the tick and self-quits', async () => {
  const live = buffer;
  let reads = 0;
  const deps: LogsCommandDeps = {
    output: captureOutput(),
    get buffer(): Database | null {
      reads += 1;
      return reads <= 1 ? live : null;
    },
  };
  const options: LogsCommandOptions = { stdin: autoQuitStdin(), intervalMs: 1_000_000 };
  const result = await runLogs(deps, options);
  expect(result.exitCode).toBe(0);
  const out = deps.output as ReturnType<typeof captureOutput>;
  expect(out.lines.some((l) => l.msg.includes('buffer database is unavailable'))).toBe(true);
});

test('watch mode surfaces a thrown render error without crashing', async () => {
  const live = buffer;
  let reads = 0;
  const deps: LogsCommandDeps = {
    output: captureOutput(),
    get buffer(): Database | null {
      reads += 1;
      if (reads <= 1) return live;
      live.close();
      return live;
    },
  };
  const result = await runLogs(deps, { stdin: autoQuitStdin(), intervalMs: 1_000_000 });
  expect(result.exitCode).toBe(0);
  const out = deps.output as ReturnType<typeof captureOutput>;
  expect(out.lines.some((l) => l.level === 'error')).toBe(true);
  buffer = openInMemoryBufferDb();
});
