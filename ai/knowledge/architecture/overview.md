# proxai_gateway — Architecture

- Bun-native gateway runs as daemon-mode background service uploading buffer batches.
- Reads from local SQLite (bun:sqlite) for receipts and failed batches.
- Buffer prune defaults: receipts and failed batches retained 30 days. Soft-pause at 50 GiB, resume at 45 GiB. (Note: source memory claimed 700 MB / 600 MB — repaired against `src/services/config/config.constants.ts` reality.)
- Daemon hardening: binary warns at 30 days stale, pauses at 60 days; auth failures trigger `verifyKey()` and write `AUTH_FAILED` sentinel on failure.
- Internal docs live at `proxai/docs/proxai-gateway/`; this repo is strictly code.
- Coverage mismatch: bulk audit misses tests under `src/agent-gateway/parsers/<agent>/tests/`; use per-file `validate`.
