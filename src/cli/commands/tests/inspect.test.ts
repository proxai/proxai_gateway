import { afterEach, beforeEach, expect, test, mock } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let shouldFailFs = false;

mock.module('node:fs/promises', () => {
  const actual = import.meta.require('node:fs/promises');
  return {
    ...actual,
    mkdir: async (path: any, options: any) => {
      if (shouldFailFs) {
        throw new Error('Mock fs.mkdir error');
      }
      return actual.mkdir(path, options);
    },
    writeFile: async (path: any, data: any, options: any) => {
      if (shouldFailFs) {
        throw new Error('Mock fs.writeFile error');
      }
      return actual.writeFile(path, data, options);
    },
  };
});

import { runInspect } from 'cli/commands/inspect.ts';
import { captureOutput } from 'cli/output.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'proxai-cli-inspect-'));
});

afterEach(async () => {
  await rmRecursive(tempDir);
});

test('runInspect executes successfully with empty directories', async () => {
  const out = captureOutput();
  const result = await runInspect(
    {
      output: out,
      configExists: () => Promise.resolve(true),
      gatewayVersion: '1.0.0',
    },
    {
      baseDirs: {
        claudeCode: tempDir,
        cursor: tempDir,
        geminiCli: tempDir,
        codex: tempDir,
      },
    },
  );

  expect(result.exitCode).toBe(0);

  expect(out.lines.some((l) => l.msg.includes('ProxAI Telemetry Dry-Run Inspection'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('TELEMETRY SOURCES ON DISK'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('Highlights'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('Beautiful dry-run markdown report saved to'))).toBe(
    true,
  );
});

test('runInspect handles worker success with oldest record', async () => {
  const out = captureOutput();
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class MockWorker {
    onmessage: any = null;
    onerror: any = null;
    postMessage(..._args: any[]) {
      setTimeout(() => {
        if (this.onmessage) {
          this.onmessage({
            data: {
              success: true,
              inspectResult: {
                filesProcessed: 5,
                recordCount: 42,
                totalBytes: 1337,
                telemetryRawBytes: 1000,
                telemetryCompressedBytes: 167,
                telemetryRecordCount: 42,
                oldestDate: '2026-05-20T20:00:00.000Z',
              },
            },
          });
        }
      }, 0);
    }
    terminate() {}
  } as any;
  try {
    const result = await runInspect({
      output: out,
      configExists: () => Promise.resolve(true),
      gatewayVersion: '1.0.0',
    });
    expect(result.exitCode).toBe(0);
    expect(out.lines.some((l) => l.msg.includes('42'))).toBe(true);
    expect(out.lines.some((l) => l.msg.includes('1.31 KB'))).toBe(true);
    expect(out.lines.some((l) => l.msg.includes('Oldest telemetry record'))).toBe(true);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('runInspect handles worker success with success: false', async () => {
  const out = captureOutput();
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class MockWorker {
    onmessage: any = null;
    postMessage(..._args: any[]) {
      setTimeout(() => {
        if (this.onmessage) this.onmessage({ data: { success: false } });
      }, 0);
    }
    terminate() {}
  } as any;
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

test('runInspect handles worker onerror', async () => {
  const out = captureOutput();
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class MockWorker {
    onerror: any = null;
    postMessage(..._args: any[]) {
      setTimeout(() => {
        if (this.onerror) this.onerror(new ErrorEvent('error'));
      }, 0);
    }
    terminate() {}
  } as any;
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

test('runInspect handles worker constructor throw exception', async () => {
  const out = captureOutput();
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class MockWorker {
    constructor(..._args: any[]) {
      throw new Error('Constructor boom');
    }
    postMessage() {}
    terminate() {}
  } as any;
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

test('runInspect handles markdown report save failure gracefully', async () => {
  const out = captureOutput();
  shouldFailFs = true;
  try {
    const result = await runInspect(
      {
        output: out,
        configExists: () => Promise.resolve(true),
        gatewayVersion: '1.0.0',
      },
      {
        baseDirs: {
          claudeCode: tempDir,
          cursor: tempDir,
          geminiCli: tempDir,
          codex: tempDir,
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(out.lines.some((l) => l.msg.includes('Failed to save markdown report'))).toBe(true);
  } finally {
    shouldFailFs = false;
  }
});

test('runInspect handles unexpected inspect error gracefully', async () => {
  const out = captureOutput();
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class MockWorker {
    onmessage: any = null;
    postMessage(..._args: any[]) {
      setTimeout(() => {
        if (this.onmessage) {
          this.onmessage({
            data: {
              success: true,
              inspectResult: {
                filesProcessed: 5,
                recordCount: 42,
                totalBytes: 1337,
                telemetryRawBytes: 1000,
                telemetryCompressedBytes: 167,
                telemetryRecordCount: 42,
                oldestDate: '2026-05-20T20:00:00.000Z',
              },
            },
          });
        }
      }, 0);
    }
    terminate() {}
  } as any;

  const originalParse = Date.parse;
  Date.parse = () => {
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
    expect(out.lines.some((l) => l.msg.includes('Inspection failed after'))).toBe(true);
  } finally {
    globalThis.Worker = originalWorker;
    Date.parse = originalParse;
  }
});
