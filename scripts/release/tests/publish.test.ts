import { expect, test } from 'bun:test';

import {
  parseArgv,
  PublishAbortError,
  runPublish,
  type GitOps,
  type PublishDeps,
} from 'scripts/release/publish.ts';

interface CaptureOps {
  git: GitOps;
  log: string[];
  validateCalls: number;
  promptCalls: string[];
  tagsCreated: Array<{ name: string; message: string }>;
  tagsPushed: string[];
}

function makeOps(
  override: {
    status?: string;
    branch?: string;
    localHead?: string;
    remoteHead?: string;
    tags?: string[];
    promptResponse?: boolean;
  } = {},
): { deps: PublishDeps; capture: CaptureOps } {
  const log: string[] = [];
  const promptCalls: string[] = [];
  const tagsCreated: Array<{ name: string; message: string }> = [];
  const tagsPushed: string[] = [];
  let validateCalls = 0;
  const git: GitOps = {
    status: () => override.status ?? '',
    currentBranch: () => override.branch ?? 'main',
    fetchOrigin: () => undefined,
    localHead: () => override.localHead ?? 'sha-aaa',
    remoteHead: () => override.remoteHead ?? 'sha-aaa',
    listTags: () => override.tags ?? [],
    createTag: (name, message) => {
      tagsCreated.push({ name, message });
    },
    pushTag: (name) => {
      tagsPushed.push(name);
    },
  };
  const deps: PublishDeps = {
    git,
    runValidate: () => {
      validateCalls++;
    },
    prompt: async (message) => {
      promptCalls.push(message);
      return override.promptResponse ?? true;
    },
    log: (line) => log.push(line),
    now: new Date('2026-05-08T03:14:00Z'),
  };
  return {
    deps,
    capture: { git, log, validateCalls, promptCalls, tagsCreated, tagsPushed },
  };
}

test('happy path: no prior tags → today with no suffix, validate runs, tag pushed', async () => {
  const { deps, capture } = makeOps({ tags: [] });
  const result = await runPublish(deps, { dryRun: false, yes: true, skipValidate: false });
  expect(result.tag).toBe('v2026.5.8');
  expect(result.pushed).toBe(true);
  expect(result.validated).toBe(true);
  expect(capture.tagsCreated).toEqual([{ name: 'v2026.5.8', message: 'v2026.5.8' }]);
  expect(capture.tagsPushed).toEqual(['v2026.5.8']);
});

test('happy path: latest from yesterday → fresh today version', async () => {
  const { deps, capture } = makeOps({ tags: ['v2026.5.7-2', 'v2026.5.7'] });
  const result = await runPublish(deps, { dryRun: false, yes: true, skipValidate: true });
  expect(result.tag).toBe('v2026.5.8');
  expect(capture.tagsPushed).toEqual(['v2026.5.8']);
});

test('happy path: latest from today (no suffix) → today-1 retry', async () => {
  const { deps, capture } = makeOps({ tags: ['v2026.5.8'] });
  const result = await runPublish(deps, { dryRun: false, yes: true, skipValidate: true });
  expect(result.tag).toBe('v2026.5.8-1');
  expect(capture.tagsPushed).toEqual(['v2026.5.8-1']);
});

test('happy path: latest from today (suffix 3) → today-4', async () => {
  const { deps, capture } = makeOps({ tags: ['v2026.5.8', 'v2026.5.8-3'] });
  const result = await runPublish(deps, { dryRun: false, yes: true, skipValidate: true });
  expect(result.tag).toBe('v2026.5.8-4');
  expect(capture.tagsPushed).toEqual(['v2026.5.8-4']);
});

test('latest ahead of today (calendar mistake) → suffix bump on the future date, no calendar advance', async () => {
  const { deps, capture } = makeOps({ tags: ['v2026.5.10'] });
  const result = await runPublish(deps, { dryRun: false, yes: true, skipValidate: true });
  expect(result.tag).toBe('v2026.5.10-1');
  expect(capture.tagsPushed).toEqual(['v2026.5.10-1']);
});

test('--dry-run does not tag or push', async () => {
  const { deps, capture } = makeOps({ tags: ['v2026.5.7'] });
  const result = await runPublish(deps, { dryRun: true, yes: true, skipValidate: true });
  expect(result.tag).toBe('v2026.5.8');
  expect(result.pushed).toBe(false);
  expect(capture.tagsCreated).toEqual([]);
  expect(capture.tagsPushed).toEqual([]);
});

test('confirmation declined → throws PublishAbortError, no tag/push', async () => {
  const { deps, capture } = makeOps({ tags: [], promptResponse: false });
  await expect(
    runPublish(deps, { dryRun: false, yes: false, skipValidate: true }),
  ).rejects.toBeInstanceOf(PublishAbortError);
  expect(capture.tagsCreated).toEqual([]);
  expect(capture.tagsPushed).toEqual([]);
});

test('confirmation accepted → tag + push', async () => {
  const { deps, capture } = makeOps({ tags: [], promptResponse: true });
  await runPublish(deps, { dryRun: false, yes: false, skipValidate: true });
  expect(capture.tagsPushed).toEqual(['v2026.5.8']);
  expect(capture.promptCalls.length).toBe(1);
});

test('dirty working tree → throws abort error before any git mutations', async () => {
  const { deps, capture } = makeOps({ status: ' M file.ts\n' });
  await expect(runPublish(deps, { dryRun: false, yes: true, skipValidate: true })).rejects.toThrow(
    'working tree is not clean',
  );
  expect(capture.tagsCreated).toEqual([]);
  expect(capture.tagsPushed).toEqual([]);
});

test('not on main branch → throws abort error', async () => {
  const { deps } = makeOps({ branch: 'feature/x' });
  await expect(runPublish(deps, { dryRun: false, yes: true, skipValidate: true })).rejects.toThrow(
    'expected to be on main branch; currently on feature/x',
  );
});

test('out of sync with origin → throws abort error', async () => {
  const { deps } = makeOps({ localHead: 'sha-local', remoteHead: 'sha-remote' });
  await expect(runPublish(deps, { dryRun: false, yes: true, skipValidate: true })).rejects.toThrow(
    'out of sync with origin/main',
  );
});

test('--skip-validate skips runValidate', async () => {
  const captureValidate: { calls: number } = { calls: 0 };
  const { deps, capture } = makeOps({});
  deps.runValidate = () => {
    captureValidate.calls++;
  };
  await runPublish(deps, { dryRun: false, yes: true, skipValidate: true });
  expect(captureValidate.calls).toBe(0);
  expect(capture.tagsPushed).toEqual(['v2026.5.8']);
});

test('default runValidate called when skipValidate is false', async () => {
  let calls = 0;
  const { deps, capture } = makeOps({});
  deps.runValidate = () => {
    calls++;
  };
  await runPublish(deps, { dryRun: false, yes: true, skipValidate: false });
  expect(calls).toBe(1);
  expect(capture.tagsPushed).toEqual(['v2026.5.8']);
});

test('parseArgv recognizes --dry-run --yes -y --skip-validate', () => {
  expect(parseArgv([])).toEqual({ dryRun: false, yes: false, skipValidate: false });
  expect(parseArgv(['--dry-run'])).toEqual({ dryRun: true, yes: false, skipValidate: false });
  expect(parseArgv(['--yes'])).toEqual({ dryRun: false, yes: true, skipValidate: false });
  expect(parseArgv(['-y'])).toEqual({ dryRun: false, yes: true, skipValidate: false });
  expect(parseArgv(['--skip-validate', '--yes'])).toEqual({
    dryRun: false,
    yes: true,
    skipValidate: true,
  });
});

test('summary log includes "(none)" when no prior tags', async () => {
  const { deps, capture } = makeOps({ tags: [] });
  await runPublish(deps, { dryRun: true, yes: true, skipValidate: true });
  expect(capture.log.some((l) => l.includes('(none)'))).toBe(true);
});

test('summary log includes the latest tag when present', async () => {
  const { deps, capture } = makeOps({ tags: ['v2026.5.7'] });
  await runPublish(deps, { dryRun: true, yes: true, skipValidate: true });
  expect(capture.log.some((l) => l.includes('2026.5.7'))).toBe(true);
});

test('PublishAbortError sets name and preserves message', () => {
  const e = new PublishAbortError('boom');
  expect(e.name).toBe('PublishAbortError');
  expect(e.message).toBe('boom');
});
