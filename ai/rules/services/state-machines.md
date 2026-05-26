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

[source: src/services/state-machines, scripts/export-diagrams, src/cli/commands/replay, ai/rules/services/no-direct-sqlite-outside-buffer.md]
