import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asMessageEvent, asWorkerCtor } from 'core/utils';
import { captureOutput } from 'cli/output.ts';
import type { WorkerOutput } from 'services/polling/poll-worker.types.ts';

import {
  buildScanOptions,
  emptySourceResult,
  isCompiledRuntime,
  resolveSourceBaseDir,
  scanSingleSource,
  scanViaDirect,
  scanViaWorker,
} from 'cli/commands/inspect/scan.ts';
import type { InspectWorkerLike } from 'cli/commands/inspect/scan.ts';
import type { InspectCommandDeps } from 'cli/commands/inspect/inspect.types.ts';

const deps: InspectCommandDeps = {
  output: captureOutput(),
  configExists: () => Promise.resolve(true),
  gatewayVersion: 'gw-test',
};

const sampleInspectResult: Required<WorkerOutput>['inspectResult'] = {
  filesProcessed: 1,
  recordCount: 3,
  totalBytes: 10,
  telemetryRawBytes: 5,
  telemetryCompressedBytes: 1,
  telemetryRecordCount: 2,
  promptCount: 1,
  oldestDate: null,
  newestDate: null,
  errors: [],
};

function fakeWorker(behavior: (worker: InspectWorkerLike) => void): InspectWorkerLike {
  const worker: InspectWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (): void => {
      queueMicrotask(() => behavior(worker));
    },
    terminate: (): void => {},
  };
  return worker;
}

test('isCompiledRuntime: false under the test runner', () => {
  expect(isCompiledRuntime()).toBe(false);
});

test('resolveSourceBaseDir: maps every source and unknown input', () => {
  const baseDirs = { claudeCode: 'a', cursor: 'b', claudeDesktop: 'c', codex: 'd' };
  expect(resolveSourceBaseDir('claude-code', baseDirs)).toBe('a');
  expect(resolveSourceBaseDir('cursor', baseDirs)).toBe('b');
  expect(resolveSourceBaseDir('claude-desktop', baseDirs)).toBe('c');
  expect(resolveSourceBaseDir('codex', baseDirs)).toBe('d');
  expect(resolveSourceBaseDir('unknown', baseDirs)).toBeUndefined();
  expect(resolveSourceBaseDir('codex', undefined)).toBeUndefined();
});

test('buildScanOptions: includes baseDir only when provided', () => {
  const withDir = buildScanOptions('gw', '/tmp/x');
  expect(withDir.baseDir).toBe('/tmp/x');
  expect(withDir.gatewayVersion).toBe('gw');
  expect(buildScanOptions('gw', undefined).baseDir).toBeUndefined();
});

test('emptySourceResult: zeroed result carrying errors', () => {
  const result = emptySourceResult('codex', ['boom']);
  expect(result.sourceName).toBe('codex');
  expect(result.filesProcessed).toBe(0);
  expect(result.telemetryRecordCount).toBe(0);
  expect(result.errors).toEqual(['boom']);
});

test('scanViaDirect: maps a successful inspect result', async () => {
  const result = await scanViaDirect('claude-code', buildScanOptions('gw', undefined), () =>
    Promise.resolve(sampleInspectResult),
  );
  expect(result.sourceName).toBe('claude-code');
  expect(result.recordCount).toBe(3);
  expect(result.errors).toEqual([]);
});

test('scanViaDirect: captures an Error failure', async () => {
  const result = await scanViaDirect('codex', buildScanOptions('gw', undefined), () => {
    throw new Error('direct boom');
  });
  expect(result.errors).toEqual(['direct boom']);
});

test('scanViaDirect: captures a non-Error failure', async () => {
  const result = await scanViaDirect('codex', buildScanOptions('gw', undefined), () => {
    throw 'plain failure';
  });
  expect(result.errors).toEqual(['plain failure']);
});

test('scanViaWorker: resolves a successful worker message', async () => {
  const result = await scanViaWorker('codex', buildScanOptions('gw', undefined), () =>
    fakeWorker((worker) => {
      worker.onmessage?.(
        asMessageEvent({
          data: { sourceName: 'codex', success: true, inspectResult: sampleInspectResult },
        }),
      );
    }),
  );
  expect(result.recordCount).toBe(3);
});

test('scanViaWorker: handles success:false with an error message', async () => {
  const result = await scanViaWorker('codex', buildScanOptions('gw', undefined), () =>
    fakeWorker((worker) => {
      worker.onmessage?.(
        asMessageEvent({
          data: { sourceName: 'codex', success: false, error: 'worker said no' },
        }),
      );
    }),
  );
  expect(result.errors).toEqual(['worker said no']);
});

test('scanViaWorker: handles success:false without an error message', async () => {
  const result = await scanViaWorker('codex', buildScanOptions('gw', undefined), () =>
    fakeWorker((worker) => {
      worker.onmessage?.(
        asMessageEvent({
          data: { sourceName: 'codex', success: false },
        }),
      );
    }),
  );
  expect(result.errors).toEqual(['inspect worker returned no result']);
});

test('scanViaWorker: handles a worker error event', async () => {
  const result = await scanViaWorker('codex', buildScanOptions('gw', undefined), () =>
    fakeWorker((worker) => {
      worker.onerror?.(new Error('worker crashed'));
    }),
  );
  expect(result.errors).toEqual(['inspect worker error']);
});

test('scanViaWorker: captures a worker-creation throw', async () => {
  const result = await scanViaWorker('codex', buildScanOptions('gw', undefined), () => {
    throw new Error('cannot spawn worker');
  });
  expect(result.errors).toEqual(['cannot spawn worker']);
});

test('scanSingleSource: compiled path runs the direct scan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxai-inspect-scan-'));
  try {
    const result = await scanSingleSource(
      'claude-code',
      deps,
      { baseDirs: { claudeCode: dir } },
      true,
    );
    expect(result.sourceName).toBe('claude-code');
    expect(result.filesProcessed).toBe(0);
    expect(result.errors).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scanSingleSource: worker path uses the default worker factory', async () => {
  const originalWorker = globalThis.Worker;
  class StubWorker {
    onmessage: ((event: { data: WorkerOutput }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    postMessage(): void {
      queueMicrotask(() => {
        this.onmessage?.({
          data: { sourceName: 'codex', success: true, inspectResult: sampleInspectResult },
        });
      });
    }
    terminate(): void {}
  }
  globalThis.Worker = asWorkerCtor(StubWorker);
  try {
    const result = await scanSingleSource('codex', deps, {}, false);
    expect(result.sourceName).toBe('codex');
    expect(result.recordCount).toBe(3);
  } finally {
    globalThis.Worker = originalWorker;
  }
});
