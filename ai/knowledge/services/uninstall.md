# uninstall

`src/services/uninstall/` is the cleanup machinery invoked by `proxai-gateway uninstall`. It is **not** a daemon module — there are no loops, no contexts, no scheduled work. It composes three independent sub-modules: `sweep.ts` (package-manager detection + removal), `path-cleanup.ts` (shell rc / Windows PATH), and `binary-remove.ts` (direct binary file removal).

## What gets removed

| Component | Removed by | Always? |
| --- | --- | --- |
| The npm/pnpm/yarn/bun global install | `createSweep().uninstall(name)` | Only if `createSweep().detectAll()` finds it installed for that PM. Multi-PM is possible (e.g. installed via brew but also globally via npm) — every detected PM is uninstalled. |
| The brew formula `proxai-gateway` | `createSweep().uninstallBrew()` | Only if brew is available AND `brew list --formula --versions proxai-gateway` succeeds. |
| Direct binary at `<execPath>` (e.g. `~/.proxai/bin/proxai-gateway`) | `createDefaultBinaryRemover(platform).remove(execPath, { installDir? })` | When `isDirectBinary(execPath)` returns true (path is not under `node_modules/` or `Cellar/`). |
| Install dir (e.g. `~/.proxai/bin`) | Same, via `rmdir` (POSIX) or `rmdir "<dir>" 2>nul` (Windows) | Only if `installDir` is passed; failures swallowed (`rmdir` of non-empty dir is silently ignored). |
| Shell rc PATH block | `createPosixShellPathCleaner(deps).clean(installDir)` walks `~/.zshrc`, `~/.bashrc`, `~/.bash_profile` and removes blocks matching the installer marker. | POSIX only. |
| Windows User PATH entry | `createWindowsShellPathCleaner({}).clean(installDir)` runs a PowerShell script editing `[Environment]::SetEnvironmentVariable('PATH', …, 'User')`. | Windows only. |

## What is **preserved** (intentionally)

- `config.toml` (under `configDir()`)
- `buffer.db` (under `configDir()`)
- Sentinel files (`AUTH_FAILED`, `BUFFER_FULL`, etc. — under `configDir()`)
- Log files (under `logDir()`)
- Any `quarantined_records` metadata still in `buffer.db`

The `uninstall` command does NOT touch these. Reinstalling re-uses the existing config and buffer. To fully reset, use `uninstall --reset` (which clears `configDir()` and `logDir()` as a separate step; that logic lives in the CLI command, not in `services/uninstall`).

## Per-platform paths

| Platform | Direct binary install dir | PATH side-effect | Shell rc files |
| --- | --- | --- | --- |
| macOS | `~/.proxai/bin/` (GitHub-release/direct), `/opt/homebrew/Cellar/proxai-gateway/<v>/bin/` (brew) | rc files | `~/.zshrc`, `~/.bashrc`, `~/.bash_profile` |
| Linux | `~/.proxai/bin/` (GitHub-release/direct), `/home/linuxbrew/.linuxbrew/Cellar/…` (brew) | rc files | `~/.zshrc`, `~/.bashrc`, `~/.bash_profile` |
| Windows | `%USERPROFILE%\.proxai\bin\` (direct) | User PATH registry entry | (none — Windows PATH is registry-based) |

## Package-manager sweep (`sweep.ts`)

`createSweep(runner)` builds a `PackageManagerSweep` that takes a `CommandRunner` (so tests can mock subprocess). `realCommandRunner` uses `Bun.which(file)` + `Bun.spawn` — if `Bun.which` returns `null` it returns `{ stdout: '', ok: false }` and the detector reports "not available".

| PM | Detect command | Parser |
| --- | --- | --- |
| npm | `npm ls -g --depth=0 --json @proxai/gateway` | `parseNpmLs` — checks `dependencies['@proxai/gateway']` |
| pnpm | `pnpm ls -g --depth=0 --json @proxai/gateway` | `parsePnpmLs` — pnpm's output is an array; checks `[0].dependencies['@proxai/gateway']` |
| yarn | `yarn global list --json` | `parseYarnList` — line includes `"@proxai/gateway@` |
| bun | `bun pm ls -g` | `parseBunPmLs` — text contains `@proxai/gateway` |

Uninstall commands:

| PM | Command |
| --- | --- |
| npm | `npm uninstall -g @proxai/gateway` |
| pnpm | `pnpm uninstall -g @proxai/gateway` |
| yarn | `yarn global remove @proxai/gateway` |
| bun | `bun remove -g @proxai/gateway` |

Brew: `brew list --formula --versions proxai-gateway` to detect, `brew uninstall proxai-gateway` to remove.

## Path cleanup (`path-cleanup.ts`)

`MARKER = '# Added by ProxAI Gateway installer'`, `INSTALL_DIR_HINT = '.proxai/bin'`. The cleaner reads each rc file via `Bun.file`, runs `stripPathMarkerBlock(content)` (from `core/utils::stripMarkerBlock`), which removes the marker line + the following line **only** if the following line includes `INSTALL_DIR_HINT`. This protects against accidentally clobbering rc edits the user made for other tools that re-used the same marker.

Possible per-file outcomes (`PathCleanupOutcome.reason`):

- `'removed installer PATH block'` — happy path.
- `'file not present'` — rc file missing (common on systems with no zsh).
- `'no installer marker found'` — clean install; nothing to do.
- `'marker found but next line did not reference our install dir; left untouched'` — bail-out for safety.
- `'read failed: <err>'` / `'write failed: <err>'` — IO error surfaced verbatim.

Windows uses a PowerShell script via `Bun.spawn('powershell.exe', ['-NoProfile', '-Command', POWERSHELL_SCRIPT], { env: { …process.env, PROXAI_INSTALL_DIR: installDir } })`. The script reads `User` PATH, filters out entries equal to `PROXAI_INSTALL_DIR` (after `TrimEnd('\')`), and writes back.

## Direct binary remove (`binary-remove.ts`)

POSIX (`createPosixBinaryRemover`):

1. `unlink(execPath)` — ENOENT is silently treated as success (`removed = false`, but `ok = true`).
2. Any other error → `{ ok: false, deferred: false, message: '...' }`.
3. If `installDir` provided, `rmdir(installDir)` swallowing all errors (non-empty dir → no-op).
4. Return `{ ok: true, deferred: false, message: 'removed <path>' | 'binary already gone: <path>' }`.

Windows (`createWindowsBinaryRemover`) — the running `.exe` is locked, so the remove is **deferred**:

```
ping -n 3 127.0.0.1 >nul        # ~3 s delay so the daemon can exit
& del /F /Q "<execPath>"
& if exist "<execPath>.new" del /F /Q "<execPath>.new"
[& rmdir "<installDir>" 2>nul]
```

Wrapped in `Bun.spawn('cmd.exe', ['/c', cmd], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })`. Returns `{ ok: true, deferred: true, message: 'scheduled removal of <path> on exit' }`. The CLI then exits, the spawned `cmd.exe` waits 3 s, then deletes both the binary and any leftover staged `.new` (from a prior failed upgrade).

`isDirectBinary(execPath)` returns false if path contains `/node_modules/`, `\node_modules\`, or `/Cellar/` — in those cases the package manager owns deletion and direct removal is unsafe.

## Composition

The CLI command orchestrates these sub-modules in this order:

1. `createSweep(realCommandRunner).detectAll()` → uninstall every detected PM.
2. `createSweep(realCommandRunner).detectBrew()` → if installed, `uninstallBrew()`.
3. `createDefaultShellPathCleaner(process.platform).clean(installDir)`.
4. If `isDirectBinary(execPath)`, `createDefaultBinaryRemover(process.platform).remove(execPath, { installDir })`.

The CLI command logic itself lives in `src/cli/commands/uninstall.ts` (not under services); this module only provides the building blocks.

[source: src/services/uninstall/sweep.ts:34-135; src/services/uninstall/path-cleanup.ts:25-172; src/services/uninstall/binary-remove.ts:22-103]
