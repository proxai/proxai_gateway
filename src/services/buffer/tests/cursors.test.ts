import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import {
  getCursor,
  hasAnyCursor,
  openInMemoryBufferDb,
  setCursor,
  setCursorFromRegression,
  countCapturedConversations,
  type CursorKey,
} from 'services/buffer';

let db: Database;

beforeEach(() => {
  db = openInMemoryBufferDb();
});

afterEach(() => {
  db.close();
});

test('getCursor returns null when missing', () => {
  const key: CursorKey = {
    sourceApp: 'claude-code',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: 1,
    watermarkTable: null,
  };
  expect(getCursor(db, key)).toBeNull();
});

test('setCursor + getCursor round-trip', () => {
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'a'.repeat(64),
    sourcePath: '/path',
    sourceInode: 1,
    watermarkTable: null,
    watermarkEnd: 1024,
  });
  const state = getCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: 1,
    watermarkTable: null,
  });
  expect(state?.watermarkEnd).toBe(1024);
  expect(state?.consecutiveErrors).toBe(0);
});

test('setCursor upserts on conflict', () => {
  const key = {
    sourceApp: 'claude-code' as const,
    sourcePathHash: 'a'.repeat(64),
    sourcePath: '/path',
    sourceInode: 1,
    watermarkTable: null,
  };
  setCursor(db, { ...key, watermarkEnd: 100 });
  setCursor(db, { ...key, watermarkEnd: 500, consecutiveErrors: 3 });
  const state = getCursor(db, key)!;
  expect(state.watermarkEnd).toBe(500);
  expect(state.consecutiveErrors).toBe(3);
});

test('cursor distinguishes inode rotations as separate rows', () => {
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'a'.repeat(64),
    sourcePath: '/path',
    sourceInode: 1,
    watermarkTable: null,
    watermarkEnd: 100,
  });
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'a'.repeat(64),
    sourcePath: '/path',
    sourceInode: 2,
    watermarkTable: null,
    watermarkEnd: 200,
  });
  expect(
    getCursor(db, {
      sourceApp: 'claude-code',
      sourcePathHash: 'a'.repeat(64),
      sourceInode: 1,
      watermarkTable: null,
    })?.watermarkEnd,
  ).toBe(100);
  expect(
    getCursor(db, {
      sourceApp: 'claude-code',
      sourcePathHash: 'a'.repeat(64),
      sourceInode: 2,
      watermarkTable: null,
    })?.watermarkEnd,
  ).toBe(200);
});

test('cursor distinguishes codex tables as separate rows', () => {
  for (const table of ['threads', 'thread_dynamic_tools', 'thread_spawn_edges']) {
    setCursor(db, {
      sourceApp: 'codex',
      sourcePathHash: 'a'.repeat(64),
      sourcePath: '/path',
      sourceInode: null,
      watermarkTable: table,
      watermarkEnd: table.length * 10,
    });
  }
  for (const table of ['threads', 'thread_dynamic_tools', 'thread_spawn_edges']) {
    expect(
      getCursor(db, {
        sourceApp: 'codex',
        sourcePathHash: 'a'.repeat(64),
        sourceInode: null,
        watermarkTable: table,
      })?.watermarkEnd,
    ).toBe(table.length * 10);
  }
});

test('null inode and null table map to sentinels in storage', () => {
  setCursor(db, {
    sourceApp: 'cursor',
    sourcePathHash: 'a'.repeat(64),
    sourcePath: '/path',
    sourceInode: null,
    watermarkTable: null,
    watermarkEnd: 50,
  });
  const state = getCursor(db, {
    sourceApp: 'cursor',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: null,
    watermarkTable: null,
  });
  expect(state?.watermarkEnd).toBe(50);
});

test('hasAnyCursor returns false on an empty cursor table', () => {
  expect(hasAnyCursor(db, 'claude-code')).toBe(false);
  expect(hasAnyCursor(db, 'cursor')).toBe(false);
  expect(hasAnyCursor(db, 'codex')).toBe(false);
});

test('hasAnyCursor returns true once a cursor exists for the app', () => {
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'a'.repeat(64),
    sourcePath: '/path',
    sourceInode: 1,
    watermarkTable: null,
    watermarkEnd: 100,
  });
  expect(hasAnyCursor(db, 'claude-code')).toBe(true);

  expect(hasAnyCursor(db, 'cursor')).toBe(false);
  expect(hasAnyCursor(db, 'codex')).toBe(false);
});

test('setCursorFromRegression preserves vacuum-detection baselines on the prior cursor row', () => {
  const key = {
    sourceApp: 'cursor' as const,
    sourcePathHash: 'a'.repeat(64),
    sourcePath: '/path',
    sourceInode: null,
    watermarkTable: null,
  };
  setCursor(db, {
    ...key,
    watermarkEnd: 100,
    lastSeenSizeBytes: 9_999_999,
    lastSeenPageCount: 4321,
  });
  setCursorFromRegression(db, { ...key }, 50);
  const after = getCursor(db, {
    sourceApp: 'cursor',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: null,
    watermarkTable: null,
  });
  expect(after?.watermarkEnd).toBe(50);
  expect(after?.lastSeenSizeBytes).toBe(9_999_999);
  expect(after?.lastSeenPageCount).toBe(4321);
});

test('setCursorFromRegression leaves baselines null when no prior cursor exists', () => {
  setCursorFromRegression(
    db,
    {
      sourceApp: 'cursor',
      sourcePath: '/path-new',
      sourcePathHash: 'b'.repeat(64),
      sourceInode: null,
      watermarkTable: null,
    },
    1,
  );
  const after = getCursor(db, {
    sourceApp: 'cursor',
    sourcePathHash: 'b'.repeat(64),
    sourceInode: null,
    watermarkTable: null,
  });
  expect(after?.lastSeenSizeBytes).toBeNull();
  expect(after?.lastSeenPageCount).toBeNull();
});

test('hasAnyCursor scopes to source app, not to a specific path', () => {
  setCursor(db, {
    sourceApp: 'cursor',
    sourcePathHash: 'a'.repeat(64),
    sourcePath: '/some/state.vscdb',
    sourceInode: null,
    watermarkTable: null,
    watermarkEnd: 5,
  });
  expect(hasAnyCursor(db, 'cursor')).toBe(true);
  expect(hasAnyCursor(db, 'claude-code')).toBe(false);
});

test('countCapturedConversations returns accurate counts per source app', () => {
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'a'.repeat(64),
    sourcePath: '/path/1',
    sourceInode: 1,
    watermarkTable: null,
    watermarkEnd: 10,
  });

  setCursor(db, {
    sourceApp: 'cursor',
    sourcePathHash: 'b'.repeat(64),
    sourcePath: '/path/2',
    sourceInode: 2,
    watermarkTable: null,
    watermarkEnd: 20,
  });

  setCursor(db, {
    sourceApp: 'gemini-cli',
    sourcePathHash: 'c'.repeat(64),
    sourcePath: '/path/3',
    sourceInode: 3,
    watermarkTable: null,
    watermarkEnd: 30,
  });

  setCursor(db, {
    sourceApp: 'codex',
    sourcePathHash: 'd'.repeat(64),
    sourcePath: '/path/4',
    sourceInode: null,
    watermarkTable: 'threads',
    watermarkEnd: 4,
  });

  setCursor(db, {
    sourceApp: 'codex',
    sourcePathHash: 'e'.repeat(64),
    sourcePath: '/path/5',
    sourceInode: null,
    watermarkTable: null,
    watermarkEnd: 5,
  });

  const counts = countCapturedConversations(db);
  expect(counts['claude-code']).toBe(1);
  expect(counts.cursor).toBe(1);
  expect(counts['gemini-cli']).toBe(1);
  expect(counts.codex).toBe(4);
});

test('setCursorFromRegression with non-null sourceInode and watermarkTable', () => {
  const key = {
    sourceApp: 'codex',
    sourcePath: '/path/6',
    sourcePathHash: 'f'.repeat(64),
    sourceInode: 42,
    watermarkTable: 'threads',
  };
  setCursorFromRegression(db, key, 12);
  const after = getCursor(db, {
    sourceApp: 'codex',
    sourcePathHash: 'f'.repeat(64),
    sourceInode: 42,
    watermarkTable: 'threads',
  });
  expect(after?.watermarkEnd).toBe(12);
  expect(after?.lastSeenSizeBytes).toBeNull();
  expect(after?.lastSeenPageCount).toBeNull();
});
