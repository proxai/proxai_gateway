# ProxAI Gateway — documentation index

System-level documentation for engineers and operators of the ProxAI Gateway.
For end-user installation and CLI quick reference, see the project root
[`README.md`](../README.md).

## Contents

- [`SYSTEM_DESIGN.md`](./SYSTEM_DESIGN.md) — full architecture: components,
  capture pipeline, idempotency model, host_id derivation and reinstall
  recovery, lifecycle states, failure modes, and a single-byte trace through
  the system.
- [`CONFIG_REFERENCE.md`](./CONFIG_REFERENCE.md) — every field in
  `~/.proxai/config.toml`, with type, default, valid range, and runtime
  semantic. Also documents environment overrides.
- [`OPERATOR_RUNBOOK.md`](./OPERATOR_RUNBOOK.md) — diagnosis and remediation
  for common scenarios: `AUTH_FAILED`, `BUFFER_FULL`, suspected secret leaks,
  history backfill, single-batch debugging, buffer reset.

## Where to start

- New to the gateway: read `SYSTEM_DESIGN.md` end to end.
- Tuning a deployment: read `CONFIG_REFERENCE.md`.
- Debugging a live install: jump straight to `OPERATOR_RUNBOOK.md`, then
  cross-reference `SYSTEM_DESIGN.md` for the underlying mechanism.

## Related design documents

These live in [`planning/`](../planning) and capture decisions and contracts
that the system docs reference but do not replicate:

- [`nest-contract.md`](../planning/nest-contract.md) — wire contract with
  the `proxai_nest` backend.
- [`audit_crash_recovery.md`](../planning/audit_crash_recovery.md) — rationale
  for advancing the cursor on `insertBatch` rather than on server-accept.
- [`audit_graceful_shutdown.md`](../planning/audit_graceful_shutdown.md) —
  abort-signal flow and shutdown latency bounds.
- [`ALGORITHM_CLAUDE.md`](../planning/ALGORITHM_CLAUDE.md),
  [`ALGORITHM_CURSOR.md`](../planning/ALGORITHM_CURSOR.md),
  [`ALGORITHM_CODEX.md`](../planning/ALGORITHM_CODEX.md) — per-source
  collector specifications.
