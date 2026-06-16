# Auto-Update Flow

How a running daemon notices a new release, downloads the matching binary,
and restarts itself. This is the upgrade service (`src/services/upgrade/`)
working with the heartbeat loop (`src/services/polling/heartbeat-cycle.ts`)
and the coordinated-upgrade coordinator (`src/services/upgrade/coordinated-upgrade.ts`).

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

## Who upgrades

**Only the prod daemon upgrades.** The dev daemon's heartbeat is gated by `profileCtx.isDev` — when true, `autoUpgradeFromConfig` (and `coordinatedUpgrade`) is never called. This prevents two concurrent upgrade attempts.

## Branch: brew vs everything else

`shouldRunAutoUpgrade(ctx)` branches on `installSource`:

- `installSource === 'brew'` → run `runBrewSentinelCheck`: hit the GitHub
  API, write `UPDATE_AVAILABLE` sentinel with the new version + asset
  URL, and exit. **Never** writes the binary itself. The user must run
  `brew upgrade` to actually replace the binary (brew owns that path on
  disk).
- Anything else → `coordinatedUpgrade` (when a dev config exists) or `runAutoUpgrade` (when no dev daemon is configured).

## Coordinated upgrade (prod+dev path)

When `devConfigExists()` is true, the heartbeat calls `coordinatedUpgrade(deps)` instead of the simple `runAutoUpgrade` path. The coordinator in `src/services/upgrade/coordinated-upgrade.ts`:

1. Acquire `.upgrade.lock` (file lock via `{ flag: 'wx' }`). **Abort** if already held (another upgrade is in flight).
2. Check if the dev daemon is running via `devServiceManager`.
3. If running: write `.upgrade-restore-state` JSON (`{ devWasRunning: true }`) atomically, then stop the dev daemon. Poll for exit up to 30 s. On timeout: log error, release lock, abort this cycle; retry next heartbeat.
4. Call `downloadAndReplaceBinary()` (wraps `checkLatestVersion` + `downloadAsset` + `replaceBinary`). On failure: restore dev daemon from restore-state (start it again), release lock, return.
5. On success: log `auto_upgrade.success`. Call `exitProcess()`. The service manager respawns the prod daemon on the new binary.

## Post-respawn restore (startup hook)

When the **new** prod daemon starts via the `run` command, before launching the daemon loops it calls `runUpgradePostRespawnRestore(deps)`:

1. Read `.upgrade-restore-state`. If absent, nothing to do.
2. If `devWasRunning: true` AND `dev/config.toml` exists → start the dev service unit (try/catch; log failure but continue).
3. Delete `.upgrade-restore-state` and release `.upgrade.lock` regardless of whether dev start succeeded.

If the dev start fails (e.g. network issue, platform error): logs the error and continues. The user can manually run `proxai-gateway dev on` (or `proxai-gateway start --profile dev`) to bring the dev daemon back.

## Simple upgrade (no dev daemon configured)

When `devConfigExists()` is false, the heartbeat calls `runAutoUpgrade(deps)` in `auto-upgrade.ts`:

1. **Skip** if `devMode === true` or `installSource === 'brew'` (defensive re-check).
2. Call `checkLatestVersion` which hits
   `https://api.github.com/repos/proxai/proxai_gateway/releases/latest`
   with a 5 s timeout. Three outcomes:
   - `kind: 'ok'` — got a release, may or may not have an update
   - `kind: 'no_release'` — 404 (repo has no published releases yet)
   - `kind: 'error'` — network failure, malformed JSON, etc.; logged as
     `auto_upgrade.check_failed` at FATAL level
3. Stash the latest version in metadata via `onLatestVersionKnown` →
   `setMetadata(METADATA_KEYS.latestKnownVersion, v)` so `status` can
   show "update available" even between download attempts.
4. If `hasUpdate === false`, return. Done.
5. Find the matching asset URL. The expected name is
   `proxai-gateway-${platform}-${arch}${ext}`. If no asset matches, log
   `auto_upgrade.no_asset` (FATAL) and return.
6. `downloadAsset(assetUrl, { userAgent: 'proxai-gateway-auto-upgrade',
   timeoutMs: DOWNLOAD_TIMEOUT_MS = 120_000 })`. Returns `Uint8Array`.
   Empty body → `auto_upgrade.download_failed` (FATAL).
7. `replaceBinary(binaryPath, bytes, platform)`:
   - **POSIX**: writes bytes to `<binaryPath>.new`, calls `setMode(staged, 0o755)`, then atomically renames the sibling to `<binaryPath>`.
   - **Windows**: writes `<binaryPath>.new` instead — you cannot overwrite
     a running `.exe` on Windows.
8. Log `auto_upgrade.success` (INFO).
9. Call `deps.exitProcess()`. The service manager respawns the daemon.

## Brew sentinel path (`runBrewSentinelCheck`)

1. Hit `checkLatestVersion`.
2. On `ok` with `hasUpdate === true`: `writeUpdateAvailableSentinel` with
   `{ latest_version, current_version, detected_at, asset_url? }`. The
   `status` command surfaces this so users see "brew upgrade available".
3. On `ok` with `hasUpdate === false`: `clearUpdateAvailableSentinel`.
4. On `error`: log `version_check.unavailable` (WARN), do not change
   sentinel state. Retried next cycle.

For brew: both the prod and dev daemons run the same `runBrewSentinelCheck` (brew replaces the binary externally; each daemon detects the stale binary via `checkStaleBinary` and respawns under the new binary independently, ~1 h worst-case convergence).

## Race conditions and safety

- **Upgrade lock held**: if `.upgrade.lock` exists when heartbeat checks, abort and retry next cycle.
- **Download in flight, daemon receives SIGTERM**: the temp body is in-memory only; nothing on disk to clean up.
- **Binary replace fails after dev was stopped**: the post-failure path in `coordinatedUpgrade` reads `.upgrade-restore-state` and starts dev again before returning.
- **Two daemons racing (unexpected)**: POSIX `Bun.write` is atomic at the inode level so the last writer wins; the `isDev` gate prevents this in normal operation.
- **GitHub rate-limit**: unauthenticated reads of `/releases/latest` are 60/hour per IP. The 4-hour gate makes this a non-issue in practice.

[source: src/services/upgrade/auto-upgrade.ts; src/services/upgrade/release-fetch.ts; src/services/upgrade/coordinated-upgrade.ts; src/services/upgrade/upgrade-restore-state.ts; src/services/polling/heartbeat-cycle.ts; src/services/polling/version-check.ts; src/cli/wiring/upgrade-restore-deps.ts; src/main.ts]
