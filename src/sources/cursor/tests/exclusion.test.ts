// src/sources/cursor/tests/exclusion.test.ts
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import {
  buildCursorGlobalExclusionPlan,
  exclusionEntriesRemoved,
  isCursorGlobalDb,
  normalizeExclusionSet,
} from 'sources/cursor/exclusion.ts';

// Build a protobuf conversationState referencing the given 32-byte hex hashes.
function conversationState(hexHashes: string[]): string {
  const parts: Buffer[] = [];
  for (const hex of hexHashes) {
    const raw = Buffer.from(hex, 'hex'); // 32 bytes
    parts.push(Buffer.from([0x0a, raw.length]));
    parts.push(raw);
  }
  return '~' + Buffer.concat(parts).toString('base64');
}

function makeGlobalDb(opts: {
  headers: Array<{ composerId: string; folder: string | null }>;
  composers: Array<{ composerId: string; hashes: string[] }>;
}): Database {
  const db = new Database(':memory:');
  db.run('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  db.run('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  db.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', [
    'composer.composerHeaders',
    JSON.stringify({
      allComposers: opts.headers.map((h) => ({
        composerId: h.composerId,
        workspaceIdentifier:
          h.folder === null
            ? { id: 'empty-window' }
            : { id: 'hash', uri: { external: `file://${h.folder}` } },
      })),
    }),
  ]);
  for (const c of opts.composers) {
    db.run('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)', [
      `composerData:${c.composerId}`,
      JSON.stringify({ conversationState: conversationState(c.hashes) }),
    ]);
  }
  return db;
}

const H = (n: number): string => n.toString(16).padStart(2, '0').repeat(32); // 32-byte hex

describe('isCursorGlobalDb', () => {
  it('classifies the global vs per-workspace state.vscdb by path', () => {
    expect(isCursorGlobalDb('/x/Cursor/User/globalStorage/state.vscdb')).toBe(true);
    expect(isCursorGlobalDb('/x/Cursor/User/workspaceStorage/abc/state.vscdb')).toBe(false);
  });
});

describe('buildCursorGlobalExclusionPlan', () => {
  it('excludes a composer in an excluded folder and drops its exclusive blobs', () => {
    const db = makeGlobalDb({
      headers: [
        { composerId: 'nest1', folder: '/Users/me/nest' },
        { composerId: 'web1', folder: '/Users/me/web' },
      ],
      composers: [
        { composerId: 'nest1', hashes: [H(1), H(2)] },
        { composerId: 'web1', hashes: [H(3)] },
      ],
    });
    const plan = buildCursorGlobalExclusionPlan(db, ['/Users/me/nest']);
    expect([...plan.excludedComposerIds].toSorted()).toEqual(['nest1']);
    expect([...plan.blobsToDrop].toSorted()).toEqual([H(1), H(2)].toSorted());
  });

  it('keeps a blob shared with a non-excluded composer (set difference)', () => {
    const db = makeGlobalDb({
      headers: [
        { composerId: 'nest1', folder: '/Users/me/nest' },
        { composerId: 'web1', folder: '/Users/me/web' },
      ],
      composers: [
        { composerId: 'nest1', hashes: [H(1), H(9)] },
        { composerId: 'web1', hashes: [H(9)] }, // H(9) shared
      ],
    });
    const plan = buildCursorGlobalExclusionPlan(db, ['/Users/me/nest']);
    expect(plan.blobsToDrop.has(H(1))).toBe(true);
    expect(plan.blobsToDrop.has(H(9))).toBe(false); // retained: web1 still needs it
  });

  it('fails open for composers with no resolvable folder', () => {
    const db = makeGlobalDb({
      headers: [{ composerId: 'ew1', folder: null }],
      composers: [{ composerId: 'ew1', hashes: [H(1)] }],
    });
    const plan = buildCursorGlobalExclusionPlan(db, ['/Users/me/nest']);
    expect(plan.excludedComposerIds.size).toBe(0);
    expect(plan.blobsToDrop.size).toBe(0);
  });

  it('returns an empty plan when the exclusion list is empty', () => {
    const db = makeGlobalDb({
      headers: [{ composerId: 'nest1', folder: '/Users/me/nest' }],
      composers: [{ composerId: 'nest1', hashes: [H(1)] }],
    });
    const plan = buildCursorGlobalExclusionPlan(db, []);
    expect(plan.excludedComposerIds.size).toBe(0);
    expect(plan.blobsToDrop.size).toBe(0);
  });

  it('does NOT drop blobs an excluded composer does not yet reference in conversationState', () => {
    const db = makeGlobalDb({
      headers: [{ composerId: 'nest1', folder: '/Users/me/nest' }],
      composers: [{ composerId: 'nest1', hashes: [] }], // conversationState references no blobs yet
    });
    const plan = buildCursorGlobalExclusionPlan(db, ['/Users/me/nest']);
    expect(plan.excludedComposerIds.has('nest1')).toBe(true);
    expect(plan.blobsToDrop.size).toBe(0);
  });

  it('fails open (no throw, empty plan) when the global DB has no ItemTable', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
    // no ItemTable at all (atypical/partial profile)
    const plan = buildCursorGlobalExclusionPlan(db, ['/Users/me/nest']);
    expect(plan.excludedComposerIds.size).toBe(0);
    expect(plan.blobsToDrop.size).toBe(0);
  });
});

describe('normalizeExclusionSet', () => {
  it('sorts, de-dupes, and drops blanks', () => {
    const out = normalizeExclusionSet(['/b', '', '/a', '/a']);
    expect(out).toEqual(['/a', '/b']);
  });
});

describe('exclusionEntriesRemoved', () => {
  it('is true when a stored entry is gone (un-excluded)', () => {
    expect(exclusionEntriesRemoved(JSON.stringify(['/a', '/b']), ['/a'])).toBe(true);
  });
  it('is false on first run (null) or pure additions', () => {
    expect(exclusionEntriesRemoved(null, ['/a'])).toBe(false);
    expect(exclusionEntriesRemoved(JSON.stringify(['/a']), ['/a', '/b'])).toBe(false);
  });
});
