---
name: "State Machine Structure and Integrations"
description: "XState v5 structure, separate types files, buffer access rules, sentinel writes, and snapshot restores."
activation: "contextual"
scenarios: ["Creating or refactoring a state machine", "Forwarding cross-machine events or updating active machines list", "Configuring state machine snapshot restoration or platform input branches"]
globs: ["src/**/*.ts", "**/*.ts"]
---

# State Machine Rules


- Every machine lives under `src/services/state-machines/<name>/` with at minimum `<name>.machine.ts`, `<name>.types.ts`, `index.ts`, and `tests/<name>.test.ts`. Add `<name>.constants.ts` / `<name>.utils.ts` when the machine has shared constants or pure helper functions; do not stuff them into the machine file.
- Use xstate v5's `setup({ types, actors, guards, actions }).createMachine({ ... })` idiom for every machine. The xstate-vscode extension and the diagram exporter both rely on this shape.
- Define the `Input`, `Context`, and `Event` types in the per-machine `types.ts` and import them into the machine file. Do not declare them inline inside `setup()`.
- Machine actors **must not** import `bun:sqlite` directly. Reads and writes go through `services/buffer` exports (and only `services/buffer/*` may touch the SQLite handle).
- Sentinel writes from inside machines go through `services/polling/*-sentinel.ts` helpers, which already use `sentinelHandle` + `writeAtomic`. Never call `Bun.write(sentinelPath, ...)` directly.
- Cross-process state lives in two places: `buffer.db` (durable rows) and sentinel files (durable flags). Machines are in-process observers/drivers; their in-memory state is a hint, never the source of truth.
- Snapshots persisted via `daemon_state.machine_snapshots` are restored on boot, but if a snapshot disagrees with the observed sentinel state on disk, the sentinel wins. Treat snapshots as performance hints, not as canonical state.
- Do not add `process.platform === '...'` comparisons inside machine files. If a machine needs to branch on platform, the surrounding caller passes platform via the machine's `input`, and the caller is the centralized wiring (`cli/wiring/`).
- `event-router` is the single subscription chokepoint. Cross-machine event forwarding belongs there, not inside individual machines.
- The `MachineName` union in `state-machines.types.ts` is the canonical list of machines. Adding a new machine requires updating that union and the diagram exporter's machine list.

## Machine integration points (active)

Every machine listed below is created/driven by a concrete caller. Do not delete or rename the caller without coordinating the machine update; do not introduce a machine without a real driver.

| Machine | Driver | Lifetime |
| --- | --- | --- |
| `daemonRootMachine` | `services/polling/daemon-loops.ts` (`startDaemonActors`) | Daemon process lifetime |
| `sentinelRegistryMachine` | Composed inside `daemon-actors.ts` (via `startSentinelWatcher`) | Daemon process lifetime |
| `captureLoopMachine` | `services/polling/capture-cycle.ts` (`runCaptureCycle`) | Per capture cycle |
| `drainLoopMachine` | `services/polling/drain-cycle.ts` (`runDrainCycle`) | Per drain cycle |
| `heartbeatLoopMachine` | `services/polling/heartbeat-cycle.ts` (`runHeartbeatCycle`) | Per heartbeat cycle |
| `sourcePollMachine` | `runCaptureCycle` per registered source | Per source poll within a cycle |
| `workerMachine` | `runCaptureCycle` → `pollSourceInWorker` for default sources | Per worker invocation |
| `cursorLifecycleMachine` | `runCaptureCycle` → `commitWorkerCapture` for each cursor in the worker output | Ephemeral per cursor commit |
| `quarantineLifecycleMachine` | `runCaptureCycle` → `commitWorkerCapture` for each quarantined record | Ephemeral per quarantine entry |
| `batchLifecycleMachine` | `services/uploader/upload-batch.ts` (`uploadBatch` + `classifyAndPersist`) | Per outbound batch attempt |
| `pacerMachine` | `services/uploader/pacer.ts` (`createPacer`) | Pacer instance lifetime |
| `binaryFreshnessMachine` | (Type-only; freshness check side effects live in `services/polling/stale-binary.ts`) | — |
| `autoUpgradeMachine` | (Type-only; auto-upgrade side effects live in `services/upgrade/auto-upgrade.ts`) | — |
| `setupMachine` | `cli/commands/setup/index.ts` (`runSetup`) | Per `setup` command invocation |
| `uninstallMachine` | `cli/commands/uninstall/index.ts` (`runUninstall`) | Per `uninstall` command invocation |
| `serviceManagerMachine` | `cli/service-manager/index.ts` (`getServiceManager`) | Per service-manager instance |

[source: src/services/state-machines, scripts/export-diagrams, src/cli/commands/replay, ai/rules/services/no-direct-sqlite-outside-buffer.md]
