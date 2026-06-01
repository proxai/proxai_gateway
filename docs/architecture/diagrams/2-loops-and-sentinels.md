[← Previous: 1. Daemon Lifecycle](./1-daemon-lifecycle-and-service.md) · [Index](./README.md) · [Next: 3. Ingestion Pipeline →](./3-ingestion-pipeline.md)

# 2. Loops & Sentinels

*Last Updated: 2026-05-27*

This document serves as an advanced architectural cheatsheet describing the execution path of the three concurrent daemon cycles (Capture, Drain, Heartbeat) and how they coordinate state using filesystem sentinel flags instead of in-memory IPC.

## Sentinel Inventory

Each profile owns its own sentinel set under `<root>/<profile>/`. There are **5 per-profile sentinels**:

- `AUTH_FAILED` — written by the drain upload path on a confirmed invalid key; cleared only by `setup new`. Gates capture and drain.
- `BUFFER_FULL` — written by capture when pending bytes exceed the soft-pause threshold; cleared by drain once pressure drops below soft-resume. Gates capture only (never drain).
- `SESSION_STOPPED` — boot-id self-clearing; read once at daemon boot to exit cleanly. Not gated inside the per-cycle loops.
- `CONSENT_ACCEPTED` — informational only; never gates any cycle.
- `UPDATE_AVAILABLE` — written by the brew heartbeat branch when a newer release exists; surfaced to the user, does not gate.

Separately, a single **root-level boot-scoped `DEV_MODE` flag** lives at `<root>/DEV_MODE` (not per-profile). It is boot-id self-clearing and unlocks the hidden `dev` profile, the `dev`/`xstate` commands, and the dev-default profile for `setup`/`logs`/`doctor`.

## Loop Coordination & Sentinel Gates

The flowchart below map how the three concurrent cycles run in parallel, and how their execution is gated by the presence of small filesystem sentinels.

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 35, "rankSpacing": 40}, "theme": "base", "themeCSS": "svg { background-color: #081612; border: 1px solid #142c26; border-radius: 8px; padding: 12px; } .flowchart-link, .marker { stroke: #10b981 !important; filter: drop-shadow(0px 0px 4px rgba(16, 185, 129, 0.8)) !important; } .edgePath .path { stroke: #10b981 !important; stroke-width: 2px !important; } .node rect, .node circle, .node polygon, .node path { stroke-width: 2px !important; } .node.startNode rect, .node.startNode circle, .node.startNode polygon, .node.startNode path { fill: #0a201b !important; stroke: #10b981 !important; filter: drop-shadow(0px 0px 6px rgba(16, 185, 129, 0.7)) !important; } .node.startNode .label { color: #b3f5e6 !important; } .node.stopNode rect, .node.stopNode circle, .node.stopNode polygon, .node.stopNode path { fill: #241212 !important; stroke: #ef4444 !important; filter: drop-shadow(0px 0px 6px rgba(239, 68, 68, 0.7)) !important; } .node.stopNode .label { color: #fca5a5 !important; } .node.decNode rect, .node.decNode circle, .node.decNode polygon, .node.decNode path { fill: #241c0e !important; stroke: #f59e0b !important; filter: drop-shadow(0px 0px 6px rgba(245, 158, 11, 0.7)) !important; } .node.decNode .label { color: #fde68a !important; } .node.processNode rect, .node.processNode circle, .node.processNode polygon, .node.processNode path { fill: #0d1b2d !important; stroke: #3b82f6 !important; filter: drop-shadow(0px 0px 6px rgba(59, 130, 246, 0.7)) !important; } .node.processNode .label { color: #bfdbfe !important; } .node.actionNode rect, .node.actionNode circle, .node.actionNode polygon, .node.actionNode path { fill: #1e112c !important; stroke: #a855f7 !important; filter: drop-shadow(0px 0px 6px rgba(168, 85, 247, 0.7)) !important; } .node.actionNode .label { color: #e9d5ff !important; } .node.default rect, .node.default circle, .node.default polygon, .node.default path { fill: #0a201b !important; stroke: #14b8a6 !important; filter: drop-shadow(0px 0px 6px rgba(20, 184, 166, 0.7)) !important; } .node.default .label { color: #ccfbf1 !important; }", "themeVariables": { "primaryColor": "#081612", "primaryTextColor": "#f1f5f9", "primaryBorderColor": "#142c26", "lineColor": "#10b981", "secondaryColor": "#081612", "tertiaryColor": "#081612", "fontFamily": "Inter, sans-serif" }}}%%
flowchart TD
  classDef startNode fill:#0a201b,stroke:#10b981,stroke-width:2px,color:#b3f5e6,padding:10px 25px;
  classDef stopNode fill:#241212,stroke:#ef4444,stroke-width:2px,color:#fca5a5,padding:10px 25px;
  classDef decNode fill:#241c0e,stroke:#f59e0b,stroke-width:2px,color:#fde68a,padding:10px 20px;
  classDef processNode fill:#0d1b2d,stroke:#3b82f6,stroke-width:2px,color:#bfdbfe,padding:10px 20px;
  classDef actionNode fill:#1e112c,stroke:#a855f7,stroke-width:2px,color:#e9d5ff,padding:10px 20px;
  classDef default fill:#0a201b,stroke:#14b8a6,stroke-width:2px,color:#ccfbf1,padding:10px 20px;

  bootGate{"SESSION_STOPPED at boot?"} -->|Present matching boot_id| bootExit(["Exit cleanly code 0"])
  bootGate -->|Absent / stale| loopBoot(["runDaemonLoops Promise.all"])
  loopBoot --> capTick([Capture Cycle Tick])
  loopBoot --> drainTick([Drain Cycle Tick])
  loopBoot --> hbTick([Heartbeat Cycle Tick])

  capTick --> capGates{Capture Gate Check}
  capGates -->|AUTH_FAILED present| capHalt([Skip Cycle])
  capGates -->|BUFFER_FULL present| capHalt
  capGates -->|Clear| poll[Poll background Workers<br/>concurrently]
  poll --> pressureCheck{Pending bytes > soft-pause?}
  pressureCheck -->|Yes| writeFull[Write BUFFER_FULL sentinel]
  pressureCheck -->|No| capEnd([Success])
  writeFull --> capEnd

  drainTick --> drainGates{Drain Gate Check}
  drainGates -->|AUTH_FAILED present| drainHalt([Skip Cycle])
  drainGates -->|Clear| pullBatches[Pull up to 256 oldest pending<br/>from buffer.db]
  pullBatches --> upload[Upload batches sequentially<br/>apply pacing backoffs]
  upload --> prune[ACID prune: receipts + resync 365d<br/>failed + quarantined on failed cutoff]
  prune --> resumeCheck{Pending bytes < soft-resume?}
  resumeCheck -->|Yes| clearFull[Delete BUFFER_FULL sentinel]
  resumeCheck -->|No| drainEnd([Success])
  clearFull --> drainEnd

  hbTick --> checkStale{Installed past warn / pause days?}
  checkStale -->|Yes| warnStale[Log stale warning]
  checkStale -->|No| checkUpgrade{Upgrade Check Rate-Limited?}
  warnStale --> checkUpgrade
  checkUpgrade -->|"Yes (within 4 h)"| hbEnd([Success])
  checkUpgrade -->|"No (4 h limit elapsed)"| queryRelease[Query GitHub releases]
  queryRelease --> hasNew{New version available?}
  hasNew -->|No| hbEnd
  hasNew -->|Yes| brewCheck{install_source == brew?}
  brewCheck -->|Yes| writeUpdate[Write UPDATE_AVAILABLE sentinel]
  brewCheck -->|"No (prod)"| coordUp[coordinatedUpgrade<br/>stop dev + replace + exitProcess 75]
  coordUp --> serviceRestart([Service manager respawns prod<br/>then restarts dev])
  writeUpdate --> hbEnd

  capHalt --> cycleWait([Next Scheduled Interval])
  capEnd --> cycleWait
  drainHalt --> cycleWait
  drainEnd --> cycleWait
  hbEnd --> cycleWait
  serviceRestart --> bootGate

  class bootGate decNode;
  class bootExit stopNode;
  class loopBoot startNode;
  class capTick startNode;
  class drainTick startNode;
  class hbTick startNode;
  class capHalt stopNode;
  class drainHalt stopNode;
  class hbEnd stopNode;
  class capEnd stopNode;
  class drainEnd stopNode;
  class serviceRestart stopNode;
  class cycleWait stopNode;
  class capGates decNode;
  class pressureCheck decNode;
  class drainGates decNode;
  class resumeCheck decNode;
  class checkStale decNode;
  class checkUpgrade decNode;
  class hasNew decNode;
  class brewCheck decNode;
  class poll processNode;
  class pullBatches processNode;
  class upload processNode;
  class prune processNode;
  class warnStale processNode;
  class queryRelease processNode;
  class writeFull actionNode;
  class clearFull actionNode;
  class writeUpdate actionNode;
  class coordUp actionNode;
```

[← Previous: 1. Daemon Lifecycle](./1-daemon-lifecycle-and-service.md) · [Index](./README.md) · [Next: 3. Ingestion Pipeline →](./3-ingestion-pipeline.md)
