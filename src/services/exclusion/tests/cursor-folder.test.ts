// src/services/exclusion/tests/cursor-folder.test.ts
import { describe, expect, it } from 'bun:test';

import {
  fileUriToPath,
  parseComposerHeadersFolders,
  parseWorkspaceFolder,
} from 'services/exclusion/cursor-folder.ts';

describe('fileUriToPath', () => {
  it('converts a file:// URI to an absolute path', () => {
    expect(fileUriToPath('file:///Users/me/Documents/proj')).toBe('/Users/me/Documents/proj');
  });
  it('percent-decodes spaces', () => {
    expect(fileUriToPath('file:///Users/me/My%20Proj')).toBe('/Users/me/My Proj');
  });
  it('returns null for non-file URIs and non-strings', () => {
    expect(fileUriToPath('vscode-remote://ssh/x')).toBeNull();
    expect(fileUriToPath('/plain/path')).toBeNull();
    // @ts-expect-error runtime guard
    expect(fileUriToPath(null)).toBeNull();
  });
  it('returns null for a non-local host (file://x/...)', () => {
    // `file://x` passes the `file://` guard but names a remote host, which has no
    // usable local path -> null (it must never be coerced into `/some/path`).
    expect(fileUriToPath('file://x/some/path')).toBeNull();
  });
  it('accepts an explicit localhost host', () => {
    expect(fileUriToPath('file://localhost/Users/me/proj')).toBe('/Users/me/proj');
  });
  it('maps a Windows drive URI to a drive-rooted path on every platform', () => {
    // The daemon ships to Windows, so `file:///C:/…` must decode to `C:/…` even on
    // the macOS/Linux CI runner (host-native fileURLToPath would throw here). The
    // leading slash before the drive letter is stripped.
    expect(fileUriToPath('file:///C:/Users/me/proj')).toBe('C:/Users/me/proj');
  });
  it('returns null when the path has a malformed percent-escape', () => {
    // `%ZZ` survives URL parsing but makes decodeURIComponent throw URIError ->
    // the catch returns null instead of propagating.
    expect(fileUriToPath('file:///a%ZZ')).toBeNull();
  });
});

describe('parseWorkspaceFolder', () => {
  it('reads the folder field from workspace.json text', () => {
    const json = JSON.stringify({ folder: 'file:///Users/me/Documents/proj' });
    expect(parseWorkspaceFolder(json)).toBe('/Users/me/Documents/proj');
  });
  it('returns null when folder is absent (e.g. multi-root) or text is malformed', () => {
    expect(
      parseWorkspaceFolder(JSON.stringify({ workspace: 'file:///x.code-workspace' })),
    ).toBeNull();
    expect(parseWorkspaceFolder('not json')).toBeNull();
    expect(parseWorkspaceFolder('{}')).toBeNull();
  });
});

describe('parseComposerHeadersFolders', () => {
  it('maps composerId -> folder path, null when no uri', () => {
    const json = JSON.stringify({
      allComposers: [
        {
          composerId: 'c1',
          workspaceIdentifier: { id: 'hashA', uri: { external: 'file:///Users/me/nest' } },
        },
        { composerId: 'c2', workspaceIdentifier: { id: 'empty-window' } },
      ],
    });
    const map = parseComposerHeadersFolders(json);
    expect(map.get('c1')).toBe('/Users/me/nest');
    expect(map.get('c2')).toBeNull();
  });
  it('returns an empty map for malformed input', () => {
    expect(parseComposerHeadersFolders('nope').size).toBe(0);
    expect(parseComposerHeadersFolders(JSON.stringify({ allComposers: 'x' })).size).toBe(0);
  });
});
