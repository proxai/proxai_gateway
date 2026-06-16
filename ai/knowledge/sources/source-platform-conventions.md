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

## 2. Integration & Upload Contract Promotion (Implemented & Active)

The rollout strategy has transitioned to being fully implemented:

* **Top-Level Column**: The `source_platform` field has been promoted to a formal, first-class column in the database buffer schema (`upload_batches` table) and is a top-level property of the raw record upload DTO contract (`RawRecordDTO.source_platform`).
* **Runtime Resolution**: The gateway parser resolves the `source_platform` at runtime (using directory checks, session JSON exists checks, and platform mappings) and populates the field directly in the enqueued record batches and the REST upload payloads.

