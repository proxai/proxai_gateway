# Architecture Diagrams & Cheatsheets

This folder contains the complete visual system specification of the ProxAI Gateway daemon, organized into high-level logical flows and detailed state machine designs.

## Gateway Core Cheatsheets
These vertical Top-Down flowcharts capture the flat pipelines, lifecycles, and database interactions:

- [1. Daemon Lifecycle & Service Unit](./1-daemon-lifecycle-and-service.md) — Setup, install/uninstall pathways, and platform-specific systemd/launchd manager lifecycle phases.
- [2. Loops & Sentinels](./2-loops-and-sentinels.md) — Concurrent background loop schedules (Capture, Drain, Heartbeat) and the multi-layered Sentinel deduplication stack.
- [3. Ingestion Pipeline](./3-ingestion-pipeline.md) — End-to-end data validation, redaction filters, database buffering, and uploader shipping retry loop pacing.
- [4. SQLite Buffer Schema](./4-sqlite-buffer-schema.md) — Local storage relational schema mapping batch transactions, shipping acks, and automatic daily table pruning constraints.
- [5. Full Architecture (Combined Map)](./5-full-architecture.md) — Single unified master flowchart connecting all subsystems, loops, and databases for full-stack reference.

## Technical Behavior Specifications (XState)
For exact transition behavior, trigger signatures, and event specifications under the hood, refer to the state machine diagrams:

- [XState Diagram Index](./xstate/README.md) — Navigable index cataloging all 16 background micro-agents (Daemon Root, Sentinel Registry, Pacer, Workers, etc.).
