[Top Index](../README.md) · [Next: 02 — Capture →](../02-capture/README.md)

# Foundations (01)

*Last Updated: 2026-06-16*

Foundations cover what proxai_gateway is at a high level, what it is built on, and how it ships per platform. Read this section before any other to anchor terminology — every later section assumes the mental model and source-tree layout established here.

## Docs in this section

1. [1.1 Overview](./1.1-overview.md) — the single-paragraph answer to what proxai_gateway is, the six subsystems, the three daemon cycles, the on-disk layout, and the identity model.
2. [1.2 Tech Stack](./1.2-tech-stack.md) — the Bun runtime, strict TypeScript, the small production dependency set, and the dev tooling chain.
3. [1.3 Cross-Platform Binaries](./1.3-cross-platform-binaries.md) — the six build targets, what `bun build --compile` does, and how each install vector picks the matching binary.

The pipeline-level breakdown begins in [Capture](../02-capture/README.md), which walks the data flow from agent session files into the local buffer.

[Top Index](../README.md) · [Next: 02 — Capture →](../02-capture/README.md)
