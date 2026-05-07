# Planning Docs Index

Last synced to code state: 2026-05-06.

This directory holds gateway design and algorithm docs. Some are still authoritative; others captured an earlier design and have been deprecated in place (with a header pointing at the current source of truth) rather than deleted, so the archaeological trail stays intact.

For the day-to-day current state of the gateway, the primary references are:

- The project `README.md` — install, lifecycle, command surface, troubleshooting.
- `08_BACKEND_CONTRACT.md` (repo root) — wire contract with `proxai_nest` (authoritative).
- `src/` — implementation.

## Index

| File | Status | Notes |
|---|---|---|
| `nest-contract.md` | **MOVED** | Superseded by [`08_BACKEND_CONTRACT.md`](../08_BACKEND_CONTRACT.md) at the repo root. The file here is a one-screen pointer; all content (three endpoints, structured `watermark_regression` 400 body, stable `host_id` derivation, hysteresis sentinels) has been merged into the new doc. |
| `audit_crash_recovery.md` | **CURRENT** | Audit report; snapshot in time (2026-05-06). Documents the deliberate "advance cursor on capture-into-buffer, not on server-accept" design and its crash semantics. No edits. |
| `audit_graceful_shutdown.md` | **CURRENT** | Audit report; snapshot in time (2026-05-06). Documents the SIGTERM / SIGINT propagation pattern (signal stops the loop at cycle boundaries, never mid-upload). No edits. |
| `04_AGENT_CALL_RECORD.md` | **CURRENT (REVIEWED)** | Backend `AgentCallRecord` schema spec. Gateway ships raw bytes per `08_BACKEND_CONTRACT.md`; this doc remains the right reference for backend parsers. Header-only review note added. |
| `05_AGENT_CALL_RECORD_MAPPING.md` | **CURRENT (REVIEWED)** | Backend parser recipe (raw bytes → `AgentCallRecord`). Gateway DTO field references match the wire contract. Header-only review note added. |
| `CAPTURE_TARGETS.md` | **UPDATED** | Per-agent capture target paths. Updated to reflect Codex's three in-scope tables (`threads`, `thread_dynamic_tools`, `thread_spawn_edges`) instead of `threads` only, and the highest-numbered `state_*.sqlite` selection rule. |
| `ALGORITHM_CLAUDE.md` | **CURRENT (UPDATED HEADER)** | Backend-parser algorithm + gateway-side flushing for Claude Code. Algorithm shape unchanged; header note added on `capture_id` UUIDv7 and the cursor-advance audit. |
| `ALGORITHM_CURSOR.md` | **CURRENT (UPDATED HEADER)** | Same shape for Cursor. Header note added on the `#gen=N` source_path rotation that handles vacuum-induced rowid regression. |
| `ALGORITHM_CODEX.md` | **CURRENT (UPDATED HEADER)** | Same shape for Codex. Header note added on the three in-scope tables (was one) and the `#gen=N` rotation. |
| `01_INTRO.md` | **DEPRECATED** | Pre-MVP overall design. Header points to current `README.md` and lists drift items: license (MIT, not Apache 2.0), command surface, single-pass redaction, stable `host_id`, hysteresis buffer cap, cross-platform on day one, log rotation, initial-scan window cap, stale-binary thresholds. |
| `02_CLI_DESIGN.md` | **DEPRECATED** | Pre-rename CLI surface (`install`, `uninstall`, `doctor`, `--accept-warnings`). Header points to `README.md` and `src/cli/commands/`. Current surface: `setup`, `start`, `stop`, `restart`, `backfill`, `pause`, `resume`, `status`, `tail`, `redaction list/test`. |
| `03_FLUSHING_ALGORITHM.md` | **DEPRECATED** | High-level algorithm still right, specifics drifted. Header lists the diffs (auth header, redaction passes, `capture_id` scheme, host_id formula, buffer-full sentinel, `#gen=N` rotation, no `blob_snapshot`, no shipped `mtime` watermark, capture-into-buffer cursor advance). Authoritative wire contract is `08_BACKEND_CONTRACT.md`. |
| `06_USER_EXPERIENCE.md` | **DEPRECATED** | Pre-MVP UX sketch (already self-flagged as tentative). Header points to `README.md` and `src/cli/`. The §1 tone & voice and §8 style notes survived; the literal screen copy and command names did not. |
| `07_MACOS_MVP.md` | **DEPRECATED** | Framed gateway as macOS-first MVP. Linux + Windows ship from day one (systemd user unit / per-user scheduled task). Header points to `README.md` and the per-platform unit modules. The macOS gotchas table and the build/ship strategy survived. |
| `web_plugin/` | Out of scope here | Browser-extension product track (separate from desktop gateway). Not audited as part of this sweep. |

## How to use this directory

- If you're looking for the current state of any feature, start with `README.md` (project root) and `src/`. The wire contract is `08_BACKEND_CONTRACT.md` at the repo root.
- The `audit_*.md` files are point-in-time audit reports; treat them as a snapshot of the audit findings, not as live design docs.
- The `ALGORITHM_*.md` files describe per-source capture mechanics in depth and are still useful — gateway-side specifics that have changed are flagged in their headers.
- The numbered `0N_*.md` files capture the original design narrative. They've been deprecated in place because they have archaeological value (why the system was shaped this way) but should not be used as the spec for current behavior.
