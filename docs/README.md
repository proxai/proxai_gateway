# ProxAI Gateway — Internal Documentation

*Last Updated: 2026-05-27*

These are the internal, FAQ-shaped docs for `proxai_gateway`. The source repository intentionally hosts no docs of its own; everything lives here. Reading order is linear from section 01 to section 07 — each section builds on the previous one, and every numbered doc inside a section carries top-of-file and bottom-of-file navigation rows that chain the docs together.

## Sections

1. [01 — Foundations](./01-foundations/README.md) — what proxai_gateway is, the tech stack, and the cross-platform binary exports.
2. [02 — Capture](./02-capture/README.md) — how data flows from agent session files into the local buffer.
3. [03 — Buffer](./03-buffer/README.md) — the SQLite store, its tables, and the pressure / pruning policy.
4. [04 — Daemon Loops](./04-daemon-loops/README.md) — the three cycles (capture, drain, heartbeat) and the sentinels that gate them.
5. [05 — Backend](./05-backend/README.md) — the wire contract with the ingest service and the identity / privacy boundary.
6. [06 — Operations](./06-operations/README.md) — running, configuring, and observing the daemon.
7. [07 — Platform & Deployment](./07-platform-and-deployment/README.md) — cross-platform differences, install/upgrade/uninstall, build, and CI/CD.

## Conventions

- Each numbered doc starts and ends with a navigation row linking to the previous doc, the top-level index, and the next doc. The chain runs end-to-end across section boundaries.
- Code references use file paths relative to the gateway source repo at `proxai_gateway/`.
- Concrete numbers, intervals, and limits are pulled from `*.constants.ts` files; those are the source of truth. When the source repo's README and the constants disagree on a number, the constants win.
- Each H2 in a numbered doc is a question. The body answers it. Foundational, not exhaustive — these docs cover "what does this subsystem do, how does it interact with neighbours, what are the limits?". For everything else, read the code.
