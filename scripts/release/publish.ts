import {
  computeNextVersion,
  formatVersion,
  pickLatestTag,
  todayUtc,
  type Version,
} from 'scripts/release/versioning.ts';

export interface GitOps {
  status(): string;
  currentBranch(): string;
  fetchOrigin(): void;
  localHead(): string;
  remoteHead(branch: string): string;
  listTags(pattern: string): string[];
  createTag(name: string, message: string): void;
  pushTag(name: string): void;
}

export interface PublishDeps {
  git: GitOps;
  runValidate: () => void;
  prompt: (message: string) => Promise<boolean>;
  log: (line: string) => void;
  now?: Date;
}

export interface PublishOptions {
  dryRun: boolean;
  yes: boolean;
  skipValidate: boolean;
}

export interface PublishResult {
  tag: string;
  pushed: boolean;
  validated: boolean;
}

export class PublishAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishAbortError';
  }
}

export async function runPublish(
  deps: PublishDeps,
  options: PublishOptions,
): Promise<PublishResult> {
  ensureCleanWorkingTree(deps);
  ensureOnMainBranch(deps);
  ensureSyncedWithOrigin(deps);

  if (!options.skipValidate) {
    deps.log('running validate before tagging…');
    deps.runValidate();
  }

  const tags = deps.git.listTags('v*');
  const latest = pickLatestTag(tags);
  const today = todayUtc(deps.now);
  const next = computeNextVersion(latest, today);
  const tag = `v${formatVersion(next)}`;

  printSummary(deps, latest, today, next, tag);

  if (options.dryRun) {
    deps.log('--dry-run: not tagging or pushing');
    return { tag, pushed: false, validated: !options.skipValidate };
  }

  if (!options.yes) {
    const ok = await deps.prompt(`tag and push ${tag}?`);
    if (!ok) {
      throw new PublishAbortError('aborted by user');
    }
  }

  deps.git.createTag(tag, tag);
  deps.git.pushTag(tag);
  deps.log(`pushed ${tag}`);
  return { tag, pushed: true, validated: !options.skipValidate };
}

function ensureCleanWorkingTree(deps: PublishDeps): void {
  const status = deps.git.status();
  if (status.trim().length > 0) {
    throw new PublishAbortError(
      'working tree is not clean; commit or stash changes before publishing',
    );
  }
}

function ensureOnMainBranch(deps: PublishDeps): void {
  const branch = deps.git.currentBranch();
  if (branch !== 'main') {
    throw new PublishAbortError(`expected to be on main branch; currently on ${branch}`);
  }
}

function ensureSyncedWithOrigin(deps: PublishDeps): void {
  deps.git.fetchOrigin();
  const local = deps.git.localHead();
  const remote = deps.git.remoteHead('main');
  if (local !== remote) {
    throw new PublishAbortError('local main is out of sync with origin/main; pull or push first');
  }
}

function printSummary(
  deps: PublishDeps,
  latest: Version | null,
  today: Version,
  next: Version,
  tag: string,
): void {
  const latestStr = latest === null ? '(none)' : formatVersion(latest);
  deps.log(`latest tag:    ${latestStr}`);
  deps.log(
    `today (UTC):   ${today.year.toString()}-${today.month.toString()}-${today.day.toString()}`,
  );
  deps.log(`next version:  ${formatVersion(next)}`);
  deps.log(`tag to push:   ${tag}`);
}

export function parseArgv(argv: readonly string[]): PublishOptions {
  const args = new Set(argv);
  return {
    dryRun: args.has('--dry-run'),
    yes: args.has('--yes') || args.has('-y'),
    skipValidate: args.has('--skip-validate'),
  };
}
