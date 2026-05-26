[← Previous: 04 — Daemon Loops](../04-daemon-loops/README.md) · [Top Index](../README.md) · [Next: 06 — Operations →](../06-operations/README.md)

# Backend (05)

The contract with the ingest service — endpoints, payload shape, response classification, idempotency, Retry-After handling — and the identity model that ties a host to an account.

## Docs in this section

1. [5.1 Backend Protocol](./5.1-backend-protocol.md) — the four endpoints, the `RawRecordDTO` shape, status-code semantics, idempotency, and Retry-After handling.
2. [5.2 Identity, Auth & Privacy](./5.2-identity-auth-and-privacy.md) — `host_id` derivation, machine UUID per platform, what leaves the device.

The drain cycle that actually ships records over this wire lives in [Daemon Loops](../04-daemon-loops/4.2-drain-cycle.md). The on-device redaction pass that gates everything before it crosses the wire is in [Capture](../02-capture/2.4-redaction.md).

[← Previous: 04 — Daemon Loops](../04-daemon-loops/README.md) · [Top Index](../README.md) · [Next: 06 — Operations →](../06-operations/README.md)
