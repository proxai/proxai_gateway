import { requireDefined } from 'core/utils';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import {
  countCursors,
  getCursor,
  getCursorWithFallback,
  getHighestGenerationPath,
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
  const state = requireDefined(getCursor(db, key));
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

test('countCursors returns 0 on an empty db', () => {
  expect(countCursors(db)).toBe(0);
});

test('countCursors returns the total number of cursor rows', () => {
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'a'.repeat(64),
    sourcePath: '/path/a',
    sourceInode: 1,
    watermarkTable: null,
    watermarkEnd: 10,
  });
  setCursor(db, {
    sourceApp: 'cursor',
    sourcePathHash: 'b'.repeat(64),
    sourcePath: '/path/b',
    sourceInode: null,
    watermarkTable: null,
    watermarkEnd: 20,
  });
  expect(countCursors(db)).toBe(2);
});

test('getCursorWithFallback returns the exact cursor when it exists', () => {
  const key: CursorKey = {
    sourceApp: 'claude-code',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: 7,
    watermarkTable: null,
  };
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'a'.repeat(64),
    sourcePath: '/exact/path',
    sourceInode: 7,
    watermarkTable: null,
    watermarkEnd: 777,
  });
  const result = getCursorWithFallback(db, key);
  expect(result?.watermarkEnd).toBe(777);
});

test('getCursorWithFallback falls back to inode-less row when exact key is missing', () => {
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'a'.repeat(64),
    sourcePath: '/fallback/path',
    sourceInode: null,
    watermarkTable: null,
    watermarkEnd: 555,
  });
  const result = getCursorWithFallback(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: 99,
    watermarkTable: null,
  });
  expect(result?.watermarkEnd).toBe(555);
});

test('getCursorWithFallback returns null when exact key missing and inode is null', () => {
  const result = getCursorWithFallback(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'z'.repeat(64),
    sourceInode: null,
    watermarkTable: null,
  });
  expect(result).toBeNull();
});

test('getHighestGenerationPath returns the base path if no cursors exist', () => {
  const result = getHighestGenerationPath(db, 'claude-code', '/some/path');
  expect(result).toBe('/some/path');
});

test('getHighestGenerationPath returns the highest existing generation path', () => {
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'hash1',
    sourcePath: '/some/path',
    sourceInode: null,
    watermarkTable: 'table1',
    watermarkEnd: 10,
  });
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'hash2',
    sourcePath: '/some/path#gen=1',
    sourceInode: null,
    watermarkTable: 'table1',
    watermarkEnd: 20,
  });
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'hash3',
    sourcePath: '/some/path#gen=3',
    sourceInode: null,
    watermarkTable: 'table1',
    watermarkEnd: 30,
  });
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'hash4',
    sourcePath: '/some/path#gen=2',
    sourceInode: null,
    watermarkTable: 'table1',
    watermarkEnd: 25,
  });
  const result = getHighestGenerationPath(db, 'claude-code', '/some/path');
  expect(result).toBe('/some/path#gen=3');
});

test('getHighestGenerationPath escapes underscore literal in base path', () => {
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'hash_intended',
    sourcePath: '/p/a_b.sqlite#gen=1',
    sourceInode: null,
    watermarkTable: 'table1',
    watermarkEnd: 10,
  });
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'hash_sibling',
    sourcePath: '/p/aXb.sqlite#gen=2',
    sourceInode: null,
    watermarkTable: 'table1',
    watermarkEnd: 20,
  });
  const result = getHighestGenerationPath(db, 'claude-code', '/p/a_b.sqlite');
  expect(result).toBe('/p/a_b.sqlite#gen=1');
});

test('getHighestGenerationPath escapes percent literal in base path', () => {
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'hash_intended',
    sourcePath: '/p/a%b.sqlite#gen=1',
    sourceInode: null,
    watermarkTable: 'table1',
    watermarkEnd: 10,
  });
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'hash_sibling',
    sourcePath: '/p/aZZZb.sqlite#gen=3',
    sourceInode: null,
    watermarkTable: 'table1',
    watermarkEnd: 20,
  });
  const result = getHighestGenerationPath(db, 'claude-code', '/p/a%b.sqlite');
  expect(result).toBe('/p/a%b.sqlite#gen=1');
});
