import { expect, test } from 'bun:test';

import { renderLogsFrame, renderLogsJson } from 'cli/commands/logs/render-logs.ts';
import type {
  FailedRecord,
  LogsCommandDeps,
  LogsCommandOptions,
  LogsFrame,
  PendingRecord,
  QuarantinedRecord,
  UploadedRecord,
} from 'cli/commands/logs/logs.types.ts';
import { captureOutput } from 'cli/output.ts';

function stripAnsi(s: string): string {
  const ESC = String.fromCharCode(27);
  const ESC2 = String.fromCharCode(155);
  const ANSI_PATTERN = new RegExp(
    '[' + ESC + ESC2 + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]',
    'g',
  );
  return s.replace(ANSI_PATTERN, '');
}

function makeDeps(isDevMode: boolean): LogsCommandDeps {
  return {
    output: captureOutput(),
    buffer: null,
    isDevMode,
  };
}

function uploaded(overrides: Partial<UploadedRecord> = {}): UploadedRecord {
  return {
    captureId: '0190abcd-0000-7000-8000-000000000001',
    sourceApp: 'claude-code',
    deliveredAt: '2026-05-08T02:46:52.293Z',
    watermarkKind: 'byte_range',
    sourcePathHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    idempotentOnServer: false,
    ...overrides,
  };
}

function failed(overrides: Partial<FailedRecord> = {}): FailedRecord {
  return {
    captureId: '0190abcd-0000-7000-8000-000000000002',
    sourceApp: 'codex',
    capturedAtUtc: '2026-05-08T02:40:00.000Z',
    sourcePath: '/home/user/project/session.jsonl',
    attempts: 3,
    lastError: 'server returned 500',
    ...overrides,
  };
}

function quarantined(overrides: Partial<QuarantinedRecord> = {}): QuarantinedRecord {
  return {
    id: 1,
    sourceApp: 'cursor',
    sourcePath: '/home/user/project/state.vscdb',
    redactedSizeBytes: 3 * 1024 * 1024,
    reason: 'redacted body exceeds 2 MiB compressed limit',
    quarantinedAtUtc: '2026-05-08T02:30:00.000Z',
    ...overrides,
  };
}

function pending(overrides: Partial<PendingRecord> = {}): PendingRecord {
  return {
    captureId: '0190abcd-0000-7000-8000-000000000003',
    sourceApp: 'gemini-cli',
    capturedAtUtc: '2026-05-08T02:20:00.000Z',
    sourcePath: '/home/user/project/chat.jsonl',
    attempts: 0,
    ...overrides,
  };
}

function emptyFrame(): LogsFrame {
  return { uploaded: [], failed: [], quarantined: [], pending: [] };
}

test('renderLogsFrame default brevity hides capture id and hash in prod mode', () => {
  const frame: LogsFrame = { ...emptyFrame(), uploaded: [uploaded()] };
  const opts: LogsCommandOptions = {};
  const out = stripAnsi(renderLogsFrame(frame, opts, makeDeps(false)));
  expect(out).toContain('Uploaded');
  expect(out).toContain('claude-code');
  expect(out).not.toContain('hash:');
  expect(out).not.toContain('0190abcd-0000-7000-8000-000000000001');
});

test('renderLogsFrame dev mode adds capture id and source path hash detail', () => {
  const frame: LogsFrame = { ...emptyFrame(), uploaded: [uploaded()] };
  const opts: LogsCommandOptions = {};
  const out = stripAnsi(renderLogsFrame(frame, opts, makeDeps(true)));
  expect(out).toContain('0190abcd-0000-7000-8000-000000000001');
  expect(out).toContain('hash:abcdef01');
});

test('renderLogsFrame marks idempotent uploads as re-sent', () => {
  const frame: LogsFrame = {
    ...emptyFrame(),
    uploaded: [uploaded({ idempotentOnServer: true })],
  };
  const out = stripAnsi(renderLogsFrame(frame, {}, makeDeps(false)));
  expect(out).toContain('(re-sent)');
});

test('renderLogsFrame renders failed rows with attempts and truncated error', () => {
  const longError = 'x'.repeat(120);
  const frame: LogsFrame = { ...emptyFrame(), failed: [failed({ lastError: longError })] };
  const out = stripAnsi(renderLogsFrame(frame, { error: true }, makeDeps(false)));
  expect(out).toContain('Failed');
  expect(out).toContain('codex');
  expect(out).toContain('attempts: 3');
  expect(out).toContain('…');
  expect(out).not.toContain(longError);
});

test('renderLogsFrame omits error text when lastError is null', () => {
  const frame: LogsFrame = { ...emptyFrame(), failed: [failed({ lastError: null })] };
  const out = stripAnsi(renderLogsFrame(frame, { error: true }, makeDeps(false)));
  expect(out).toContain('attempts: 3');
  expect(out).not.toContain('server returned 500');
});

test('renderLogsFrame renders quarantined rows with size and reason', () => {
  const frame: LogsFrame = { ...emptyFrame(), quarantined: [quarantined()] };
  const out = stripAnsi(renderLogsFrame(frame, { error: true }, makeDeps(false)));
  expect(out).toContain('Quarantined');
  expect(out).toContain('cursor');
  expect(out).toContain('MB');
  expect(out).toContain('redacted body exceeds');
});

test('renderLogsFrame truncates an overlong source path', () => {
  const longPath = '/very/deep/' + 'segment/'.repeat(20) + 'file.jsonl';
  const frame: LogsFrame = { ...emptyFrame(), failed: [failed({ sourcePath: longPath })] };
  const out = stripAnsi(renderLogsFrame(frame, { error: true }, makeDeps(false)));
  expect(out).toContain('…');
  expect(out).not.toContain(longPath);
});

test('renderLogsFrame renders pending rows with attempts when present', () => {
  const frame: LogsFrame = {
    ...emptyFrame(),
    pending: [pending({ attempts: 2 })],
  };
  const out = stripAnsi(renderLogsFrame(frame, { pending: true }, makeDeps(false)));
  expect(out).toContain('Pending');
  expect(out).toContain('gemini-cli');
  expect(out).toContain('attempts:2');
});

test('renderLogsFrame omits attempts suffix for zero-attempt pending rows', () => {
  const frame: LogsFrame = { ...emptyFrame(), pending: [pending({ attempts: 0 })] };
  const out = stripAnsi(renderLogsFrame(frame, { pending: true }, makeDeps(false)));
  expect(out).toContain('Pending');
  expect(out).not.toContain('attempts:');
});

test('renderLogsFrame shows no-uploaded message for empty default frame', () => {
  const out = stripAnsi(renderLogsFrame(emptyFrame(), {}, makeDeps(false)));
  expect(out).toContain('No uploaded records yet.');
});

test('renderLogsFrame shows no-errors message for empty error frame', () => {
  const out = stripAnsi(renderLogsFrame(emptyFrame(), { error: true }, makeDeps(false)));
  expect(out).toContain('No errors found.');
});

test('renderLogsFrame shows no-pending message for empty pending frame', () => {
  const out = stripAnsi(renderLogsFrame(emptyFrame(), { pending: true }, makeDeps(false)));
  expect(out).toContain('No pending records.');
});

test('renderLogsJson serializes the frame to JSON', () => {
  const frame: LogsFrame = { ...emptyFrame(), uploaded: [uploaded()] };
  const json = JSON.parse(renderLogsJson(frame)) as LogsFrame;
  expect(json.uploaded[0]?.sourceApp).toBe('claude-code');
  expect(json.failed).toEqual([]);
});
