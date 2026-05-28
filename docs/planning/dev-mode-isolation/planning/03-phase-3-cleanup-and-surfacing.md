# Phase 3 — Cleanup + Surfacing Implementation Plan

> **STATUS: DONE.** All 7 tasks complete. Commits: `b527aee` (remove resolveNestBaseUrl + dead URL constants), `71c6f92` (delete legacy zero-arg path helpers), `1a20912` (README docs), `a54057a` (ai/knowledge update). `bun run check` clean; 2286 tests pass / 0 fail.

**Goal:** Delete the legacy zero-arg path helpers (now unused after Phase 2). Surface profile-awareness in user-facing CLI output: `status` shows which profile it's reporting; `tail` reads from the selected profile's logs; `inspect` scans only the active profile's buffer. Update documentation (`README.md`, `docs/`, `ai/knowledge/`) to reflect the dual-daemon model.

**Architecture:** Pure cleanup. The bare `configDir()`, `bufferDbPath()`, `logDir()`, sentinel-path helpers in `src/core/io/fs/paths.ts` are deleted; only `buildProfileContext()` produces paths going forward. Tests verify no remaining callsites compile against the deleted helpers. User-facing output gets a `(prod)` / `(dev)` suffix on the daemon line; `status --all` shows both daemons side-by-side.

**Tech Stack:** Same as Phases 1–2. No new dependencies.

---

## File structure

**Modified files:**
- `src/core/io/fs/paths.ts` — delete `configDir()`, `bufferDbPath()`, `configFilePath()`, `logDir()`, `controlSocketPath()`, and all `*SentinelPath()` helpers. Keep `expandHome()` and `legacyRootDir()`.
- `src/core/io/fs/index.ts` — update barrel re-exports.
- `src/cli/commands/status/render-human.ts`, `render/render-sections.ts`, `unified-summary.ts`, etc. — append profile name to the daemon-line label.
- `src/cli/commands/status/index.ts` — accept and surface `--all` flag (shows both profiles).
- `src/cli/commands/tail/index.ts` — use `profileCtx.logDir` for the log-stream root.
- `src/cli/commands/inspect/index.ts` — scan `profileCtx.bufferDbPath` and `profileCtx.configFilePath`.
- `README.md` — document new commands and `--profile` flag.
- `docs/04-daemon-loops/*.md`, `docs/01-foundations/*.md`, `docs/07-platform-and-deployment/*.md` — mention dual-daemon model where relevant.
- `ai/knowledge/cli/commands-overview.md`, `ai/knowledge/cli/wiring.md`, `ai/knowledge/cross-platform/file-paths-per-platform.md`, `ai/knowledge/release/auto-update-flow.md`, `ai/knowledge/services/sentinels/sentinel-lifecycle.md` — sync with the new architecture.
- Run `bun run ai/mapper/index.ts` to redistribute updated `ai/` files into `.claude/` and `.<other-tool>/`.

---

## Task 1 — Audit remaining callsites of legacy path helpers

**STATUS: DONE.** Audit showed empty output — all callsites migrated in Phase 2.

Audit command:

```bash
grep -rn "configDir()\|bufferDbPath()\|configFilePath()\|logDir()\|controlSocketPath()\|authFailedSentinelPath()\|bufferFullSentinelPath()\|sessionStoppedSentinelPath()\|consentSentinelPath()\|updateAvailableSentinelPath()" src/ --include="*.ts" | grep -v "src/core/io/fs/paths.ts\|src/core/io/fs/tests/paths.test.ts"
```

---

## Task 2 — Delete legacy zero-arg path helpers

**STATUS: DONE** — `71c6f92` (`refactor: delete legacy zero-arg path helpers`)

**Files modified:**
- `src/core/io/fs/paths.ts` — removed all zero-arg functions except `expandHome` and `legacyRootDir`.
- `src/core/io/fs/index.ts` — removed re-exports of deleted helpers.
- `src/core/io/fs/tests/paths.test.ts` — removed tests for deleted helpers.

Final `paths.ts` reduced to:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { profileRootDir } from 'core/io/fs/profile.ts';

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

---

## Task 3 — Surface profile in `status` command output

**STATUS: DONE** — included in Phase 2 Task 9 (`e66f1ad`).

`StatusSnapshot` gained `profileName: ProfileName`. `render-human.ts` and `render/render-sections.ts` append `(${snapshot.profileName})` to the daemon line. `build-json.ts` includes `profile_name` in JSON output.

---

## Task 4 — Add `status --all` for both profiles side-by-side

**STATUS: DONE** — included in Phase 2 Task 9 (`e66f1ad`).

`--all` flag collects snapshots for both profiles (two contexts, run snapshot collection twice) and renders both stacked.

---

## Task 5 — Update `tail` and `inspect` to honor profile

**STATUS: DONE** — Phase 2 Task 3 threaded `--profile` through all commands including `tail` and `inspect`. Both already read from `profileCtx.logDir` and `profileCtx.bufferDbPath` respectively after the Phase 2 wiring migration.

---

## Task 6 — Update documentation

**STATUS: DONE** — `1a20912` (`docs: document dual-daemon dev mode and --profile flag`) + `a54057a` (`docs: update ai/knowledge for dual-daemon architecture`)

**Files updated:**
- `README.md` — added "Dev mode" section documenting `dev setup`, `dev on`, `dev off`, `status --all`, `--profile <name>`. Dev mode itself is NOT documented in the visible section (hidden from prod users per design); only the `dev setup` and `--profile` flag are surface-visible in README.
- `docs/04-daemon-loops/*.md` — noted dual-daemon model.
- `docs/07-platform-and-deployment/7.2-install-upgrade-uninstall.md` — coordinated upgrade flow.
- `ai/knowledge/cli/commands-overview.md` — added `dev setup` / `dev on` / `dev off` / `--profile`.
- `ai/knowledge/cli/wiring.md` — noted that wiring takes `profileCtx`.
- `ai/knowledge/cross-platform/file-paths-per-platform.md` — showed new nested layout.
- `ai/knowledge/release/auto-update-flow.md` — coordinated upgrade flow.
- `ai/knowledge/services/sentinels/sentinel-lifecycle.md` — sentinels are now per-profile.
- `bun run ai/mapper/index.ts` — redistributed `ai/` changes to `.claude/knowledge/`.

---

## Task 7 — Final regression check

**STATUS: DONE.**

`bun run check` — green.
`bun run test:cov` — 2286 tests pass / 0 fail.

Runtime smoke (e2e / running the actual daemon) is DEFERRED — see `../README.md` "Deferred / next" section. No daemon was run at any point during implementation.

---

## Self-review

1. **Spec coverage:**
   - Delete legacy path helpers → Task 2 (DONE, `71c6f92`).
   - Surface profile in status → Tasks 3 and 4 (DONE, Phase 2 `e66f1ad`).
   - tail/inspect respect profile → Task 5 (DONE, Phase 2 Task 3).
   - Documentation → Task 6 (DONE, `1a20912` + `a54057a`).
   - End-to-end regression (unit/lint/type) → Task 7 (DONE — check green, 2286/0).

2. **No regressions:** Task 1 audit confirmed empty before Task 2 deletion. Task 2's validation caught all missed callsites via compile errors.

3. **Documentation completeness:** Every user-facing behavior change is in README; every architectural change is in `docs/` and `ai/knowledge/`. The mapper redistributed `ai/` to `.claude/`.

4. **What this phase finishes:** the dev-mode-isolation initiative (code-complete). After Phase 3 lands, the codebase has no legacy zero-arg path helpers; only `buildProfileContext()` produces paths. User-facing CLI shows profile awareness where it matters. Documentation is in sync. Ready for e2e verification and then CalVer release.
