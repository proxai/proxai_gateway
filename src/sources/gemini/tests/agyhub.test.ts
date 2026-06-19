import { describe, expect, it } from 'bun:test';

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
  it('returns an empty map + complete:true when the agyhub file is absent (fail-open)', () => {
    const { folders, complete } = loadAgyhubFolderMap('/nonexistent-agyhub-xyz');
    expect(folders.size).toBe(0);
    // A missing index is fail-open: nothing to protect, so the gate must not pause on it.
    expect(complete).toBe(true);
  });
});
