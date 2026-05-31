import { expect, test } from 'bun:test';

import { renderLogsFrame, renderLogsJson } from 'cli/commands/logs/render-logs.ts';
import type {
  CaptureLookup,
  FailedRecord,
  LogsCommandOptions,
  LogsFrame,
  PendingRecord,
  QuarantinedRecord,
  UploadedRecord,
} from 'cli/commands/logs/logs.types.ts';

function stripAnsi(s: string): string {
  const ESC = String.fromCharCode(27);
  const ESC2 = String.fromCharCode(155);
  const ANSI_PATTERN = new RegExp(
    '[' + ESC + ESC2 + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]',
    'g',
  );
  return s.replace(ANSI_PATTERN, '');
}

function uploaded(overrides: Partial<UploadedRecord> = {}): UploadedRecord {
  return {
    captureId: '0190abcd-0000-7000-8000-000000000001',
    sourceApp: 'claude-code',
    deliveredAt: '2026-05-08T02:46:52.293Z',
    idempotentOnServer: false,
    userPrompt: 'Refactor the auth middleware',
    userPromptAddedAt: '2026-05-08T02:46:50.000Z',
    sourcePath: '/home/user/project/session.jsonl',
    sourcePathHash: 'abcdef0123',
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: 1024,
    watermarkTable: null,
    agentSchemaVersion: 'claude-code/1.0.0',
    gatewayVersion: '2026.5.8',
    capturedAtUtc: '2026-05-08T02:46:00.000Z',
    shippedBytes: 4096,
    attempts: 1,
    ...overrides,
  };
}

function failed(overrides: Partial<FailedRecord> = {}): FailedRecord {
  return {
    captureId: '0190abcd-0000-7000-8000-000000000002',
    sourceApp: 'codex',
    capturedAtUtc: '2026-05-08T02:40:00.000Z',
    sourcePath: '/home/user/project/session.jsonl',
    sourcePathHash: 'failedhash',
    attempts: 3,
    lastError: 'server returned 500',
    userPrompt: 'Write a test',
    assistantResponse: 'Here is a test',
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: 512,
    watermarkTable: null,
    agentSchemaVersion: 'codex/2.0',
    gatewayVersion: '2026.5.8',
    sourceInode: 42,
    sizeBytes: 2048,
    ...overrides,
  };
}

function pending(overrides: Partial<PendingRecord> = {}): PendingRecord {
  return {
    captureId: '0190abcd-0000-7000-8000-000000000003',
    sourceApp: 'gemini-cli',
    capturedAtUtc: '2026-05-08T02:20:00.000Z',
    sourcePath: '/home/user/project/chat.jsonl',
    sourcePathHash: 'pendinghash',
    attempts: 0,
    userPrompt: 'Summarize this',
    assistantResponse: null,
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: 256,
    watermarkTable: null,
    agentSchemaVersion: 'gemini-cli/3.0',
    gatewayVersion: '2026.5.8',
    sourceInode: 7,
    sizeBytes: 1024,
    ...overrides,
  };
}

function quarantined(overrides: Partial<QuarantinedRecord> = {}): QuarantinedRecord {
  return {
    id: 1,
    sourceApp: 'cursor',
    sourcePath: '/home/user/project/state.vscdb',
    sourcePathHash: 'quarhash',
    redactedSizeBytes: 3 * 1024 * 1024,
    reason: 'redacted body exceeds 2 MiB compressed limit',
    quarantinedAtUtc: '2026-05-08T02:30:00.000Z',
    ...overrides,
  };
}

function frame(overrides: Partial<LogsFrame> = {}): LogsFrame {
  return {
    uploaded: [],
    failed: [],
    quarantined: [],
    pending: [],
    detail: null,
    idQuery: null,
    ...overrides,
  };
}

function render(f: LogsFrame, opts: LogsCommandOptions = {}): string {
  return stripAnsi(renderLogsFrame(f, opts));
}

test('uploaded row shows time, source, prompt preview, and status; no source path', () => {
  const out = render(frame({ uploaded: [uploaded()] }));
  expect(out).toContain('Uploaded');
  expect(out).toContain('claude-code');
  expect(out).toContain('Refactor the auth middleware');
  expect(out).toContain('uploaded');
  expect(out).not.toContain('session.jsonl');
});

test('uploaded row marks idempotent deliveries as re-sent', () => {
  const out = render(frame({ uploaded: [uploaded({ idempotentOnServer: true })] }));
  expect(out).toContain('re-sent');
});

test('prompt preview truncates to 100 chars and collapses whitespace', () => {
  const longPrompt = `first   line\nsecond ${'x'.repeat(200)}`;
  const out = render(frame({ uploaded: [uploaded({ userPrompt: longPrompt })] }));
  expect(out).toContain('first line second');
  expect(out).toContain('…');
  expect(out).not.toContain('x'.repeat(150));
});

test('prompt preview shows a placeholder when the prompt is null or blank', () => {
  expect(render(frame({ uploaded: [uploaded({ userPrompt: null })] }))).toContain(
    '(no prompt captured)',
  );
  expect(render(frame({ uploaded: [uploaded({ userPrompt: '   ' })] }))).toContain(
    '(no prompt captured)',
  );
});

test('failed row shows prompt, failed status, attempts, and a truncated error', () => {
  const out = render(frame({ failed: [failed({ lastError: 'y'.repeat(120) })] }), { failed: true });
  expect(out).toContain('Failed');
  expect(out).toContain('codex');
  expect(out).toContain('Write a test');
  expect(out).toContain('failed');
  expect(out).toContain('(3x)');
  expect(out).toContain('…');
  expect(out).not.toContain('y'.repeat(120));
});

test('failed row omits the error text when lastError is null', () => {
  const out = render(frame({ failed: [failed({ lastError: null })] }), { failed: true });
  expect(out).toContain('(3x)');
  expect(out).not.toContain('server returned 500');
});

test('pending row shows attempts only when present', () => {
  expect(render(frame({ pending: [pending({ attempts: 2 })] }), { pending: true })).toContain(
    '(2x)',
  );
  const zero = render(frame({ pending: [pending({ attempts: 0 })] }), { pending: true });
  expect(zero).toContain('pending');
  expect(zero).not.toContain('(0x)');
});

test('quarantined row shows size and reason', () => {
  const out = render(frame({ quarantined: [quarantined()] }), { failed: true });
  expect(out).toContain('Quarantined');
  expect(out).toContain('cursor');
  expect(out).toContain('MB');
  expect(out).toContain('redacted body exceeds');
});

test('verbose uploaded detail shows full prompt and notes the response is not retained', () => {
  const out = render(frame({ uploaded: [uploaded({ userPrompt: 'line one\nline two' })] }), {
    verbose: true,
  });
  expect(out).toContain('capture_id');
  expect(out).toContain('line one');
  expect(out).toContain('line two');
  expect(out).toContain('not retained after upload');
  expect(out).toContain('0 → 1024 (byte_range)');
  expect(out).toContain('agent claude-code/1.0.0 · gateway 2026.5.8');
});

test('verbose uploaded detail handles a null prompt and null detail fields', () => {
  const out = render(
    frame({
      uploaded: [
        uploaded({
          userPrompt: null,
          sourcePath: null,
          agentSchemaVersion: null,
          gatewayVersion: null,
          shippedBytes: null,
          attempts: null,
        }),
      ],
    }),
    { verbose: true },
  );
  expect(out).toContain('(no prompt captured)');
  expect(out).toContain('agent — · gateway —');
});

test('verbose failed detail shows prompt, assistant response, and error', () => {
  const out = render(frame({ failed: [failed()] }), { verbose: true });
  expect(out).toContain('Write a test');
  expect(out).toContain('Here is a test');
  expect(out).toContain('server returned 500');
  expect(out).toContain('0 → 512 (byte_range)');
});

test('verbose failed detail handles missing extracted fields', () => {
  const out = render(
    frame({
      failed: [
        failed({
          userPrompt: null,
          assistantResponse: null,
          lastError: null,
          sourcePathHash: null,
        }),
      ],
    }),
    { verbose: true },
  );
  expect(out).toContain('(no prompt found in body)');
  expect(out).toContain('(no assistant response found in body)');
});

test('verbose pending detail shows prompt and response placeholders', () => {
  const out = render(frame({ pending: [pending()] }), { verbose: true });
  expect(out).toContain('Summarize this');
  expect(out).toContain('(no assistant response found in body)');
});

test('id view renders the resolved uploaded detail', () => {
  const detail: CaptureLookup = { kind: 'uploaded', record: uploaded() };
  const out = render(frame({ detail, idQuery: '0190abcd' }));
  expect(out).toContain('capture_id');
  expect(out).toContain('Refactor the auth middleware');
});

test('id view renders failed and pending details', () => {
  const failedOut = render(frame({ detail: { kind: 'failed', record: failed() }, idQuery: 'x' }));
  expect(failedOut).toContain('Here is a test');
  const pendingOut = render(
    frame({ detail: { kind: 'pending', record: pending() }, idQuery: 'x' }),
  );
  expect(pendingOut).toContain('Summarize this');
});

test('id view reports when no record is found', () => {
  const out = render(frame({ detail: null, idQuery: 'deadbeef' }));
  expect(out).toContain("No record found for id 'deadbeef'.");
});

test('empty frames show a mode-appropriate message', () => {
  expect(render(frame({}))).toContain('No uploaded records yet.');
  expect(render(frame({}), { failed: true })).toContain('No failed or quarantined records.');
  expect(render(frame({}), { pending: true })).toContain('No pending records.');
});

test('watch mode appends quit help; static does not', () => {
  expect(render(frame({}))).toContain('Press q or Esc to quit');
  expect(render(frame({}), { static: true })).not.toContain('Press q or Esc to quit');
  expect(render(frame({}), { json: true })).not.toContain('Press q or Esc to quit');
});

test('renderLogsJson serializes the frame without body bytes', () => {
  const json = JSON.parse(
    renderLogsJson(frame({ uploaded: [uploaded()], failed: [failed()] })),
  ) as LogsFrame;
  expect(json.uploaded[0]?.sourceApp).toBe('claude-code');
  expect(json.failed[0]?.userPrompt).toBe('Write a test');
  expect(JSON.stringify(json)).not.toContain('body');
});
