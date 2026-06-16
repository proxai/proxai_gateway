[← Previous: 01 — Foundations](../01-foundations/README.md) · [Top Index](../README.md) · [Next: 03 — Buffer →](../03-buffer/README.md)

# Capture (02)

*Last Updated: 2026-05-27*

How agent session data gets discovered, parsed, sliced, redacted, and packaged into batches that the buffer can hold. Each doc covers one stage of that pipeline; together they describe the entire pre-buffer code path that runs every capture cycle.

## Docs in this section

1. [2.1 Sources](./2.1-sources.md) — the five supported agents, where their session files live, and the shape of each on the wire.
   - Per-source deep-dives in [sources/](./sources/README.md) — captured-vs-skipped namespaces, record types, and product selections for each agent.
2. [2.2 Parsing & Watermarks](./2.2-parsing-and-watermarks.md) — the cursor row, byte-range vs. rowid-range advancement, VACUUM detection, and restart resumption.
3. [2.3 Batching & Compression](./2.3-batching-and-compression.md) — what a batch is, the 2 MB / 10 MB size caps, zstd level 3, oversize splitting, and per-batch metadata.
4. [2.4 Redaction](./2.4-redaction.md) — the rule pipeline, the preservation contract, and where redaction sits between parse and buffer.

The downstream destination of every produced batch is the SQLite [Buffer](../03-buffer/README.md). The loop that actually drives capture once per cycle is the [Capture Cycle](../04-daemon-loops/4.1-capture-cycle.md) inside Daemon Loops.

[← Previous: 01 — Foundations](../01-foundations/README.md) · [Top Index](../README.md) · [Next: 03 — Buffer →](../03-buffer/README.md)
