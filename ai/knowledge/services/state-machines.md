# State Machines

The gateway's orchestration layer is modeled as 16 xstate v5 machines living
under `src/services/state-machines/`. Each machine is its own folder with
strict modularization: `<name>.machine.ts`, `<name>.types.ts`, optional
`<name>.constants.ts` / `<name>.utils.ts`, `index.ts` barrel, `tests/`.

## Machine inventory

| Name | Scope | Notes |
| --- | --- | --- |
| `daemon-root` | Daemon process lifecycle | `boot.{loading_config,opening_buffer,sync_decision,ready} → running → draining_for_shutdown → exited`. |
| `sentinel-registry` | Cross-process bus mirror | Parallel regions: `auth`, `bufferPressure`, `session`, `brewUpdate`. Fed by `sentinel-watcher`. |
| `capture-loop` | Per-tick capture orchestration | `waiting → evaluating_gate → running_cycle → committing → checking_pressure → persisting_metrics → waiting`. |
| `drain-loop` | Per-tick drain orchestration | `waiting → evaluating_gate → draining → pruning → checking_resume → persisting_metrics → waiting`. |
| `heartbeat-loop` | Per-tick heartbeat orchestration | `waiting → evaluating_gate → checking_freshness → throttle_check → version_check_branch → persisting_metrics → waiting`. |
| `binary-freshness` | Staleness ladder | `unchecked → checking → {fresh, warning, stale}`. Stale is informational; auto-upgrade replaces the binary on the next heartbeat. |
| `auto-upgrade` | Upgrade flow | brew vs non-brew fork. Terminal states for each. |
| `source-poll` | Per-source poll cycle | `idle → discovering → processing → emitting_results → {done, errored}`. |
| `cursor-lifecycle` | Per-cursor state | `unseeded → healthy ↔ {vacuumed, regressed}`. |
| `batch-lifecycle` | Per-batch state | `pending → uploading → {delivered, recovered, retriable_pending, failed.*}`. |
| `quarantine-lifecycle` | Per-quarantined-record state | `quarantined → pruned`. |
| `pacer` | Throttle flow observer | `ready → throttling.{retry_after, 429, 5xx, token_bucket, debiting} → ready`. |
| `worker` | Bun Worker lifecycle | `spawned → running → {posting_result, errored} → terminated`. |
| `service-manager` | CLI-side OS service control | `not_installed → installing → installed ↔ {starting, running, stopping, stopped} → uninstalling → uninstalled`. |
| `setup` | First-run wizard | `prompting_consent → collecting_ingestion_key → verifying_key → writing_config → writing_consent_sentinel → done`. |
| `uninstall` | Cleanup flow | `idle → stopping_service → sweeping_paths → removing_buffer → removing_sentinels → done`. |

## Supporting modules

- `sentinel-watcher` — `fs.watch` on `configDir()`, debounce 50 ms, translates
  filesystem events to `sentinel-registry` events.
- `snapshot` — persists `Partial<Record<MachineName, MachineSnapshot>>` to
  `daemon_state.machine_snapshots` (TEXT column, additive ALTER).
- `event-router` — subscribes to every machine, emits unified
  `state_machine.transition` log lines through the existing pino logger.

## Why this layering

- The bottom layer (`buffer.db` + sentinel files) stays as the durable,
  cross-process truth.
- The middle layer (`sentinel-watcher` + cycle tickers) translates external
  state into typed events.
- The top layer (xstate machines) consumes the events and exposes a snapshot
  per machine for both runtime use and visualization.

Machines never write to `buffer.db` directly. They consult the buffer API
(`services/buffer`) for reads and writes. Sentinel writes still go through
`sentinelHandle(...)` for atomicity. The architectural rule
`no-direct-sqlite-outside-buffer` is unchanged.

## xstate v5 conventions used

- `setup({ types, actors, guards, actions }).createMachine({ ... })` for type
  inference and visualization tool support.
- Per-machine `input` type for dependency injection (sentinel paths, db
  handle).
- `assign(...)` actions for context updates.
- `fromPromise(...)` actors for async side effects (writing sentinel files,
  HTTP calls).
- Inline guards on `onDone` transitions to narrow event types.

## Diagram export

`bun run diagrams:export` walks every machine's config and emits Mermaid
`stateDiagram-v2` files to `docs/architecture/diagrams/`. The
xstate-vscode extension picks the machines up directly from the source
files (the canonical visualization).

## Replay tool

`proxai-gateway replay <log.jsonl>` reads a JSONL log of
`state_machine.transition` events (emitted by `event-router`) and prints the
final state of each machine. Used for incident debugging.

## Where each machine is driven

| Machine | Concrete driver | Lifetime |
| --- | --- | --- |
| `daemonRootMachine`, `sentinelRegistryMachine` | `services/polling/daemon-loops.ts` (`startDaemonActors`) | Daemon process lifetime |
| `captureLoopMachine` | `services/polling/capture-cycle.ts` (`runCaptureCycle`) | Per capture cycle |
| `drainLoopMachine` | `services/polling/drain-cycle.ts` (`runDrainCycle`) | Per drain cycle |
| `heartbeatLoopMachine` | `services/polling/heartbeat-cycle.ts` (`runHeartbeatCycle`) | Per heartbeat cycle |
| `sourcePollMachine` | `runCaptureCycle` per registered source | Per source poll |
| `workerMachine` | `pollSourceInWorker` (default sources) | Per worker invocation |
| `cursorLifecycleMachine`, `quarantineLifecycleMachine` | `commitWorkerCapture` for each record in the worker output | Ephemeral per record |
| `batchLifecycleMachine` | `services/uploader/upload-batch.ts` (`uploadBatch` + `classifyAndPersist`) | Per outbound batch attempt |
| `pacerMachine` | `services/uploader/pacer.ts` (`createPacer`) | Pacer instance lifetime |
| `setupMachine` | `cli/commands/setup/index.ts` (`runSetup`) | Per `setup` command |
| `uninstallMachine` | `cli/commands/uninstall/index.ts` (`runUninstall`) | Per `uninstall` command |
| `serviceManagerMachine` | `cli/service-manager/index.ts` (`getServiceManager`) wraps the platform manager | Per service-manager instance |
| `binaryFreshnessMachine`, `autoUpgradeMachine` | Type-only contracts referenced by `heartbeat-cycle.ts` and `services/upgrade/auto-upgrade.ts`; the imperative implementations remain the runtime authority for side effects | — |

`runCaptureCycle`, `runDrainCycle`, and `runHeartbeatCycle` are still the
runtime authority for I/O, gating, and persistence. The cycle machines
*describe* the transitions they make as they go. There is no parallel
imperative-only path left for any cycle.

## Sleep / Resume & State Machines

System sleep/resume is transparent to the in-process event loop. The OS freezes and resumes the process, and the XState actors continue from their in-memory state with no re-initialization. The `daemon-root` machine models the process lifecycle (`boot → running → draining_for_shutdown → exited`), which sleep does not alter. In addition, machine snapshots are flushed but never restored in production. The watchdog and the rescue command operate entirely outside the state machine layer, reading sentinels and `buffer.db` directly. Therefore, sleep and resume events (such as `daemon.resumed`) are logged and persisted as `buffer.db` metadata, and are intentionally not modeled in the state machines.

[source: src/services/state-machines/*, scripts/export-diagrams/*, src/cli/commands/replay/*]
