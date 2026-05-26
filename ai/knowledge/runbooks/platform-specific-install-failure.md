# Runbook: Platform-Specific Install Failure

Symptom: `install.sh` (POSIX) or `install.ps1` (Windows) succeeds, but
`proxai-gateway setup` errors, OR the daemon won't auto-start under the
service manager. Each OS has its own failure modes.

The install scripts only fetch and place the binary; the service
registration happens in `setup`. Most install-time pain is in `setup`.

## macOS (launchd)

### Permission denial writing the plist

`setup` writes `~/Library/LaunchAgents/co.proxai.gateway.plist`. If the
user's home directory has unusual permissions (e.g. SIP-managed user,
MDM-locked profile), the write fails with `EACCES`.

Check:
```
ls -la ~/Library/LaunchAgents/
```

If that directory doesn't exist or isn't writable, the user is in an
unsupported configuration. Fix: have the user create the directory
(`mkdir -p ~/Library/LaunchAgents`) and re-run setup.

### `launchctl bootstrap` fails

After writing the plist, `setup` runs `launchctl bootstrap
gui/<uid> <plist>`. Common failures:
- "Bootstrap failed: 5: Input/output error" — usually a stale
  registration from a previous install. Run `launchctl bootout
  gui/<uid>/co.proxai.gateway` first.
- "Service is disabled" — `launchctl disable` was run previously. Fix
  with `launchctl enable gui/<uid>/co.proxai.gateway`.

### Gatekeeper / quarantine

The binary is unsigned. First launch may be blocked. The fix is:
```
xattr -d com.apple.quarantine /usr/local/bin/proxai-gateway
```

The install script does this automatically; manual installations from
GitHub Releases do not.

## Linux (systemd user unit)

### Unit file conflict

`setup` writes `~/.config/systemd/user/proxai-gateway.service`. If a
previous install left a stale unit, `systemctl --user daemon-reload`
may report parse errors. Fix:
```
systemctl --user stop proxai-gateway || true
systemctl --user disable proxai-gateway || true
rm ~/.config/systemd/user/proxai-gateway.service
systemctl --user daemon-reload
```
Then re-run `setup`.

### No systemd at all (musl-only / Alpine / WSL1)

`setup` detects systemd via the presence of `systemctl`. On hosts
without systemd (Alpine without OpenRC bridge, WSL1, some container
runtimes), `setup` errors out. The daemon can still be run as a
foreground process with `proxai-gateway run`. There is no canned
solution for installing as a service on these hosts.

### `loginctl enable-linger`

The user-mode systemd unit runs only when the user is logged in,
unless `loginctl enable-linger <user>` was run. For headless servers
where the user is rarely logged in interactively, the daemon will
silently stop. `setup` does NOT enable linger automatically — that
requires sudo and is an explicit user choice. Document in the
post-install message.

## Windows (scheduled task)

### Privilege issue

`schtasks /Create` requires elevation if the task runs at startup or
under a different user. `setup` runs as the current user; tasks under
the current user with `/SC ONLOGON` do not need admin. If the user
ran `setup` from an elevated PowerShell, the resulting task is
admin-owned and won't be visible to a non-elevated `status` query.

Check task ownership:
```
schtasks /Query /TN proxai-gateway /V /FO LIST
```

If the user shown isn't the current user, run `setup --force` from
the matching context.

### `USERDOMAIN` / `USERNAME` not resolvable

`resolveWindowsUserId(env)` in `cli/wiring/platform.ts:15-23` combines
`$env:USERDOMAIN` and `$env:USERNAME` into `DOMAIN\user`. In some
unusual setups (containerized Windows, Azure Files-only profiles)
these env vars are absent or empty. `setup` falls back to just
`USERNAME`, but if both are absent, task creation fails.

Workaround: invoke setup with the env vars explicitly:
```
$env:USERDOMAIN = (hostname); $env:USERNAME = (whoami); proxai-gateway setup --force
```

### XML encoding

The scheduled-task XML must be UTF-16 LE with BOM (per `schtasks
/Create /XML` requirement). `encodeScheduledTaskXml` (referenced in
`ai/rules/modules/cross-platform.md`) handles this. If a user wrote a
custom XML and is trying to import it, they must match the encoding —
plain UTF-8 fails silently.

### `.exe` lock during upgrade

A running `proxai-gateway.exe` cannot be overwritten. The auto-upgrade
path (`replaceBinary` in `release-fetch.ts:99-112`) writes to
`<path>.new` on Windows. The service manager (Task Scheduler) must
restart the task to pick up the new binary. If a manual upgrade was
attempted with `Bun.write(binaryPath, ...)` directly, the install will
appear to succeed but the daemon will keep running the old code.

See `ai/knowledge/runbooks/upgrade-failure.md` for the recovery.

## Cross-cutting

### Re-run with `setup --force`

The `--force` flag tears down and recreates the service registration
end-to-end. It is the canonical "I don't know what went wrong" reset
for install state.

### Look at the install log

`install.sh` and `install.ps1` print verbose output to stdout. If the
user ran via curl-pipe-bash, suggest re-running with output saved:
```
curl -fsSL https://proxai.co/install.sh | bash 2>&1 | tee install.log
```

### Verify the binary is on PATH and executable

```
which proxai-gateway        # POSIX
where.exe proxai-gateway    # Windows
proxai-gateway --version
```

If the binary is present but `--version` fails, the binary is corrupt
or for the wrong arch. Re-download from GitHub Releases.

[source: src/cli/wiring/platform.ts, src/cli/service-manager/, src/cli/service-unit/, install.sh, install.ps1]
