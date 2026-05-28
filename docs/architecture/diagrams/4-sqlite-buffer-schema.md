[← Previous: 3. Ingestion Pipeline](./3-ingestion-pipeline.md) · [Index](./README.md) · [Next: Back to Main Index →](../../README.md)

# 4. SQLite Buffer Schema

*Last Updated: 2026-05-27*

This document serves as an advanced architectural cheatsheet describing the database schemas, table structures, relationships, and transactional boundaries inside the local `buffer.db` SQLite store.

## Relational Map & Database Layout

The flowchart below map the structural schema of the 7 tables of `buffer.db`, highlighting composite keys, column types, and the ACID transactional boundary that executes daily pruning routines.

```mermaid
%%{init: {"theme": "base", "themeCSS": "svg { background-color: #081612; border: 1px solid #142c26; border-radius: 8px; padding: 12px; } .flowchart-link, .marker { stroke: #10b981 !important; filter: drop-shadow(0px 0px 4px rgba(16, 185, 129, 0.8)) !important; } .edgePath .path { stroke: #10b981 !important; stroke-width: 2px !important; } .node rect, .node circle, .node polygon, .node path { stroke-width: 2px !important; } .node.startNode rect, .node.startNode circle, .node.startNode polygon, .node.startNode path { fill: #0a201b !important; stroke: #10b981 !important; filter: drop-shadow(0px 0px 6px rgba(16, 185, 129, 0.7)) !important; } .node.startNode .label { color: #b3f5e6 !important; } .node.stopNode rect, .node.stopNode circle, .node.stopNode polygon, .node.stopNode path { fill: #241212 !important; stroke: #ef4444 !important; filter: drop-shadow(0px 0px 6px rgba(239, 68, 68, 0.7)) !important; } .node.stopNode .label { color: #fca5a5 !important; } .node.decNode rect, .node.decNode circle, .node.decNode polygon, .node.decNode path { fill: #241c0e !important; stroke: #f59e0b !important; filter: drop-shadow(0px 0px 6px rgba(245, 158, 11, 0.7)) !important; } .node.decNode .label { color: #fde68a !important; } .node.processNode rect, .node.processNode circle, .node.processNode polygon, .node.processNode path { fill: #0d1b2d !important; stroke: #3b82f6 !important; filter: drop-shadow(0px 0px 6px rgba(59, 130, 246, 0.7)) !important; } .node.processNode .label { color: #bfdbfe !important; } .node.actionNode rect, .node.actionNode circle, .node.actionNode polygon, .node.actionNode path { fill: #1e112c !important; stroke: #a855f7 !important; filter: drop-shadow(0px 0px 6px rgba(168, 85, 247, 0.7)) !important; } .node.actionNode .label { color: #e9d5ff !important; } .node.default rect, .node.default circle, .node.default polygon, .node.default path { fill: #0a201b !important; stroke: #14b8a6 !important; filter: drop-shadow(0px 0px 6px rgba(20, 184, 166, 0.7)) !important; } .node.default .label { color: #ccfbf1 !important; }", "themeVariables": { "primaryColor": "#081612", "primaryTextColor": "#f1f5f9", "primaryBorderColor": "#142c26", "lineColor": "#10b981", "secondaryColor": "#081612", "tertiaryColor": "#081612", "fontFamily": "Inter, sans-serif" }, "flowchart": {"nodeSpacing": 35, "rankSpacing": 40}}}%%
flowchart TD
  classDef startNode fill:#0a201b,stroke:#10b981,stroke-width:2px,color:#b3f5e6,padding:10px 25px;
  classDef stopNode fill:#241212,stroke:#ef4444,stroke-width:2px,color:#fca5a5,padding:10px 25px;
  classDef decNode fill:#241c0e,stroke:#f59e0b,stroke-width:2px,color:#fde68a,padding:10px 20px;
  classDef processNode fill:#0d1b2d,stroke:#3b82f6,stroke-width:2px,color:#bfdbfe,padding:10px 20px;
  classDef actionNode fill:#1e112c,stroke:#a855f7,stroke-width:2px,color:#e9d5ff,padding:10px 20px;
  classDef default fill:#0a201b,stroke:#14b8a6,stroke-width:2px,color:#ccfbf1,padding:10px 20px;

  %% Database Tables & Core Schema Definitions
  batches["Table: upload_batches<br/>-----------------------------<br/>PK capture_id TEXT<br/>source_app TEXT<br/>source_kind TEXT<br/>source_path TEXT<br/>source_path_hash TEXT<br/>source_inode INT<br/>watermark_kind TEXT<br/>watermark_start INT<br/>watermark_end INT<br/>watermark_table TEXT<br/>agent_schema_version TEXT<br/>gateway_version TEXT<br/>captured_at_utc TEXT<br/>body_format TEXT<br/>body_compression TEXT<br/>body BLOB<br/>status TEXT DEFAULT pending<br/>attempts INT DEFAULT 0<br/>created_at TEXT<br/>last_error TEXT<br/>IDX status,created_at + source_path_hash"]

  cursors["Table: source_cursors<br/>-----------------------------<br/>COMPOSITE PK source_app,source_path_hash,source_inode,watermark_table<br/>source_path TEXT<br/>source_inode INT DEFAULT 0<br/>watermark_table TEXT DEFAULT ''<br/>watermark_end INT DEFAULT 0<br/>last_polled_at TEXT<br/>consecutive_errors INT DEFAULT 0<br/>last_seen_size_bytes INT<br/>last_seen_page_count INT"]

  receipts["Table: upload_receipts<br/>-----------------------------<br/>PK capture_id TEXT<br/>source_app TEXT<br/>source_path_hash TEXT<br/>watermark_kind TEXT<br/>watermark_start INT<br/>watermark_end INT<br/>watermark_table TEXT<br/>delivered_at TEXT<br/>idempotent_on_server INT DEFAULT 0<br/>user_prompt TEXT redacted<br/>user_prompt_added_at TEXT<br/>source_path TEXT<br/>agent_schema_version TEXT<br/>gateway_version TEXT<br/>captured_at_utc TEXT<br/>attempts INT<br/>source_inode INT<br/>shipped_bytes INT<br/>IDX source_path_hash + delivered_at"]

  quarantine["Table: quarantined_records<br/>-----------------------------<br/>PK id INT AUTOINCREMENT<br/>source_app TEXT<br/>source_path TEXT<br/>source_path_hash TEXT<br/>source_inode INT<br/>watermark_table TEXT<br/>watermark_position INT<br/>row_pk TEXT<br/>redacted_size_bytes INT<br/>reason TEXT<br/>quarantined_at_utc TEXT<br/>gateway_version TEXT<br/>IDX source_app + quarantined_at_utc"]

  resync["Table: resync_events<br/>-----------------------------<br/>PK id INT AUTOINCREMENT<br/>source_app TEXT<br/>source_path_hash TEXT<br/>watermark_kind TEXT<br/>server_watermark_end INT<br/>skipped_units INT<br/>recovered_at TEXT<br/>IDX recovered_at"]

  state["Table: daemon_state<br/>-----------------------------<br/>PK id INT CHECK id=1 single row<br/>last_cycle_started_at TEXT<br/>last_cycle_completed_at TEXT<br/>last_cycle_duration_ms INT<br/>last_drain_attempted INT<br/>last_drain_accepted INT<br/>last_drain_retriable INT<br/>last_drain_fatal INT<br/>last_drain_recovered INT<br/>last_upload_error TEXT<br/>last_consecutive_retriable_break INT<br/>last_source_captures TEXT JSON<br/>machine_snapshots TEXT"]

  metadata["Table: buffer_metadata<br/>-----------------------------<br/>PK key TEXT<br/>value TEXT<br/>holds last_prune_at + rolling stats"]

  %% Core Relationships & Flow Paths
  cursors -->|Watermarks tracked to produce| batches
  batches -->|On 200 OK insert receipt + delete batch| receipts
  batches -->|Oversized row metadata recorded to| quarantine
  batches -->|On watermark regression append| resync
  state -->|Cycle counters + drain results persisted to| metadata
  metadata -->|Holds last_prune_at consulted by| pruneTick

  %% Daily Pruning ACID Transaction Flow
  pruneTick([Prune Trigger]) --> pruneTx[db.transaction wrapper]

  pruneTx --> deleteReceipts["DELETE upload_receipts<br/>WHERE delivered_at < receipt cutoff 365d"]
  pruneTx --> deleteFailed["DELETE upload_batches<br/>WHERE status = failed<br/>AND created_at < failed cutoff 365d"]
  pruneTx --> deleteQuarantine["DELETE quarantined_records<br/>WHERE quarantined_at_utc < failed cutoff"]
  pruneTx --> deleteResync["DELETE resync_events<br/>WHERE recovered_at < receipt cutoff"]
  pruneTx --> setPruneAt["UPDATE buffer_metadata<br/>SET last_prune_at = now"]

  pruneTx -.->|Rollback on Error| pruneFail([Rollback transaction])

  deleteReceipts --> pruneEnd([Pruning Tx Success])
  deleteFailed --> pruneEnd
  deleteQuarantine --> pruneEnd
  deleteResync --> pruneEnd
  setPruneAt --> pruneEnd

  %% Direct Pruning Operations to Target Tables
  deleteReceipts -.->|Cleans up| receipts
  deleteFailed -.->|Cleans up failed only, pending kept| batches
  deleteQuarantine -.->|Cleans up| quarantine
  deleteResync -.->|Cleans up| resync
  setPruneAt -.->|Writes| metadata

  %% Explicit Class Mapping for All Nodes
  class pruneTick startNode;
  class pruneEnd startNode;
  class pruneFail stopNode;
  class batches processNode;
  class cursors processNode;
  class receipts processNode;
  class quarantine processNode;
  class resync processNode;
  class state processNode;
  class metadata processNode;
  class pruneTx processNode;
  class deleteReceipts actionNode;
  class deleteFailed actionNode;
  class deleteQuarantine actionNode;
  class deleteResync actionNode;
  class setPruneAt actionNode;
```

[← Previous: 3. Ingestion Pipeline](./3-ingestion-pipeline.md) · [Index](./README.md) · [Next: Back to Main Index →](../../README.md)
