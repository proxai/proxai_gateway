import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-rmrec-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

function ebusyError(): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error('locked');
  e.code = 'EBUSY';
  return e;
}

test('removes a non-empty directory tree on first attempt', async () => {
  const target = join(dir, 'tree');
  await mkdir(join(target, 'sub'), { recursive: true });
  await writeFile(join(target, 'sub', 'a.txt'), 'x');
  await writeFile(join(target, 'b.txt'), 'y');
  await rmRecursive(target);
  await rmRecursive(target);
});

test('treats missing path as success (force semantics preserved)', async () => {
  await rmRecursive(join(dir, 'never-existed'));
});

test('retries on Windows EBUSY then succeeds', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await rmRecursive(join(dir, 'win-retry'), {
    isWindows: true,
    baseDelayMs: 10,
    delay: async (ms) => {
      sleeps.push(ms);
    },
    rm: async () => {
      calls++;
      if (calls < 3) throw ebusyError();
    },
  });
  expect(calls).toBe(3);
  expect(sleeps).toEqual([10, 20]);
});

test('rethrows non-retryable error code immediately on Windows', async () => {
  let calls = 0;
  await expect(
    rmRecursive(join(dir, 'x'), {
      isWindows: true,
      delay: async () => {},
      rm: async () => {
        calls++;
        const e: NodeJS.ErrnoException = new Error('denied');
        e.code = 'EACCES';
        throw e;
      },
    }),
  ).rejects.toThrow('denied');
  expect(calls).toBe(1);
});

test('rethrows error without code on Windows', async () => {
  await expect(
    rmRecursive(join(dir, 'x'), {
      isWindows: true,
      delay: async () => {},
      rm: async () => {
        throw new Error('mystery');
      },
    }),
  ).rejects.toThrow('mystery');
});

test('rethrows immediately on non-Windows even for EBUSY', async () => {
  let calls = 0;
  await expect(
    rmRecursive(join(dir, 'x'), {
      isWindows: false,
      delay: async () => {},
      rm: async () => {
        calls++;
        throw ebusyError();
      },
    }),
  ).rejects.toThrow('locked');
  expect(calls).toBe(1);
});

test('throws after final attempt on Windows when EBUSY persists', async () => {
  let calls = 0;
  await expect(
    rmRecursive(join(dir, 'x'), {
      isWindows: true,
      attempts: 3,
      baseDelayMs: 0,
      delay: async () => {},
      rm: async () => {
        calls++;
        throw ebusyError();
      },
    }),
  ).rejects.toThrow('locked');
  expect(calls).toBe(3);
});

test('uses default delay function path when delay omitted', async () => {
  let calls = 0;
  await rmRecursive(join(dir, 'x'), {
    isWindows: true,
    baseDelayMs: 1,
    rm: async () => {
      calls++;
      if (calls < 2) throw ebusyError();
    },
  });
  expect(calls).toBe(2);
});

test('uses default rm path when rm omitted', async () => {
  const target = join(dir, 'default-rm');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'f.txt'), 'z');
  await rmRecursive(target);
});

test('platform autodetect path is exercised when isWindows omitted', async () => {
  const target = join(dir, 'auto-platform');
  await mkdir(target, { recursive: true });
  await rmRecursive(target);
});

test('uses default attempts and baseDelayMs when omitted but eventually throws', async () => {
  let calls = 0;
  await expect(
    rmRecursive(join(dir, 'x'), {
      isWindows: true,
      delay: async () => {},
      rm: async () => {
        calls++;
        throw ebusyError();
      },
    }),
  ).rejects.toThrow('locked');
  expect(calls).toBe(10);
});

test('forces GC between retries on windows EBUSY to release orphaned handles', async () => {
  const gcCalls: number[] = [];
  let calls = 0;
  await rmRecursive(join(dir, 'gc-test'), {
    isWindows: true,
    baseDelayMs: 1,
    delay: async () => {},
    rm: async () => {
      calls++;
      if (calls < 4) throw ebusyError();
    },
    forceGc: () => {
      gcCalls.push(calls);
    },
  });
  expect(calls).toBe(4);
  expect(gcCalls).toEqual([1, 2, 3]);
});

test('default forceGc is benign when invoked (no throw, no behavior change)', async () => {
  let calls = 0;
  await rmRecursive(join(dir, 'default-gc'), {
    isWindows: true,
    baseDelayMs: 1,
    delay: async () => {},
    rm: async () => {
      calls++;
      if (calls < 2) throw ebusyError();
    },
  });
  expect(calls).toBe(2);
});
