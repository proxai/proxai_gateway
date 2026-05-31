import { expect, test } from 'bun:test';

import { renderLogsFrame, renderLogsJson, shortPath } from 'cli/commands/logs/render-logs.ts';
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
  const record: UploadedRecord = {
    captureId: '0190abcd-0000-7000-8000-000000000001',
    sourceApp: 'claude-code',
    deliveredAt: '2026-05-08T02:46:52.293Z',
    watermarkKind: 'byte_range',
    sourcePathHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    idempotentOnServer: false,
    sourcePath: null,
    ...overrides,
  };
  return record;
}

function failed(overrides: Partial<FailedRecord> = {}): FailedRecord {
  const record: FailedRecord = {
    captureId: '0190abcd-0000-7000-8000-000000000002',
    sourceApp: 'codex',
    capturedAtUtc: '2026-05-08T02:40:00.000Z',
    sourcePath: '/home/user/project/session.jsonl',
    attempts: 3,
    lastError: 'server returned 500',
    sourcePathHash: null,
    ...overrides,
  };
  return record;
}

function quarantined(overrides: Partial<QuarantinedRecord> = {}): QuarantinedRecord {
  const record: QuarantinedRecord = {
    id: 1,
    sourceApp: 'cursor',
    sourcePath: '/home/user/project/state.vscdb',
    redactedSizeBytes: 3 * 1024 * 1024,
    reason: 'redacted body exceeds 2 MiB compressed limit',
    quarantinedAtUtc: '2026-05-08T02:30:00.000Z',
    sourcePathHash: null,
    ...overrides,
  };
  return record;
}

function pending(overrides: Partial<PendingRecord> = {}): PendingRecord {
  const record: PendingRecord = {
    captureId: '0190abcd-0000-7000-8000-000000000003',
    sourceApp: 'gemini-cli',
    capturedAtUtc: '2026-05-08T02:20:00.000Z',
    sourcePath: '/home/user/project/chat.jsonl',
    attempts: 0,
    sourcePathHash: null,
    ...overrides,
  };
  return record;
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

test('renderLogsFrame dynamically truncates overlong source paths in dev mode on narrow terminals', () => {
  const originalColumns = process.stdout.columns;
  try {
    Object.defineProperty(process.stdout, 'columns', {
      value: 80,
      configurable: true,
      writable: true,
    });
    const longPath = '/very/deep/' + 'segment/'.repeat(20) + 'file.jsonl';
    const frame: LogsFrame = { ...emptyFrame(), failed: [failed({ sourcePath: longPath })] };
    const out = stripAnsi(renderLogsFrame(frame, { error: true }, makeDeps(true)));
    expect(out).toContain('…');
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      configurable: true,
      writable: true,
    });
  }
});

test('renderLogsFrame does not truncate source paths in dev mode on wide terminals', () => {
  const originalColumns = process.stdout.columns;
  try {
    Object.defineProperty(process.stdout, 'columns', {
      value: 500,
      configurable: true,
      writable: true,
    });
    const longPath = '/very/deep/' + 'segment/'.repeat(20) + 'file.jsonl';
    const frame: LogsFrame = { ...emptyFrame(), failed: [failed({ sourcePath: longPath })] };
    const out = stripAnsi(renderLogsFrame(frame, { error: true }, makeDeps(true)));
    expect(out).not.toContain('…');
    // Normalize separators: the renderer relativizes the path with the native
    // separator, so this segment is `very\deep` on Windows.
    expect(out.replace(/\\/g, '/')).toContain('very/deep');
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      configurable: true,
      writable: true,
    });
  }
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

test('renderLogsFrame compact mode hides dev details even when isDevMode is true', () => {
  const originalColumns = process.stdout.columns;
  try {
    Object.defineProperty(process.stdout, 'columns', {
      value: 500,
      configurable: true,
      writable: true,
    });
    const frame: LogsFrame = {
      uploaded: [uploaded()],
      failed: [failed()],
      quarantined: [quarantined()],
      pending: [pending()],
    };
    const out = stripAnsi(renderLogsFrame(frame, { compact: true }, makeDeps(true)));

    expect(out).not.toContain('0190abcd-0000-7000-8000-000000000001');
    expect(out).not.toContain('hash:');
    expect(out).not.toContain('id:1');
    expect(out).toContain('session.jsonl');
    expect(out).toContain('state.vscdb');
    expect(out).toContain('chat.jsonl');
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      configurable: true,
      writable: true,
    });
  }
});

test('renderLogsJson serializes the frame to JSON', () => {
  const frame: LogsFrame = { ...emptyFrame(), uploaded: [uploaded()] };
  const json = JSON.parse(renderLogsJson(frame)) as LogsFrame;
  expect(json.uploaded[0]?.sourceApp).toBe('claude-code');
  expect(json.failed).toEqual([]);
});

test('renderLogsFrame fully restores and displays all diagnostic details in Developer Mode', () => {
  const originalColumns = process.stdout.columns;
  try {
    Object.defineProperty(process.stdout, 'columns', {
      value: 500,
      configurable: true,
      writable: true,
    });
    const frame: LogsFrame = {
      uploaded: [
        uploaded({
          sourcePath: '/home/user/project/uploaded.jsonl',
          sourcePathHash: 'uploadedhashvalue',
        }),
      ],
      failed: [
        failed({
          sourcePath: '/home/user/project/failed.jsonl',
          sourcePathHash: 'failedhashvalue',
        }),
      ],
      quarantined: [
        quarantined({
          sourcePath: '/home/user/project/quarantined.jsonl',
          sourcePathHash: 'quarantinedhashvalue',
        }),
      ],
      pending: [
        pending({
          sourcePath: '/home/user/project/pending.jsonl',
          sourcePathHash: 'pendinghashvalue',
        }),
      ],
    };
    const out = stripAnsi(renderLogsFrame(frame, {}, makeDeps(true)));

    expect(out).toContain('0190abcd-0000-7000-8000-000000000001');
    expect(out).toContain('0190abcd-0000-7000-8000-000000000002');
    expect(out).toContain('id:1');
    expect(out).toContain('0190abcd-0000-7000-8000-000000000003');

    expect(out).toContain('hash:uploadedhashvalue');
    expect(out).toContain('hash:failedhashvalue');
    expect(out).toContain('hash:quarantinedhashvalue');
    expect(out).toContain('hash:pendinghashvalue');

    expect(out).toContain('uploaded.jsonl');
    expect(out).toContain('failed.jsonl');
    expect(out).toContain('quarantined.jsonl');
    expect(out).toContain('pending.jsonl');
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      configurable: true,
      writable: true,
    });
  }
});

test('renderLogsFrame renders file paths correctly for regular users on wide viewports without truncation', () => {
  const originalColumns = process.stdout.columns;
  try {
    Object.defineProperty(process.stdout, 'columns', {
      value: 500,
      configurable: true,
      writable: true,
    });
    const frame: LogsFrame = {
      uploaded: [uploaded({ sourcePath: '/home/user/project/uploaded.jsonl' })],
      failed: [failed({ sourcePath: '/home/user/project/failed.jsonl' })],
      quarantined: [quarantined({ sourcePath: '/home/user/project/quarantined.jsonl' })],
      pending: [pending({ sourcePath: '/home/user/project/pending.jsonl' })],
    };
    const out = stripAnsi(renderLogsFrame(frame, {}, makeDeps(false)));

    expect(out).toContain('uploaded.jsonl');
    expect(out).toContain('failed.jsonl');
    expect(out).toContain('quarantined.jsonl');
    expect(out).toContain('pending.jsonl');
    expect(out).not.toContain('…');
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      configurable: true,
      writable: true,
    });
  }
});

test('renderLogsFrame renders file paths correctly for regular users on narrow viewports with middle truncation', () => {
  const originalColumns = process.stdout.columns;
  try {
    Object.defineProperty(process.stdout, 'columns', {
      value: 80,
      configurable: true,
      writable: true,
    });
    const longPath =
      '/home/user/project/very/long/nested/directory/structure/and/file/name/to/force/truncation.jsonl';
    const frame: LogsFrame = {
      uploaded: [uploaded({ sourcePath: longPath })],
      failed: [failed({ sourcePath: longPath })],
      quarantined: [quarantined({ sourcePath: longPath })],
      pending: [pending({ sourcePath: longPath })],
    };
    const out = stripAnsi(renderLogsFrame(frame, {}, makeDeps(false)));

    expect(out).toContain('…');
    expect(out).toContain('.jsonl');
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      configurable: true,
      writable: true,
    });
  }
});

test('renderLogsFrame renders file paths correctly for dev users on wide viewports without truncation', () => {
  const originalColumns = process.stdout.columns;
  try {
    Object.defineProperty(process.stdout, 'columns', {
      value: 500,
      configurable: true,
      writable: true,
    });
    const frame: LogsFrame = {
      uploaded: [uploaded({ sourcePath: '/home/user/project/uploaded.jsonl' })],
      failed: [failed({ sourcePath: '/home/user/project/failed.jsonl' })],
      quarantined: [quarantined({ sourcePath: '/home/user/project/quarantined.jsonl' })],
      pending: [pending({ sourcePath: '/home/user/project/pending.jsonl' })],
    };
    const out = stripAnsi(renderLogsFrame(frame, {}, makeDeps(true)));

    expect(out).toContain('uploaded.jsonl');
    expect(out).toContain('failed.jsonl');
    expect(out).toContain('quarantined.jsonl');
    expect(out).toContain('pending.jsonl');
    expect(out).not.toContain('…');
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      configurable: true,
      writable: true,
    });
  }
});

test('renderLogsFrame renders file paths correctly for dev users on narrow viewports with middle truncation', () => {
  const originalColumns = process.stdout.columns;
  try {
    Object.defineProperty(process.stdout, 'columns', {
      value: 80,
      configurable: true,
      writable: true,
    });
    const longPath =
      '/home/user/project/very/long/nested/directory/structure/and/file/name/to/force/truncation.jsonl';
    const frame: LogsFrame = {
      uploaded: [uploaded({ sourcePath: longPath })],
      failed: [failed({ sourcePath: longPath })],
      quarantined: [quarantined({ sourcePath: longPath })],
      pending: [pending({ sourcePath: longPath })],
    };
    const out = stripAnsi(renderLogsFrame(frame, {}, makeDeps(true)));

    expect(out).toContain('…');
    expect(out).toContain('.jsonl');
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      configurable: true,
      writable: true,
    });
  }
});

test('shortPath: handles edge cases', () => {
  expect(shortPath('abcdef', 0)).toBe('');
  expect(shortPath('abcdef', -5)).toBe('');
  expect(shortPath('abcdef', 3)).toBe('ab…');
  expect(shortPath('abcdef', 5)).toBe('abcd…');
  expect(shortPath('abc', 5)).toBe('abc');
});

test('renderLogsFrame handles empty or relative sourcePath on failed, quarantined, and pending rows', () => {
  const frame: LogsFrame = {
    uploaded: [],
    failed: [
      failed({ sourcePath: null as unknown as string }),
      failed({ sourcePath: 'relative/path.json' }),
    ],
    quarantined: [
      quarantined({ sourcePath: null as unknown as string }),
      quarantined({ sourcePath: 'relative/path.json' }),
    ],
    pending: [
      pending({ sourcePath: null as unknown as string }),
      pending({ sourcePath: 'relative/path.json' }),
    ],
  };
  const out = stripAnsi(renderLogsFrame(frame, {}, makeDeps(false)));
  expect(out).toContain('relative/path.json');
});

test('renderLogsFrame handles columns defaulting when process.stdout.columns is absent or zero', () => {
  const originalColumns = process.stdout.columns;
  try {
    Object.defineProperty(process.stdout, 'columns', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const frame: LogsFrame = {
      ...emptyFrame(),
      uploaded: [uploaded({ sourcePath: '/home/user/uploaded.json' })],
    };
    const out = stripAnsi(renderLogsFrame(frame, {}, makeDeps(false)));
    expect(out).toContain('uploaded.json');
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      configurable: true,
      writable: true,
    });
  }
});

test('renderLogsFrame static mode does not append quit help text', () => {
  const out = stripAnsi(renderLogsFrame(emptyFrame(), { static: true }, makeDeps(false)));
  expect(out).not.toContain('Press q or Esc to quit');
});
