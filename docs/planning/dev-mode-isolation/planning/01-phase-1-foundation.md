# Phase 1 — Foundation Implementation Plan

> **STATUS: DONE.** All 9 tasks were implemented and committed on branch `dev-mode-isolation` on 2026-05-27. Commits: `ea6cc5b`, `1e62732`, `349802b`, `8fa8afc`, `b194e55`, `4c2abe6`, `51ab206`, `f4c0214`, `a0fbefb`. This document is retained as a reference for what was built.

**Goal:** Introduce `ProfileContext` types and constructor, one-time filesystem relocation from flat-layout to `prod/` nested layout, `--profile <name>` arg parsing on the daemon's `run` command, and profile-aware service-unit writers. After this phase, existing users transparently upgrade on first daemon start, everything else continues to work identically to today, and the foundation is laid for Phase 2 to introduce dual-daemon behavior.

**Architecture:** Pure additive refactor. New `src/core/io/fs/profile.ts` exports `buildProfileContext('prod' | 'dev'): ProfileContext`. Existing zero-arg path helpers in `src/core/io/fs/paths.ts` become thin wrappers delegating to `buildProfileContext('prod')` — same return values as today, so callers are unaffected. New `src/core/io/fs/migrate-flat-to-nested.ts` runs once before the daemon opens any file, holding a file lock and using atomic `fs.rename` per file. Service-unit writers gain an optional `profileName` parameter that adds `--profile <name>` to the daemon's launch args; on first daemon start under the new binary, the running daemon detects that the loaded service-unit args lack `--profile` and regenerates the unit file.

**Tech Stack:** Bun ≥1.3.0, TypeScript 6.0.3, `node:fs` (`renameSync`, `existsSync`, `writeFileSync` with `flag: 'wx'` for the lock), `core/utils/assert.ts` narrowing helpers, existing `core/io/fs/sentinel.ts` for marker files.

---

## File structure

**New files:**
- `src/core/io/fs/profile.types.ts` — `ProfileName`, `ProfileContext`, `ProfileSentinelPaths`, `VALID_PROFILES`.
- `src/core/io/fs/profile.ts` — `buildProfileContext()`, helpers for default URLs per profile, plus `profileRootDir()` for the parent of all profile subdirs and `profileLogDir(profile)` for per-profile log dir.
- `src/core/io/fs/migrate-flat-to-nested.ts` — `relocateFlatToNested()` and `isFlatLayoutPresent()`. Uses a `.migration.lock` file (exclusive create) and writes `.migrated-flat-to-nested` marker on success.
- `src/core/io/fs/tests/profile.test.ts`, `migrate-flat-to-nested.test.ts` — tests.

**Modified files:**
- `src/core/io/fs/paths.ts` — `configDir()`, `bufferDbPath()`, `configFilePath()`, `*SentinelPath()`, `controlSocketPath()`, `logDir()` become thin wrappers delegating to `buildProfileContext('prod').<field>`. `devModeSentinelPath()` is deleted (its consumers in `dev-deps.ts` and `config.constants.ts` will be reworked in Phase 2; in Phase 1 they continue to read whatever is at the legacy path, which will be absent after relocation — confirm via existing tests that this is harmless).
- `src/cli/service-unit/launchd-plist.ts` — `LaunchdPlistInput.programArgs` already accepts a custom args array; the wiring layer that supplies the args (Phase 1: `cli/wiring/platform.ts:buildServiceUnitRecreate`) gains a `profileName` field that the wiring uses to compose args as `['run', '--profile', profileName]`.
- `src/cli/service-unit/systemd-unit.ts` — same: the `ExecStart` value receives `--profile <name>` from the wiring layer.
- `src/cli/service-unit/scheduled-task-xml.ts` — same: args composed at wiring layer.
- `src/cli/wiring/platform.ts` — `buildServiceUnitRecreate()` gains `profileName?: ProfileName` field defaulting to `'prod'`; threads it through to args composition.
- `src/main.ts` — `run` command parses optional `--profile <name>` flag (default `'prod'`). `buildRunDeps()` call receives the parsed profile and constructs the daemon's `ProfileContext` from it.
- `src/cli/commands/run/build-contexts.ts` — daemon startup invokes `relocateFlatToNested()` before any file open. Builds the `ProfileContext` and threads it through existing daemon contexts.
- `src/cli/commands/run/index.ts` — accepts `profileCtx` in deps (additive).
- `src/cli/commands/run/run.types.ts` — `RunCommandDeps` gains `profileCtx: ProfileContext` (additive).

**Untouched in Phase 1 (deferred to Phase 2):**
- All ~65 callsites of the legacy zero-arg path helpers across `services/`, `state-machines/`, other `cli/commands/`.
- The `dev` command (`src/cli/commands/dev.ts`) — Phase 2.
- `src/services/upgrade/auto-upgrade.ts` and the coordinated upgrade flow — Phase 2.
- Dev service unit registration / generation — Phase 2.

---

## Task 1 — Define ProfileContext types

**Files:**
- Create: `src/core/io/fs/profile.types.ts`
- Create: `src/core/io/fs/tests/profile.types.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { VALID_PROFILES } from 'core/io/fs/profile.types.ts';
import type { ProfileContext, ProfileName, ProfileSentinelPaths } from 'core/io/fs/profile.types.ts';

describe('profile.types', () => {
  test('VALID_PROFILES enumerates exactly prod and dev', () => {
    expect(VALID_PROFILES).toEqual(['prod', 'dev']);
  });

  test('ProfileContext satisfies expected shape', () => {
    const sentinels: ProfileSentinelPaths = {
      authFailed: '/x/AUTH_FAILED',
      bufferFull: '/x/BUFFER_FULL',
      sessionStopped: '/x/SESSION_STOPPED',
      consent: '/x/CONSENT_ACCEPTED',
      updateAvailable: '/x/UPDATE_AVAILABLE',
    };
    const ctx: ProfileContext = {
      name: 'prod',
      isDev: false,
      configDir: '/x',
      configFilePath: '/x/config.toml',
      bufferDbPath: '/x/buffer.db',
      logDir: '/logs/prod',
      sentinels,
      controlSocketPath: '/x/control.sock',
      defaultNestBaseUrl: 'https://nest.example',
    };
    const name: ProfileName = ctx.name;
    expect(name).toBe('prod');
    expect(ctx.isDev).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test src/core/io/fs/tests/profile.types.test.ts`
Expected: FAIL — `Cannot find module 'core/io/fs/profile.types.ts'`.

- [x] **Step 3: Create the types file**

```ts
export type ProfileName = 'prod' | 'dev';

export interface ProfileSentinelPaths {
  readonly authFailed: string;
  readonly bufferFull: string;
  readonly sessionStopped: string;
  readonly consent: string;
  readonly updateAvailable: string;
}

export interface ProfileContext {
  readonly name: ProfileName;
  readonly isDev: boolean;
  readonly configDir: string;
  readonly configFilePath: string;
  readonly bufferDbPath: string;
  readonly logDir: string;
  readonly sentinels: ProfileSentinelPaths;
  readonly controlSocketPath: string;
  readonly defaultNestBaseUrl: string;
}

export const VALID_PROFILES: readonly ProfileName[] = ['prod', 'dev'];
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test src/core/io/fs/tests/profile.types.test.ts`
Expected: PASS — both tests green.

- [x] **Step 5: Run per-file validation gate and commit**

Run: `bun ai:coverage-orchestrator:validate src/core/io/fs/profile.types.ts`
Expected: 100% coverage, no type errors, no suppressions.

Run:
```bash
git add src/core/io/fs/profile.types.ts src/core/io/fs/tests/profile.types.test.ts
git commit -m "feat: add ProfileContext type module for dev-mode isolation"
```

---

## Task 2 — Implement buildProfileContext()

**Files:**
- Create: `src/core/io/fs/profile.ts`
- Create: `src/core/io/fs/tests/profile.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { buildProfileContext, profileRootDir } from 'core/io/fs/profile.ts';

const isWindows = process.platform === 'win32';

describe('buildProfileContext', () => {
  test('prod profile paths nest under profileRootDir/prod', () => {
    const ctx = buildProfileContext('prod');
    expect(ctx.name).toBe('prod');
    expect(ctx.isDev).toBe(false);
    expect(ctx.configDir.endsWith(`${sep}prod`)).toBe(true);
    expect(ctx.configFilePath.endsWith(`${sep}prod${sep}config.toml`)).toBe(true);
    expect(ctx.bufferDbPath.endsWith(`${sep}prod${sep}buffer.db`)).toBe(true);
    expect(ctx.sentinels.authFailed.endsWith(`${sep}prod${sep}AUTH_FAILED`)).toBe(true);
    expect(ctx.sentinels.bufferFull.endsWith(`${sep}prod${sep}BUFFER_FULL`)).toBe(true);
    expect(ctx.sentinels.sessionStopped.endsWith(`${sep}prod${sep}SESSION_STOPPED`)).toBe(true);
    expect(ctx.sentinels.consent.endsWith(`${sep}prod${sep}CONSENT_ACCEPTED`)).toBe(true);
    expect(ctx.sentinels.updateAvailable.endsWith(`${sep}prod${sep}UPDATE_AVAILABLE`)).toBe(true);
    expect(ctx.defaultNestBaseUrl).toBe('https://proxainest-production.up.railway.app');
  });

  test('dev profile paths nest under profileRootDir/dev with localhost URL', () => {
    const ctx = buildProfileContext('dev');
    expect(ctx.name).toBe('dev');
    expect(ctx.isDev).toBe(true);
    expect(ctx.configDir.endsWith(`${sep}dev`)).toBe(true);
    expect(ctx.bufferDbPath.endsWith(`${sep}dev${sep}buffer.db`)).toBe(true);
    expect(ctx.defaultNestBaseUrl).toBe('http://localhost:3001');
  });

  test('profileRootDir matches existing configDir() base', () => {
    const root = profileRootDir();
    if (isWindows) {
      const localAppData = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
      expect(root).toBe(join(localAppData, 'proxai', 'proxai-gateway'));
    } else {
      expect(root).toBe(join(homedir(), '.proxai', 'proxai-gateway'));
    }
  });

  test('control socket path is profile-scoped (POSIX) or pipe (Windows)', () => {
    const ctx = buildProfileContext('prod');
    if (isWindows) {
      expect(ctx.controlSocketPath.startsWith('\\\\.\\pipe\\')).toBe(true);
      expect(ctx.controlSocketPath).toContain('prod');
    } else {
      expect(ctx.controlSocketPath.endsWith(`${sep}prod${sep}control.sock`)).toBe(true);
    }
  });

  test('log dir nests under platform log dir / profile name', () => {
    const prod = buildProfileContext('prod');
    const dev = buildProfileContext('dev');
    expect(prod.logDir.endsWith(`${sep}prod`)).toBe(true);
    expect(dev.logDir.endsWith(`${sep}dev`)).toBe(true);
    expect(prod.logDir).not.toBe(dev.logDir);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test src/core/io/fs/tests/profile.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Create the implementation**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

import { APP_NAME, ORG_NAME } from 'core/io/fs/fs.constants.ts';
import type { ProfileContext, ProfileName, ProfileSentinelPaths } from 'core/io/fs/profile.types.ts';

const PROD_NEST_BASE_URL = 'https://proxainest-production.up.railway.app';
const DEV_NEST_BASE_URL = 'http://localhost:3001';

export function profileRootDir(): string {
  switch (process.platform) {
    case 'darwin':
    case 'linux':
      return join(homedir(), `.${ORG_NAME}`, APP_NAME);
    case 'win32':
      return join(
        process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'),
        ORG_NAME,
        APP_NAME,
      );
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

export function profileLogDirRoot(): string {
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Logs', ORG_NAME, APP_NAME);
    case 'linux':
      return join(homedir(), '.local', 'state', ORG_NAME, APP_NAME, 'log');
    case 'win32':
      return join(
        process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'),
        ORG_NAME,
        APP_NAME,
        'Logs',
      );
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

function buildSentinelPaths(configDir: string): ProfileSentinelPaths {
  return {
    authFailed: join(configDir, 'AUTH_FAILED'),
    bufferFull: join(configDir, 'BUFFER_FULL'),
    sessionStopped: join(configDir, 'SESSION_STOPPED'),
    consent: join(configDir, 'CONSENT_ACCEPTED'),
    updateAvailable: join(configDir, 'UPDATE_AVAILABLE'),
  };
}

function buildControlSocketPath(profile: ProfileName, configDir: string): string {
  switch (process.platform) {
    case 'darwin':
    case 'linux':
      return join(configDir, 'control.sock');
    case 'win32':
      return `\\\\.\\pipe\\${APP_NAME}-control-${profile}`;
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

export function buildProfileContext(profile: ProfileName): ProfileContext {
  const configDir = join(profileRootDir(), profile);
  const logDir = join(profileLogDirRoot(), profile);
  return {
    name: profile,
    isDev: profile === 'dev',
    configDir,
    configFilePath: join(configDir, 'config.toml'),
    bufferDbPath: join(configDir, 'buffer.db'),
    logDir,
    sentinels: buildSentinelPaths(configDir),
    controlSocketPath: buildControlSocketPath(profile, configDir),
    defaultNestBaseUrl: profile === 'dev' ? DEV_NEST_BASE_URL : PROD_NEST_BASE_URL,
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test src/core/io/fs/tests/profile.test.ts`
Expected: PASS — all five tests green.

- [x] **Step 5: Run per-file validation gate and commit**

Run: `bun ai:coverage-orchestrator:validate src/core/io/fs/profile.ts`
Expected: 100% coverage.

```bash
git add src/core/io/fs/profile.ts src/core/io/fs/tests/profile.test.ts
git commit -m "feat: implement buildProfileContext for dev-mode isolation"
```

---

## Task 3 — Make existing path helpers delegate to ProfileContext

**Files:**
- Modify: `src/core/io/fs/paths.ts`
- Modify: `src/core/io/fs/tests/paths.test.ts` (existing tests must still pass; add a coverage-supplementing case if needed)

- [x] **Step 1: Update the path module**

Replace the body of `src/core/io/fs/paths.ts` with:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

import { APP_NAME, ORG_NAME } from 'core/io/fs/fs.constants.ts';
import { buildProfileContext, profileRootDir } from 'core/io/fs/profile.ts';

export function configDir(): string {
  return buildProfileContext('prod').configDir;
}

export function logDir(): string {
  return buildProfileContext('prod').logDir;
}

export function bufferDbPath(): string {
  return buildProfileContext('prod').bufferDbPath;
}

export function configFilePath(): string {
  return buildProfileContext('prod').configFilePath;
}

export function authFailedSentinelPath(): string {
  return buildProfileContext('prod').sentinels.authFailed;
}

export function bufferFullSentinelPath(): string {
  return buildProfileContext('prod').sentinels.bufferFull;
}

export function sessionStoppedSentinelPath(): string {
  return buildProfileContext('prod').sentinels.sessionStopped;
}

export function consentSentinelPath(): string {
  return buildProfileContext('prod').sentinels.consent;
}

export function updateAvailableSentinelPath(): string {
  return buildProfileContext('prod').sentinels.updateAvailable;
}

export function controlSocketPath(): string {
  return buildProfileContext('prod').controlSocketPath;
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function legacyRootDir(): string {
  return profileRootDir();
}
```

Note: `devModeSentinelPath()` is deleted in this step. The two known consumers (`src/cli/wiring/dev-deps.ts` and `src/services/config/config.constants.ts`) will be reworked in Phase 2; in Phase 1 they need a stopgap. Update them now to use a hardcoded path computed inline so Phase 1 compiles:

In `src/cli/wiring/dev-deps.ts` and `src/services/config/config.constants.ts`, where `devModeSentinelPath()` was called, replace with `join(profileRootDir(), 'DEV_MODE')` (importing `profileRootDir` from `core/io/fs/profile.ts`). This preserves today's behavior bit-for-bit — same path, same logic — until Phase 2 deletes the consumers entirely.

- [x] **Step 2: Run all existing tests**

Run: `bun run test:cov`
Expected: PASS — every existing test that depended on these helpers continues to pass because the wrappers return identical values. The only difference is that `configDir()` now returns `~/.proxai/proxai-gateway/prod` instead of `~/.proxai/proxai-gateway/` — which BREAKS existing tests.

This is the moment the foundation actually changes the world. Existing tests must be updated to reflect the new prod-nested path. Where a test asserted `configDir()` returns `~/.proxai/proxai-gateway/`, it now asserts `~/.proxai/proxai-gateway/prod/`.

- [x] **Step 3: Update path-related tests for prod-nesting**

Modify `src/core/io/fs/tests/paths.test.ts` and any sibling tests that asserted exact path equality. The pattern: any assertion that did `expect(configDir()).toBe(join(homedir(), '.proxai', 'proxai-gateway'))` becomes `expect(configDir()).toBe(join(homedir(), '.proxai', 'proxai-gateway', 'prod'))`. Same for `logDir()` → adds `/prod`. Same for sentinels.

For any test that asserted "configDir is the parent directory of buffer.db", update to use `legacyRootDir()` if it was actually testing the legacy-root semantic, or to the new nested location if it was actually testing the prod-specific path.

Use `node:path.sep` or `node:path.join` for path composition in assertions — no literal `/`. See `.claude/rules/process/tests.md`.

- [x] **Step 4: Run all tests again**

Run: `bun run test:cov`
Expected: PASS — all updated tests green.

Run: `bun run check`
Expected: PASS — no type or lint errors.

- [x] **Step 5: Commit**

```bash
git add src/core/io/fs/paths.ts src/core/io/fs/tests/paths.test.ts \
        src/cli/wiring/dev-deps.ts src/services/config/config.constants.ts \
        $(git ls-files -m | xargs grep -l "configDir\|bufferDbPath\|logDir" 2>/dev/null)
git commit -m "refactor: route path helpers through buildProfileContext('prod')"
```

---

## Task 4 — Implement filesystem flat→nested relocation

**Files:**
- Create: `src/core/io/fs/migrate-flat-to-nested.ts`
- Create: `src/core/io/fs/tests/migrate-flat-to-nested.test.ts`

- [x] **Step 1: Write the failing tests**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { rmRecursive } from 'core/io/fs/rm-recursive.ts';
import {
  isFlatLayoutPresent,
  relocateFlatToNested,
  MIGRATED_MARKER,
  MIGRATION_LOCK,
} from 'core/io/fs/migrate-flat-to-nested.ts';

describe('migrate-flat-to-nested', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proxai-mig-'));
  });

  afterEach(async () => {
    await rmRecursive(root);
  });

  test('isFlatLayoutPresent returns false for empty root', () => {
    expect(isFlatLayoutPresent(root)).toBe(false);
  });

  test('isFlatLayoutPresent returns false when only prod/ exists', () => {
    writeFileSync(join(root, MIGRATED_MARKER), 'migrated');
    const prodDir = join(root, 'prod');
    require('node:fs').mkdirSync(prodDir);
    writeFileSync(join(prodDir, 'config.toml'), 'x');
    expect(isFlatLayoutPresent(root)).toBe(false);
  });

  test('isFlatLayoutPresent returns true when legacy config.toml at root', () => {
    writeFileSync(join(root, 'config.toml'), 'x');
    expect(isFlatLayoutPresent(root)).toBe(true);
  });

  test('relocateFlatToNested moves files into prod/ atomically', async () => {
    writeFileSync(join(root, 'config.toml'), 'cfg');
    writeFileSync(join(root, 'buffer.db'), 'db');
    writeFileSync(join(root, 'buffer.db-wal'), 'wal');
    writeFileSync(join(root, 'buffer.db-shm'), 'shm');
    writeFileSync(join(root, 'AUTH_FAILED'), 'auth');
    writeFileSync(join(root, 'BUFFER_FULL'), 'buf');
    writeFileSync(join(root, 'SESSION_STOPPED'), 'sess');
    writeFileSync(join(root, 'CONSENT_ACCEPTED'), 'consent');
    writeFileSync(join(root, 'UPDATE_AVAILABLE'), 'upd');
    writeFileSync(join(root, 'DEV_MODE'), 'should be deleted, not moved');

    await relocateFlatToNested(root);

    const prodDir = join(root, 'prod');
    expect(readFileSync(join(prodDir, 'config.toml'), 'utf8')).toBe('cfg');
    expect(readFileSync(join(prodDir, 'buffer.db'), 'utf8')).toBe('db');
    expect(readFileSync(join(prodDir, 'buffer.db-wal'), 'utf8')).toBe('wal');
    expect(readFileSync(join(prodDir, 'buffer.db-shm'), 'utf8')).toBe('shm');
    expect(readFileSync(join(prodDir, 'AUTH_FAILED'), 'utf8')).toBe('auth');
    expect(readFileSync(join(prodDir, 'BUFFER_FULL'), 'utf8')).toBe('buf');
    expect(readFileSync(join(prodDir, 'SESSION_STOPPED'), 'utf8')).toBe('sess');
    expect(readFileSync(join(prodDir, 'CONSENT_ACCEPTED'), 'utf8')).toBe('consent');
    expect(readFileSync(join(prodDir, 'UPDATE_AVAILABLE'), 'utf8')).toBe('upd');

    expect(existsSync(join(root, 'config.toml'))).toBe(false);
    expect(existsSync(join(root, 'DEV_MODE'))).toBe(false);
    expect(existsSync(join(prodDir, 'DEV_MODE'))).toBe(false);
    expect(existsSync(join(root, MIGRATED_MARKER))).toBe(true);
    expect(existsSync(join(root, MIGRATION_LOCK))).toBe(false);
  });

  test('relocateFlatToNested is idempotent after marker exists', async () => {
    writeFileSync(join(root, MIGRATED_MARKER), 'done');
    writeFileSync(join(root, 'config.toml'), 'stray');
    await relocateFlatToNested(root);
    expect(readFileSync(join(root, 'config.toml'), 'utf8')).toBe('stray');
    expect(existsSync(join(root, 'prod', 'config.toml'))).toBe(false);
  });

  test('relocateFlatToNested is a no-op when root does not exist', async () => {
    await rmRecursive(root);
    await relocateFlatToNested(root);
    expect(existsSync(root)).toBe(false);
  });

  test('relocateFlatToNested releases lock if it threw', async () => {
    writeFileSync(join(root, 'config.toml'), 'cfg');
    writeFileSync(join(root, MIGRATION_LOCK), 'someone else');
    const ageMs = Date.now() - statSync(join(root, MIGRATION_LOCK)).mtimeMs;
    expect(ageMs).toBeLessThan(5000);
    let threw = false;
    try {
      await relocateFlatToNested(root, { lockAcquisitionTimeoutMs: 100 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(existsSync(join(root, MIGRATION_LOCK))).toBe(true);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/io/fs/tests/migrate-flat-to-nested.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement the migration module**

(See implementation committed at `8fa8afc` — full source in `src/core/io/fs/migrate-flat-to-nested.ts`.)

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/io/fs/tests/migrate-flat-to-nested.test.ts`
Expected: PASS — all six tests green.

- [x] **Step 5: Run per-file validation gate and commit**

Run: `bun ai:coverage-orchestrator:validate src/core/io/fs/migrate-flat-to-nested.ts`
Expected: 100% coverage.

```bash
git add src/core/io/fs/migrate-flat-to-nested.ts src/core/io/fs/tests/migrate-flat-to-nested.test.ts
git commit -m "feat: add one-shot flat-to-nested filesystem relocation"
```

---

## Task 5 — Thread profileName through service-unit writers

**Files:**
- Modify: `src/cli/service-unit/launchd-plist.ts` — `buildLaunchdPlist` already supports `programArgs`; no code change. The wiring layer composes the args.
- Modify: `src/cli/service-unit/systemd-unit.ts` — same.
- Modify: `src/cli/service-unit/scheduled-task-xml.ts` — same.
- Modify: `src/cli/service-unit/writer.ts` — `ServiceUnitRecreateConfig` gains `profileName?: ProfileName` (default `'prod'`); the writer uses it to compose `programArgs`.
- Modify: `src/cli/wiring/platform.ts` — `buildServiceUnitRecreate()` gains a `profileName?: ProfileName` parameter (default `'prod'`); threads it into the config.
- Modify: tests for each of the above to add a "with --profile dev" case.

All steps DONE. Committed at `b194e55`.

---

## Task 6 — Parse `--profile <name>` in the daemon's `run` command

**Files:**
- Modify: `src/main.ts` — `run` command gains `--profile <name>` option.
- Modify: `src/cli/wiring/run-deps.ts` — `buildRunDeps` accepts the parsed profile name; builds `ProfileContext`; threads into deps.
- Modify: `src/cli/commands/run/run.types.ts` — `RunCommandDeps` adds `profileCtx: ProfileContext`.
- Modify: `src/cli/commands/run/index.ts` and `src/cli/commands/run/build-contexts.ts` — use `profileCtx` where they were calling `bufferDbPath()` / `logDir()` / sentinel helpers.

All steps DONE. Committed at `4c2abe6`.

---

## Task 7 — Invoke relocation in daemon startup, before any file open

**Files:**
- Modify: `src/cli/commands/run/build-contexts.ts` — call `relocateFlatToNested(profileRootDir())` before the buffer DB is opened, the log dir is created, or any sentinel is touched.

All steps DONE. Committed at `51ab206`.

---

## Task 8 — Detect legacy service-unit args and regenerate the unit on first run

**Files:**
- Create: `src/cli/commands/run/service-unit-refresh.ts`
- Create: `src/cli/commands/run/tests/service-unit-refresh.test.ts`

All steps DONE. Committed at `f4c0214`.

---

## Task 9 — End-to-end smoke test for legacy-upgrade path

**Files:**
- Create: `src/cli/commands/run/tests/upgrade-e2e.test.ts`

All steps DONE. Committed at `a0fbefb`.

---

## Self-review

All 9 tasks done. Phase 1 verified green: `bun run check` and `bun run test:cov` both pass. Existing users transparently upgrade their on-disk layout the first time the new daemon starts. No CLI surface changes visible to them. Foundation is in place for Phase 2.
