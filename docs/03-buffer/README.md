[← Previous: 02 — Capture](../02-capture/README.md) · [Top Index](../README.md) · [Next: 04 — Daemon Loops →](../04-daemon-loops/README.md)

# Buffer (03)

The single SQLite file that holds everything the daemon needs to survive a restart — pending batches, per-file cursors, receipts, daemon metadata, the latest drain snapshot, and the quarantined-record ledger. Two docs: what is in it, and how its size is bounded.

## Docs in this section

1. [3.1 Buffer](./3.1-buffer.md) — the SQLite tables, what each one stores, and the cumulative metadata keys.
2. [3.2 Buffer Pressure & Pruning](./3.2-buffer-pressure-and-pruning.md) — the 30-day retention windows, the 700 / 600 MB soft-pause hysteresis, when pruning runs, and how `BUFFER_FULL` is set and cleared.

The buffer is written by the [Capture Cycle](../04-daemon-loops/4.1-capture-cycle.md) and read by the [Drain Cycle](../04-daemon-loops/4.2-drain-cycle.md). Both are part of [Daemon Loops](../04-daemon-loops/README.md).

[← Previous: 02 — Capture](../02-capture/README.md) · [Top Index](../README.md) · [Next: 04 — Daemon Loops →](../04-daemon-loops/README.md)
