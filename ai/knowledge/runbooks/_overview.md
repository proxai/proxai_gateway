# Runbooks — Overview

Pointer table for every runbook in this directory. Pick the entry that
matches the user-visible symptom.

## Symptom → runbook

| Symptom | Runbook |
| ------- | ------- |
| Daemon running but nothing uploads; buffer grows | [daemon-not-uploading.md](./daemon-not-uploading.md) |
| `proxai-gateway status` shows a sentinel and nothing happens | [debug-stuck-daemon.md](./debug-stuck-daemon.md) |
| Buffer.db on disk grows past `buffer_soft_pause_bytes` | [buffer-grows-unbounded.md](./buffer-grows-unbounded.md) |
| User reports redactor obscured something legitimate | [redaction-false-positive.md](./redaction-false-positive.md) |
| `install.sh` / `install.ps1` fails or `setup` errors | [platform-specific-install-failure.md](./platform-specific-install-failure.md) |
| Auto-upgrade reported success but daemon won't start, or stuck on old version | [upgrade-failure.md](./upgrade-failure.md) |
| Coverage gate is red on CI | [fix-coverage-gap.md](./fix-coverage-gap.md) |

## Cross-cutting checks

Before reaching for a runbook, run these:

1. `proxai-gateway status` — sentinels, health, recent counters
2. `proxai-gateway tail --level warn --since 2h` — recent problems
3. `proxai-gateway inspect` — dry-run scan across all sources

If those three are clean and the user still reports breakage, you are
debugging upstream (server-side ingest, network, or backend BullMQ).
Hand off to the proxai_nest / proxai_ops runbooks at that point.

## Related rule files

- `ai/rules/services/daemon-loops.md` — what each loop will and will
  not do (e.g. drain never gates on `BUFFER_FULL`)
- `ai/rules/services/no-direct-sqlite-outside-buffer.md` — buffer
  access discipline
- `ai/rules/services/watermark-monotonic-only.md` — the regression
  handshake contract

[source: ai/knowledge/runbooks/*.md, src/services/polling/*.ts]
