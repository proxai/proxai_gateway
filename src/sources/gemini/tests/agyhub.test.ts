import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { GEMINI_AGYHUB_FILE } from 'sources/gemini/gemini.constants.ts';
import { geminiConversationIdFromPath, loadAgyhubFolderMap } from 'sources/gemini/agyhub.ts';

describe('geminiConversationIdFromPath', () => {
  it('extracts the conversation UUID from a transcript path', () => {
    expect(
      geminiConversationIdFromPath(
        '/x/.gemini/antigravity/brain/abc-123/.system_generated/logs/transcript.jsonl',
      ),
    ).toBe('abc-123');
  });
  it('returns empty string when there is no brain/<uuid> segment', () => {
    expect(geminiConversationIdFromPath('/x/y/transcript.jsonl')).toBe('');
  });
});

describe('loadAgyhubFolderMap', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'proxai-test-agyhub-'));
  });

  afterEach(async () => {
    await rmRecursive(dir);
  });

  it('returns an empty map + complete:true when the agyhub file is absent (fail-open)', () => {
    const { folders, complete } = loadAgyhubFolderMap('/nonexistent-agyhub-xyz');
    expect(folders.size).toBe(0);
    // A MISSING index is fail-open: there is no folder identity to protect, so the gate must not
    // pause on it (ENOENT -> nothing to lose).
    expect(complete).toBe(true);
  });

  it('returns complete:false when the agyhub file is PRESENT but zero bytes (fail-closed)', async () => {
    // A transiently-empty .pb (mid-write/truncated) must NOT be treated as "no index": an excluded
    // conversation could simply be absent from the empty map. Fail CLOSED so the gate pauses.
    await writeFile(join(dir, GEMINI_AGYHUB_FILE), new Uint8Array(0));
    const { folders, complete } = loadAgyhubFolderMap(dir);
    expect(folders.size).toBe(0);
    expect(complete).toBe(false);
  });

  it('returns complete:false when the file is present but decodes to ZERO entries (fail-closed)', async () => {
    // Non-empty buffer that yields no folder entries (e.g. unrelated/garbage protobuf) is also
    // unusable as a protection oracle -> fail closed.
    await writeFile(join(dir, GEMINI_AGYHUB_FILE), Buffer.from([0x08, 0x01])); // varint field, no entries
    const { folders, complete } = loadAgyhubFolderMap(dir);
    expect(folders.size).toBe(0);
    expect(complete).toBe(false);
  });
});
