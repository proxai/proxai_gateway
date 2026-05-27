[← Previous: 03 — Buffer](../03-buffer/README.md) · [Top Index](../README.md) · [Next: 05 — Backend →](../05-backend/README.md)

# Daemon Loops (04)

*Last Updated: 2026-05-27*

The three concurrent loops that drive the daemon — capture, drain, heartbeat — plus the sentinels that gate them. They run under one process via `Promise.all` and never share memory; coordination happens through SQLite rows and on-disk sentinel files.

## Docs in this section

1. [4.1 Capture Cycle](./4.1-capture-cycle.md) — 2-minute default, sentinel gates, per-source order, error tracking.
2. [4.2 Drain Cycle](./4.2-drain-cycle.md) — 30-second default, 256-batch cap, three-consecutive-retriable break, pacer mechanics, backoff math.
3. [4.3 Heartbeat Cycle](./4.3-heartbeat-cycle.md) — 1-hour default, GitHub release check, stale-binary policy, brew vs. in-place upgrade branches.
4. [4.4 Sentinels](./4.4-sentinels.md) — the six filesystem flags, what triggers each, what clears each, how they are surfaced.

The drain cycle's wire-level conversation with the ingest service is documented in [Backend](../05-backend/README.md).

[← Previous: 03 — Buffer](../03-buffer/README.md) · [Top Index](../README.md) · [Next: 05 — Backend →](../05-backend/README.md)
