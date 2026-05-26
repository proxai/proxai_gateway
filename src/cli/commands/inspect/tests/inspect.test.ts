import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { asWorkerCtor } from 'core/utils';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkerOutput } from 'services/polling/poll-worker.types.ts';

let shouldFailFs = false;

mock.module('node:fs/promises', () => {
  const actual: typeof import('node:fs/promises') = import.meta.require('node:fs/promises');
  return {
    ...actual,
    mkdir: (path: string, options: { recursive: true }): Promise<string | undefined> => {
      if (shouldFailFs) return Promise.reject(new Error('Mock fs.mkdir error'));
      return actual.mkdir(path, options);
    },
    writeFile: (path: string, data: string, encoding: 'utf-8'): Promise<void> => {
      if (shouldFailFs) return Promise.reject(new Error('Mock fs.writeFile error'));
      return actual.writeFile(path, data, encoding);
    },
  };
});

import { runInspect } from 'cli/commands/inspect';
import { captureOutput } from 'cli/output.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'proxai-cli-inspect-'));
});

afterEach(async () => {
  await rmRecursive(tempDir);
  shouldFailFs = false;
});

const inspectResultFixture: Required<WorkerOutput>['inspectResult'] = {
  filesProcessed: 5,
  recordCount: 42,
  totalBytes: 1337,
  telemetryRawBytes: 1000,
  telemetryCompressedBytes: 167,
  telemetryRecordCount: 42,
  promptCount: 6,
  oldestDate: '2026-05-20T20:00:00.000Z',
  newestDate: '2026-05-20T22:00:00.000Z',
  errors: [],
};

class SuccessWorker {
  onmessage: ((event: { data: WorkerOutput }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  postMessage(): void {
    queueMicrotask(() => {
      this.onmessage?.({
        data: { sourceName: 'claude-code', success: true, inspectResult: inspectResultFixture },
      });
    });
  }
  terminate(): void {}
}

test('runInspect: succeeds with empty directories', async () => {
  const out = captureOutput();
  const result = await runInspect(
    { output: out, configExists: () => Promise.resolve(true), gatewayVersion: '1.0.0' },
    { baseDirs: { claudeCode: tempDir, cursor: tempDir, geminiCli: tempDir, codex: tempDir } },
  );
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('ProxAI Telemetry Dry-Run Inspection'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('TELEMETRY SOURCES ON DISK'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('Highlights'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('markdown report saved to'))).toBe(true);
});

test('runInspect: renders worker results and highlights', async () => {
  const out = captureOutput();
  const originalWorker = globalThis.Worker;
  globalThis.Worker = asWorkerCtor(SuccessWorker);
  try {
    const result = await runInspect({
      output: out,
      configExists: () => Promise.resolve(true),
      gatewayVersion: '1.0.0',
    });
    expect(result.exitCode).toBe(0);
    expect(out.lines.some((l) => l.msg.includes('42'))).toBe(true);
    expect(out.lines.some((l) => l.msg.includes('Oldest telemetry record'))).toBe(true);
    expect(out.lines.some((l) => l.msg.includes('Newest telemetry record'))).toBe(true);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('runInspect: surfaces a worker that returns success:false', async () => {
  const out = captureOutput();
  const originalWorker = globalThis.Worker;
  class FailWorker {
    onmessage: ((event: { data: WorkerOutput }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    postMessage(): void {
      queueMicrotask(() => {
        this.onmessage?.({ data: { sourceName: 'claude-code', success: false } });
      });
    }
    terminate(): void {}
  }
  globalThis.Worker = asWorkerCtor(FailWorker);
  try {
    const result = await runInspect({
      output: out,
      configExists: () => Promise.resolve(true),
      gatewayVersion: '1.0.0',
    });
    expect(result.exitCode).toBe(0);
    expect(out.lines.some((l) => l.msg.includes('Warnings'))).toBe(true);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('runInspect: handles a worker error event', async () => {
  const out = captureOutput();
  const originalWorker = globalThis.Worker;
  class ErrorWorker {
    onmessage: ((event: { data: WorkerOutput }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    postMessage(): void {
      queueMicrotask(() => {
        this.onerror?.(new Error('worker error'));
      });
    }
    terminate(): void {}
  }
  globalThis.Worker = asWorkerCtor(ErrorWorker);
  try {
    const result = await runInspect({
      output: out,
      configExists: () => Promise.resolve(true),
      gatewayVersion: '1.0.0',
    });
    expect(result.exitCode).toBe(0);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('runInspect: handles a worker constructor throw', async () => {
  const out = captureOutput();
  const originalWorker = globalThis.Worker;
  class ThrowingWorker {
    constructor() {
      throw new Error('Constructor boom');
    }
    postMessage(): void {}
    terminate(): void {}
  }
  globalThis.Worker = asWorkerCtor(ThrowingWorker);
  try {
    const result = await runInspect({
      output: out,
      configExists: () => Promise.resolve(true),
      gatewayVersion: '1.0.0',
    });
    expect(result.exitCode).toBe(0);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('runInspect: reports a markdown save failure gracefully', async () => {
  const out = captureOutput();
  shouldFailFs = true;
  const result = await runInspect(
    { output: out, configExists: () => Promise.resolve(true), gatewayVersion: '1.0.0' },
    { baseDirs: { claudeCode: tempDir, cursor: tempDir, geminiCli: tempDir, codex: tempDir } },
  );
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('Failed to save markdown report'))).toBe(true);
});

test('runInspect: fails gracefully on an unexpected error', async () => {
  const out = captureOutput();
  const originalWorker = globalThis.Worker;
  globalThis.Worker = asWorkerCtor(SuccessWorker);
  const originalParse = Date.parse;
  Date.parse = (): number => {
    throw new Error('Simulated Date.parse error');
  };
  try {
    const result = await runInspect({
      output: out,
      configExists: () => Promise.resolve(true),
      gatewayVersion: '1.0.0',
    });
    expect(result.exitCode).toBe(1);
    expect(
      out.lines.some((l) => l.msg.includes('Unexpected inspect error: Simulated Date.parse error')),
    ).toBe(true);
  } finally {
    globalThis.Worker = originalWorker;
    Date.parse = originalParse;
  }
});
