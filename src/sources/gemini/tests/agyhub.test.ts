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
  it('returns an empty map when the agyhub file is absent', () => {
    expect(loadAgyhubFolderMap('/nonexistent-agyhub-xyz').size).toBe(0);
  });
});
