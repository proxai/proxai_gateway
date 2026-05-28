# Source Platform Conventions & Evolution

This document records the design conventions and future architectural evolution for capturing and classifying different client interfaces (CLI vs. Desktop App / IDE) under a generalized field: **`source_platform`**.

---

## 1. Core Concept & Active Values

To allow the Nest backend to confidently distinguish the runtime environments of incoming AI sessions, the gateway collector resolves and assigns a `source_platform` identifier.

### Claude Source Mapping (`claude-desktop` and `claude-code` sources)
* **`claude-code-cli`**: Traditional CLI sessions run natively inside terminal shells.
* **`claude-code-desktop`**: Standard Claude Code "Code" tab sessions run inside the Claude Desktop GUI.
* **`claude-cowork-desktop`**: Sandboxed agent loop Cowork sessions run inside the Claude Desktop GUI.

### Multi-App Extensibility
This naming convention is structurally designed to scale to other upcoming source apps:
* **Codex**: `codex-cli` vs. `codex-ide`
* **Antigravity**: `antigravity-cli` vs. `antigravity-ide`

---

## 2. Integration & Upload Contract Transition Strategy

To allow swift deployment of platform tracking without breaking active database tables or upstream API integrations, a two-phase rollout strategy is established:

### Phase 1: Body Embedding (Active)
* **Rule**: The gateway parser resolves the `source_platform` at runtime (using directory checks and session JSON exists checks) and **injects it directly inside the enqueued record body object** (rather than the top-level database column / upload DTO envelope).
* **Rationale**: Prevents any breaking database schema migrations or REST endpoint payload failures on the active staging/production environments.

### Phase 2: Top-Level Promotion (Future Intention)
* **Goal**: Explicitly promote the `source_platform` field to a formal, first-class column in the database buffer schema and a top-level property of the raw record upload DTO contract.
* **Scope**: This migration will be coordinated globally across the `proxai_nest` backend analytics dashboards, raw upload ingestion endpoints, and `proxai_gateway` client daemons.
