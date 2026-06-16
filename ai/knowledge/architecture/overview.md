# proxai_gateway — Architecture

- Bun-native gateway runs as daemon-mode background service uploading buffer batches.
- Reads from local SQLite (bun:sqlite) for receipts and failed batches.
- Buffer prune defaults: receipts and failed batches retained 365 days. Soft-pause at 50 GiB, resume at 45 GiB. (Note: source memory claimed 700 MB / 600 MB — repaired against `src/services/config/config.constants.ts` reality.)
- Daemon hardening: binary warns at 30 days stale, pauses at 60 days; auth failures trigger verifyKey() and write AUTH_FAILED; native OS supervisors (launchd, systemd, Windows Task Scheduler) are hardened to restart the daemon on any exit (including clean exit 0); a periodic OS-scheduled watchdog runs every 15 minutes to execute a hidden 'rescue' command that heals hung or crashed daemon instances subject to rate caps (1 attempt per hour) and circuit breakers (stops after 3 consecutive rescue failures).
- Internal docs live at `proxai/docs/proxai-gateway/`; this repo is strictly code.
- Coverage mismatch: bulk audit misses tests under `src/agent-gateway/parsers/<agent>/tests/`; use per-file `validate`.
