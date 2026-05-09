import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDefaultShellPathCleaner,
  createPosixShellPathCleaner,
  createWindowsShellPathCleaner,
  realPowershellSpawn,
  stripPathMarkerBlock,
  type SpawnPathCleaner,
} from 'services/uninstall';

let homeDir: string;
beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'proxai-pathclean-'));
});
afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

test('stripPathMarkerBlock: removes marker + next line + leading blank line', () => {
  const before =
    [
      'export EDITOR=vim',
      '',
      '# Added by ProxAI Gateway installer',
      'export PATH="$HOME/.proxai/bin:$PATH"',
      '# end',
    ].join('\n') + '\n';
  const result = stripPathMarkerBlock(before);
  expect(result.changed).toBe(true);
  expect(result.unmatchedMarker).toBe(false);
  expect(result.newContent).toBe(['export EDITOR=vim', '# end', ''].join('\n'));
});

test('stripPathMarkerBlock: leaves marker block alone if next line does not match install dir hint', () => {
  const before = ['# Added by ProxAI Gateway installer', 'unrelated line', 'rest'].join('\n');
  const result = stripPathMarkerBlock(before);
  expect(result.changed).toBe(false);
  expect(result.unmatchedMarker).toBe(true);
  expect(result.newContent).toBe(before);
});

test('stripPathMarkerBlock: no-op when no marker present', () => {
  const before = 'alias ll="ls -la"\nexport PAGER=less\n';
  const result = stripPathMarkerBlock(before);
  expect(result.changed).toBe(false);
  expect(result.unmatchedMarker).toBe(false);
  expect(result.newContent).toBe(before);
});

test('stripPathMarkerBlock: handles marker as the very first line', () => {
  const before =
    ['# Added by ProxAI Gateway installer', 'export PATH="$HOME/.proxai/bin:$PATH"', 'rest'].join(
      '\n',
    ) + '\n';
  const result = stripPathMarkerBlock(before);
  expect(result.changed).toBe(true);
  expect(result.newContent).toBe('rest\n');
});

test('stripPathMarkerBlock: handles marker as the last block (no trailing rest)', () => {
  const before = [
    'first',
    '',
    '# Added by ProxAI Gateway installer',
    'export PATH="$HOME/.proxai/bin:$PATH"',
  ].join('\n');
  const result = stripPathMarkerBlock(before);
  expect(result.changed).toBe(true);
  expect(result.newContent).toBe('first');
});

test('stripPathMarkerBlock: marker without a following line keeps it untouched', () => {
  const before = 'first\n# Added by ProxAI Gateway installer';
  const result = stripPathMarkerBlock(before);
  expect(result.changed).toBe(false);
  expect(result.unmatchedMarker).toBe(true);
  expect(result.newContent).toBe(before);
});

test('posix cleaner: cleans .zshrc, reports .bashrc as no-marker, .bash_profile as missing', async () => {
  const reads = new Map<string, string | null>();
  reads.set(
    join(homeDir, '.zshrc'),
    [
      'pre',
      '',
      '# Added by ProxAI Gateway installer',
      'export PATH="$HOME/.proxai/bin:$PATH"',
      'post',
    ].join('\n') + '\n',
  );
  reads.set(join(homeDir, '.bashrc'), 'unrelated\n');
  reads.set(join(homeDir, '.bash_profile'), null);

  const writes: Array<{ path: string; content: string }> = [];
  const cleaner = createPosixShellPathCleaner({
    homeDir,
    readFile: async (path) => reads.get(path) ?? null,
    writeFile: async (path, content) => {
      writes.push({ path, content });
    },
  });

  const outcomes = await cleaner.clean('/h/.proxai/bin');
  expect(outcomes).toHaveLength(3);
  expect(outcomes[0]).toEqual({
    path: join(homeDir, '.zshrc'),
    cleaned: true,
    reason: 'removed installer PATH block',
  });
  expect(outcomes[1]).toEqual({
    path: join(homeDir, '.bashrc'),
    cleaned: false,
    reason: 'no installer marker found',
  });
  expect(outcomes[2]).toEqual({
    path: join(homeDir, '.bash_profile'),
    cleaned: false,
    reason: 'file not present',
  });
  expect(writes).toHaveLength(1);
  expect(writes[0]!.path).toBe(join(homeDir, '.zshrc'));
  expect(writes[0]!.content).toBe('pre\npost\n');
});

test('posix cleaner: read failure surfaces as not-cleaned with reason', async () => {
  const cleaner = createPosixShellPathCleaner({
    homeDir,
    readFile: async () => {
      throw new Error('EACCES denied');
    },
    writeFile: async () => undefined,
  });
  const outcomes = await cleaner.clean('/h/.proxai/bin');
  expect(outcomes.every((o) => o.cleaned === false)).toBe(true);
  expect(outcomes[0]!.reason).toContain('read failed');
  expect(outcomes[0]!.reason).toContain('EACCES denied');
});

test('posix cleaner: write failure surfaces as not-cleaned with reason', async () => {
  const cleaner = createPosixShellPathCleaner({
    homeDir,
    readFile: async (path) => {
      if (path.endsWith('.zshrc')) {
        return (
          ['# Added by ProxAI Gateway installer', 'export PATH="$HOME/.proxai/bin:$PATH"'].join(
            '\n',
          ) + '\n'
        );
      }
      return null;
    },
    writeFile: async () => {
      throw new Error('EROFS');
    },
  });
  const outcomes = await cleaner.clean('/h/.proxai/bin');
  const zshrc = outcomes.find((o) => o.path.endsWith('.zshrc'));
  expect(zshrc!.cleaned).toBe(false);
  expect(zshrc!.reason).toContain('write failed');
  expect(zshrc!.reason).toContain('EROFS');
});

test('posix cleaner: marker-with-mismatched-next-line reported with leave-untouched reason', async () => {
  const cleaner = createPosixShellPathCleaner({
    homeDir,
    readFile: async (path) => {
      if (path.endsWith('.zshrc')) {
        return ['# Added by ProxAI Gateway installer', 'unrelated', 'rest'].join('\n');
      }
      return null;
    },
    writeFile: async () => undefined,
  });
  const outcomes = await cleaner.clean('/h/.proxai/bin');
  const zshrc = outcomes.find((o) => o.path.endsWith('.zshrc'));
  expect(zshrc!.cleaned).toBe(false);
  expect(zshrc!.reason).toContain('left untouched');
});

test('windows cleaner: spawns powershell with install dir env var; ok exit reports cleaned', async () => {
  const captured: { file: string; args: string[]; env: Record<string, string> }[] = [];
  const spawn: SpawnPathCleaner = async (file, args, env) => {
    captured.push({ file, args, env });
    return { ok: true, stderr: '' };
  };
  const cleaner = createWindowsShellPathCleaner({ spawnImpl: spawn });
  const outcomes = await cleaner.clean('C:\\Users\\x\\.proxai\\bin');
  expect(captured).toHaveLength(1);
  expect(captured[0]!.file).toBe('powershell.exe');
  expect(captured[0]!.args[0]).toBe('-NoProfile');
  expect(captured[0]!.args[1]).toBe('-Command');
  expect(captured[0]!.env['PROXAI_INSTALL_DIR']).toBe('C:\\Users\\x\\.proxai\\bin');
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]!.cleaned).toBe(true);
});

test('windows cleaner: powershell non-zero exit surfaces as not-cleaned with last stderr line', async () => {
  const spawn: SpawnPathCleaner = async () => ({
    ok: false,
    stderr: 'WARNING: noisy\nfatal: registry locked\n',
  });
  const cleaner = createWindowsShellPathCleaner({ spawnImpl: spawn });
  const outcomes = await cleaner.clean('C:\\bin');
  expect(outcomes[0]!.cleaned).toBe(false);
  expect(outcomes[0]!.reason).toContain('powershell exited non-zero');
  expect(outcomes[0]!.reason).toContain('fatal: registry locked');
});

test('windows cleaner: powershell empty stderr falls back to "unknown"', async () => {
  const spawn: SpawnPathCleaner = async () => ({ ok: false, stderr: '' });
  const cleaner = createWindowsShellPathCleaner({ spawnImpl: spawn });
  const outcomes = await cleaner.clean('C:\\bin');
  expect(outcomes[0]!.cleaned).toBe(false);
  expect(outcomes[0]!.reason).toContain('powershell exited non-zero');
});

test('windows cleaner: spawn throw is captured', async () => {
  const spawn: SpawnPathCleaner = async () => {
    throw new Error('powershell.exe not found');
  };
  const cleaner = createWindowsShellPathCleaner({ spawnImpl: spawn });
  const outcomes = await cleaner.clean('C:\\bin');
  expect(outcomes[0]!.cleaned).toBe(false);
  expect(outcomes[0]!.reason).toContain('powershell spawn failed');
  expect(outcomes[0]!.reason).toContain('powershell.exe not found');
});

test('createDefaultShellPathCleaner: returns windows variant on win32', () => {
  expect(typeof createDefaultShellPathCleaner('win32').clean).toBe('function');
});

test('createDefaultShellPathCleaner: returns posix variant on darwin/linux', () => {
  expect(typeof createDefaultShellPathCleaner('darwin').clean).toBe('function');
  expect(typeof createDefaultShellPathCleaner('linux').clean).toBe('function');
});

test('createDefaultShellPathCleaner posix: real readFile/writeFile against a tmp homedir', async () => {
  await writeFile(
    join(homeDir, '.zshrc'),
    [
      'pre',
      '',
      '# Added by ProxAI Gateway installer',
      'export PATH="$HOME/.proxai/bin:$PATH"',
      'post',
    ].join('\n') + '\n',
  );
  const cleaner = createDefaultShellPathCleaner('darwin', homeDir);
  const outcomes = await cleaner.clean('/h/.proxai/bin');
  const zshrc = outcomes.find((o) => o.path.endsWith('.zshrc'));
  expect(zshrc!.cleaned).toBe(true);
  const newContent = await readFile(join(homeDir, '.zshrc'), 'utf8');
  expect(newContent).toBe('pre\npost\n');
  const bashrc = outcomes.find((o) => o.path.endsWith('.bashrc'));
  expect(bashrc!.cleaned).toBe(false);
  expect(bashrc!.reason).toBe('file not present');
});

test('realPowershellSpawn: ok=true when child exits 0; stderr captured', async () => {
  const result = await realPowershellSpawn(
    'bun',
    ['-e', 'process.stderr.write("stderr-msg\\n"); process.exit(0)'],
    process.env as Record<string, string>,
  );
  expect(result.ok).toBe(true);
  expect(result.stderr).toContain('stderr-msg');
});

test('realPowershellSpawn: ok=false when child exits non-zero', async () => {
  const result = await realPowershellSpawn(
    'bun',
    ['-e', 'process.exit(7)'],
    process.env as Record<string, string>,
  );
  expect(result.ok).toBe(false);
});
