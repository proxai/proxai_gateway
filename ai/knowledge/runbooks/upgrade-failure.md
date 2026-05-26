# Runbook: Upgrade Failure

Symptom: auto-upgrade ran (heartbeat logged
`auto_upgrade.success`), but the daemon is still on the old version,
won't start at all, or shows mixed-state symptoms after an upgrade.

The upgrade flow is in `ai/knowledge/release/auto-update-flow.md`. This
runbook covers the failure paths along the way.

## Stage 1: identify where it failed

The four `auto_upgrade.*` events trace the upgrade lifecycle:

- `auto_upgrade.check_failed` — version check itself failed (network,
  GitHub API). No file changes happened. Retry next heartbeat.
- `auto_upgrade.no_asset` — version check succeeded but no matching
  binary for `${platform}-${arch}` in the release. Check the release
  page; this is a CI matrix gap.
- `auto_upgrade.download_failed` — asset URL existed but download
  failed or produced empty bytes. No file changes. Retry next
  heartbeat.
- `auto_upgrade.write_failed` — download succeeded but `replaceBinary`
  threw. This is the dangerous one — partial write or staged-sibling
  state may exist. See Stage 2.
- `auto_upgrade.success` — `replaceBinary` succeeded; `exitProcess`
  was called. If you're seeing this and the daemon is on the old
  version, see Stage 3.

```
proxai-gateway tail --level fatal --since 24h | grep auto_upgrade
```

## Stage 2: write_failed recovery

`replaceBinary` (`release-fetch.ts:99-112`) does:
- POSIX: `Bun.write(binaryPath, bytes)` then `setMode(0o755)`.
- Windows: `Bun.write(<binaryPath>.new, bytes)`.

A failure means either:
- Disk full → check `df -h` / `Get-PSDrive`.
- Permission denied on the binary path → the user installed under
  `/usr/local/bin` but the daemon runs as a non-root user without
  write access. Mismatch between install context (sudo) and runtime
  context (user). Either move the binary to a user-writable path or
  install/upgrade with the same privileges.
- POSIX chmod failed but write succeeded → the binary is on disk but
  not executable. Manually `chmod +x` and the next service restart
  will pick it up.

After a write_failed, the on-disk state may be:
- Old binary intact (write failed before any output) → next heartbeat
  retries cleanly.
- Empty / truncated binary (write failed mid-stream, rare) → the
  daemon process keeps its in-memory image; the next OS-level spawn
  will fail. Manual fix: re-download from GitHub Releases and place
  with `chmod +x`.

## Stage 3: success logged but old version still running

### POSIX

`exitProcess()` was called but the service manager didn't restart, OR
restarted the same old in-memory binary because the file replacement
hadn't been flushed yet.

Check:
```
proxai-gateway --version
ls -la $(which proxai-gateway)
```

If the mtime is recent but `--version` reports the old version, the
service manager respawned a copy that already had the file mapped.
Force a clean restart:
```
launchctl kickstart -k gui/$(id -u)/co.proxai.gateway   # macOS
systemctl --user restart proxai-gateway                  # Linux
```

If the mtime is old, the write went somewhere else. The
`binaryPath` passed to `runAutoUpgrade` is `process.execPath` at
daemon start; if the user is invoking via a wrapper script, the
wrapper's path is overwritten instead of the actual binary. Check
the install layout.

### Windows

The `.new` sibling sits at `<binaryPath>.new`. The service manager
must restart the task, AND the swap from `.new` to the real path
must happen before the task starts. Currently this swap is
**manual** — there is no in-repo logic to atomically rename
`.new` over `.exe` while the old `.exe` is locked.

Recovery: stop the scheduled task, swap the file, restart:
```
schtasks /End /TN proxai-gateway
Move-Item -Force "$binPath.new" "$binPath"
schtasks /Run /TN proxai-gateway
```

A user-friendly fix is on the roadmap (a swap-on-startup CLI bootstrap
step). For now, document this as a manual recovery.

## Stage 4: lock-file / partial-state

The gateway does not use a PID lock-file. Two daemons running
simultaneously is rare but possible if the service manager mis-fires.
Symptom: duplicate `capture.cycle.start` events with overlapping
timestamps in the structured log.

Fix: stop the service manager registration, kill all `proxai-gateway`
processes, restart cleanly.

```
ps -ef | grep proxai-gateway   # POSIX
Get-Process proxai-gateway     # Windows
```

## Stage 5: brew-specific path

If `installSource === 'brew'`, the gateway **never** replaces its own
binary. Instead, `runBrewSentinelCheck` writes `UPDATE_AVAILABLE` and
exits — the user must run `brew upgrade proxai-gateway`. If a brew
user is reporting "upgrade didn't happen", the `UPDATE_AVAILABLE`
sentinel is probably present:

```
ls -la ~/.proxai/proxai-gateway/UPDATE_AVAILABLE
proxai-gateway status   # shows update info
```

This is working as designed. Tell the user to run `brew upgrade`.

## Stage 6: stale-binary `PAUSED` after upgrade

If a binary is ≥ 60 days old, `checkStaleBinary` writes `PAUSED`. The
`PAUSED` sentinel is **not** auto-cleared by upgrade. The recovery
sequence is:

```
proxai-gateway upgrade     # downloads + restarts on new binary
proxai-gateway resume      # clears PAUSED
```

Without the second command, the daemon will start on the new binary
but immediately skip every cycle on `PAUSED`. This catches users who
assume "upgrade" is one operation.

For a full reset (e.g. recovering from corrupt buffer.db at the same
time):
```
proxai-gateway uninstall --reset
# ... reinstall from scratch ...
proxai-gateway setup
```

[source: src/services/upgrade/auto-upgrade.ts, src/services/upgrade/release-fetch.ts, src/services/polling/heartbeat-cycle.ts, src/services/polling/stale-binary.ts, ai/knowledge/release/auto-update-flow.md]
