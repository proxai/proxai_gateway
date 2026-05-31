# upgrade

`src/services/upgrade/` is the auto-update mechanism. It runs from the heartbeat loop (default once per hour) but is itself throttled by `metadata.last_version_check_at` (default 4 h between checks). Two install-source branches: brew → write `UPDATE_AVAILABLE` sentinel only; everything else → in-place binary replacement + `exitProcess()`.

## Public surface

`src/services/upgrade/index.ts` re-exports just two modules:

| File | Symbols |
| --- | --- |
| `auto-upgrade.ts` | `runAutoUpgrade(deps)`, `AutoUpgradeDeps` |
| `release-fetch.ts` | `fetchLatestRelease`, `expectedAssetName`, `findAssetForPlatform`, `downloadAsset`, `replaceBinary`, plus `RELEASE_API_URL`, `FETCH_TIMEOUT_MS = 5_000`, `DOWNLOAD_TIMEOUT_MS = 120_000` |

(Note: the live version-check used by the heartbeat is `services/polling/version-check.ts::checkLatestVersion`, not `release-fetch.ts::fetchLatestRelease`. `runAutoUpgrade` calls `checkLatestVersion`; `release-fetch.ts` is a lower-level toolkit available for ad-hoc tooling.)

## `runAutoUpgrade(deps)`

```ts
interface AutoUpgradeDeps {
  binaryPath: string;
  currentVersion: string;
  devMode?: boolean;
  installSource?: InstallSource;
  fetch?: typeof globalThis.fetch;
  logger?: Logger;
  exitProcess?: () => void;
  platform?: NodeJS.Platform;
  arch?: string;
  onLatestVersionKnown?: (latestVersion: string) => void;
}
```

Flow:

1. **Early exit (no-op)**: `devMode === true` OR `installSource === 'brew'` OR `isLocalBuildPath(binaryPath)` (a binary running from a `/dist/` path — a local `bun run build` output). Returns `void`. The local-build guard mirrors the CLI `upgrade` command and stops auto-upgrade from clobbering a developer's local build with the published release (whose CalVer version is almost always *higher* than the stale `package.json` version a local build self-reports). `isLocalBuildPath` lives in `services/upgrade/local-build.ts`; `cli/commands/status/local-build.ts` re-exports it.
2. `checkLatestVersion({ currentVersion, platform, arch, fetch? })`:
   - `kind === 'error'` → log `auto_upgrade.check_failed` (FATAL level) and return.
   - `kind === 'no_release'` → return silently (repo has no published releases; common in dev).
   - `kind === 'ok'` → continue.
3. `onLatestVersionKnown?.(latestVersion)` — heartbeat uses this to persist `metadata.latest_known_version` even when there is no update to install.
4. If `!hasUpdate` → return.
5. If `assetUrl === undefined` → log `auto_upgrade.no_asset` (FATAL) with `expected: expectedAssetName(platform, arch)` and return. This means the release exists but doesn't have a binary for our platform/arch.
6. `downloadAsset(assetUrl, { fetch?, userAgent: 'proxai-gateway-auto-upgrade' })`:
   - Failure → log `auto_upgrade.download_failed` (FATAL) and return.
   - Empty body → log same event with `error: 'empty body'` and return.
7. `replaceBinary(binaryPath, bytes, platform)`:
   - Failure → log `auto_upgrade.write_failed` (FATAL) and return.
8. Log `auto_upgrade.success` (INFO) with `latest` and `current`.
9. `exitProcess?.()` — the service manager respawns from the new binary. This exit is intentional and the heartbeat loop tolerates it.

## Version comparison (`checkLatestVersion` in polling/version-check.ts)

`compareVersionStrings(a, b)`:

- `parseVersion(v)`: split on `-` and keep the prefix (`'2026.5.8-1' → '2026.5.8'`), then split on `.`, parse each as int (NaN → 0).
- Pad both arrays to the longer length with `0`. Compare positionally, return `1`/`0`/`-1`.

This works for both SemVer-shaped and CalVer-shaped versions because the comparison is purely positional integer arithmetic. The `-1` suffix on same-day CalVer retries is silently dropped by the prefix-on-dash heuristic — meaning `2026.5.8-1` compares equal to `2026.5.8`. **This is a known limitation**: same-day retry binaries are not auto-detected as upgrades, but in practice the original publish is what users have, so the comparison is fine.

## Platform asset matching

`expectedAssetName(platform, arch)`:

- Linux/macOS: `proxai-gateway-${platform}-${arch}` (e.g. `proxai-gateway-darwin-arm64`)
- Windows: `proxai-gateway-${platform}-${arch}.exe` (e.g. `proxai-gateway-win32-x64.exe`)

(Note: the release workflow renames its `windows-*` build artifacts to `win32-*` to match `process.platform === 'win32'`.)

`findAssetForPlatform(release, platform, arch)` returns the matching `ReleaseAsset` or `undefined`. The `runAutoUpgrade` path uses `checkLatestVersion`'s embedded matcher rather than calling this directly.

## Download (`downloadAsset`)

- `AbortController` with `DOWNLOAD_TIMEOUT_MS = 120_000` (2 min — binaries are ~40-80 MiB).
- Headers: `Accept: application/octet-stream`, `User-Agent: proxai-gateway-auto-upgrade`.
- Returns `new Uint8Array(buf)`. Empty body is allowed by `downloadAsset` itself; the empty-body check is in `runAutoUpgrade`.

## `replaceBinary` — platform divergence

```ts
async function replaceBinary(binaryPath, bytes, platform): Promise<{ stagedSibling: string | null }>
```

- POSIX: stage to `${binaryPath}.new` via `Bun.write`, `setMode(staged, 0o755)`, then `await rename(staged, binaryPath)`. Returns `{ stagedSibling: null }`. The `rename` is the load-bearing detail: `Bun.write(binaryPath, bytes)` truncates the **same inode** in place (verified — it is *not* tmpfile+rename), and modifying an already-executed binary in place leaves the kernel's per-inode code-signing verdict stale, so macOS SIGKILLs the respawn (and Linux throws `ETXTBSY` writing over a running binary). Renaming swaps in a fresh inode — the running daemon holds the old inode until `exitProcess()`, then the service manager respawns on the clean vnode. See `ai/rules/modules/cross-platform.md`.
- Windows: a running `.exe` is locked — even rename-over is impossible. Stage at `${binaryPath}.new` via `Bun.write` and stop there. Returns `{ stagedSibling: binaryPath + '.new' }`. The expectation is that the user (or a future supervisor) renames `.new` → real path on next start. **Currently the daemon does NOT itself perform the rename on Windows** — the staging is the upgrade step, and the service manager wrapper handles the rename. The Windows `uninstall` code cleans up any leftover `.exe.new` (see `uninstall.md`).
- Build/release signing: `scripts/build.ts` ad-hoc signs darwin outputs (`codesign --force --sign -`, gated on `Bun.which('codesign')`), and `release.yml` builds the darwin target on a `macos-latest` runner so that signing is native and adds a `codesign --verify` gate. bun's `--compile` produces an ad-hoc/linker-signed Mach-O whose signature fails `codesign --verify` ("code or signature have been modified") — usually benign on a fresh-install inode, but it is the latent hazard the build-time re-sign removes.

## Brew branch: `UPDATE_AVAILABLE` sentinel

When `installSource === 'brew'`, `runAutoUpgrade` is a no-op. Heartbeat takes a different path (`runBrewSentinelCheck` in `heartbeat-cycle.ts`):

1. `checkLatestVersion` runs.
2. On `hasUpdate === true`, `writeUpdateAvailableSentinel(path, { latest_version, current_version, detected_at, asset_url? })`.
3. On `hasUpdate === false`, `clearUpdateAvailableSentinel(path)`.
4. `proxai-gateway status` surfaces this sentinel; the user runs `brew upgrade proxai-gateway` manually.

This is because Homebrew owns the binary path (`/opt/homebrew/Cellar/proxai-gateway/<version>/bin/proxai-gateway`). Writing into that path would break Homebrew's metadata and the next `brew upgrade` would fail.

## Throttle (in heartbeat, not in `runAutoUpgrade`)

The throttle is enforced by `heartbeat-cycle.ts::maybeRunAutoUpgrade` before calling `runAutoUpgrade`:

```ts
const lastCheck = getMetadata(ctx.buffer, METADATA_KEYS.lastVersionCheckAt);
const lastMs = lastCheck === null ? 0 : Date.parse(lastCheck);
if (lastCheck !== null && Number.isFinite(lastMs) && Date.now() - lastMs < interval) return false;
```

Default `interval = ctx.versionCheckIntervalMs ?? DEFAULT_VERSION_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000`. After every check (success or failure), `metadata.last_version_check_at = nowIsoUtc()`. So even when the daemon restarts every hour for unrelated reasons, GitHub gets at most one release check every 4 h per host.

## Failure recovery

All FATAL-level logs (`auto_upgrade.check_failed`, `auto_upgrade.no_asset`, `auto_upgrade.download_failed`, `auto_upgrade.write_failed`) **do not** write any sentinel. The daemon keeps running on the old binary; the next heartbeat tick after the throttle expires re-tries. There is no exponential backoff on failed upgrade attempts — the throttle (4 h) is the only rate limit.

The stale-binary policy at 60 days logs a warning but does **not** write any sentinel — captures and drains keep running. The next heartbeat's auto-upgrade replaces the binary; if the upgrade succeeds the daemon exits with code 75 (`EXIT_CODE.upgradeRespawn`) and the service manager (launchd / systemd / Task Scheduler) immediately respawns it on the new binary.

[source: src/services/upgrade/auto-upgrade.ts; src/services/upgrade/release-fetch.ts; src/services/polling/version-check.ts; src/services/polling/heartbeat-cycle.ts; src/services/polling/stale-binary.ts]
