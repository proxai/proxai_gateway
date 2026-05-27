# Auto-Update Flow

How a running daemon notices a new release, downloads the matching binary,
and restarts itself. This is the upgrade service (`src/services/upgrade/`)
working with the heartbeat loop (`src/services/polling/heartbeat-cycle.ts`).

## Trigger surface

Auto-upgrade is invoked **only from the heartbeat cycle**, which runs every
`HEARTBEAT_INTERVAL_MS = 60 * 60_000` (= 1 hour) per
`polling.constants.ts`. The cycle has no sentinel gate — it must run even
with `AUTH_FAILED` or `BUFFER_FULL` present so the daemon can upgrade
itself out of a broken state.

Inside heartbeat:

1. `checkStaleBinary` runs first — if the binary is ≥
   `pauseAfterDays` (60 by default) old, it logs `stale_binary.stale` so
   the warning surfaces in `status` and logs. It does **not** pause the
   daemon; auto-upgrade will replace the binary on this same heartbeat.
2. `maybeRunAutoUpgrade` checks the `last_version_check_at` metadata
   key. If less than `DEFAULT_VERSION_CHECK_INTERVAL_MS = 4 hours` has
   passed, skip. This is a second guard layer on top of the 1-hour
   heartbeat tick.

## Branch: brew vs everything else

`shouldRunAutoUpgrade(ctx)` (`heartbeat-cycle.ts:72-77`) branches on
`installSource`:

- `installSource === 'brew'` → run `runBrewSentinelCheck`: hit the GitHub
  API, write `UPDATE_AVAILABLE` sentinel with the new version + asset
  URL, and exit. **Never** writes the binary itself. The user must run
  `brew upgrade` to actually replace the binary (brew owns that path on
  disk).
- Anything else → run `runAutoUpgrade`: download the matching asset and
  replace the binary in-place.

## In-place upgrade (non-brew path)

`runAutoUpgrade(deps)` in `auto-upgrade.ts:17`:

1. **Skip** if `devMode === true` or `installSource === 'brew'` (defensive
   re-check).
2. Call `checkLatestVersion` which hits
   `https://api.github.com/repos/proxai/proxai_gateway/releases/latest`
   with a 5 s timeout (`version-check.ts:27`). Three outcomes:
   - `kind: 'ok'` — got a release, may or may not have an update
   - `kind: 'no_release'` — 404 (repo has no published releases yet);
     not an error
   - `kind: 'error'` — network failure, malformed JSON, etc.; logged as
     `auto_upgrade.check_failed` at FATAL level
3. Stash the latest version in metadata via `onLatestVersionKnown` →
   `setMetadata(METADATA_KEYS.latestKnownVersion, v)` so `status` can
   show "update available" even between download attempts.
4. If `hasUpdate === false`, return. Done.
5. Find the matching asset URL. The expected name is
   `proxai-gateway-${platform}-${arch}${ext}` where `platform` is the
   Node-style `win32` / `darwin` / `linux`. If no asset matches, log
   `auto_upgrade.no_asset` (FATAL) and return.
6. `downloadAsset(assetUrl, { userAgent: 'proxai-gateway-auto-upgrade',
   timeoutMs: DOWNLOAD_TIMEOUT_MS = 120_000 })`. Returns `Uint8Array`.
   Empty body → `auto_upgrade.download_failed` (FATAL).
7. `replaceBinary(binaryPath, bytes, platform)`:
   - **POSIX**: `Bun.write(binaryPath, bytes)` then `setMode(0o755)`.
     Overwrites the running ELF/Mach-O — the kernel keeps the in-memory
     image valid; the next process load uses the new file.
   - **Windows**: writes `<binaryPath>.new` instead — you cannot overwrite
     a running `.exe` on Windows. The next service-manager restart cycle
     is responsible for swapping. (`release-fetch.ts:99-112`)
8. Log `auto_upgrade.success` (INFO).
9. Call `deps.exitProcess()`. The service manager (launchd / systemd /
   schtasks) respawns the daemon, which loads the new binary.

The `exitProcess()` call is intentional and **must not** be guarded
against — see `ai/rules/services/daemon-loops.md`. Heartbeat is the only
loop that ever calls it.

## Brew sentinel path (`runBrewSentinelCheck`)

`heartbeat-cycle.ts:111-155`:

1. Hit `checkLatestVersion`.
2. On `ok` with `hasUpdate === true`: `writeUpdateAvailableSentinel` with
   `{ latest_version, current_version, detected_at, asset_url? }`. The
   `status` command surfaces this so users see "brew upgrade available".
3. On `ok` with `hasUpdate === false`: `clearUpdateAvailableSentinel`.
4. On `error`: log `version_check.unavailable` (WARN), do not change
   sentinel state. Retried next cycle.

The brew binary path is opaque to the daemon — Homebrew may symlink it
through Cellar, may relocate on `brew upgrade`. The daemon never tries
to overwrite a brew binary because the resulting state (real file vs
symlink, ownership) is fragile.

## Race conditions and safety

- **Download in flight, daemon receives SIGTERM**: the temp body is
  in-memory only; nothing on disk to clean up.
- **Replace succeeds, exitProcess fails to terminate**: the running
  process keeps the old code in memory. Next time the OS spawns from
  disk (next service restart), the new binary is loaded. No data loss.
- **Two daemons running** (manual `proxai-gateway run` + service
  manager): both will hit the heartbeat, both will try to replace
  the binary. POSIX `Bun.write` is atomic at the inode level so the
  last writer wins; the older PID keeps the old inode alive. Not
  ideal but not corrupting.
- **GitHub rate-limit**: unauthenticated reads of
  `/releases/latest` are 60/hour per IP. The 4-hour gate makes this a
  non-issue in practice.

[source: src/services/upgrade/auto-upgrade.ts, src/services/upgrade/release-fetch.ts, src/services/polling/heartbeat-cycle.ts, src/services/polling/version-check.ts]
