# rescue

`src/services/rescue/` owns the periodic self-healing watchdog and daemon rescue commands, managing the rescue ledger state, computing starting/restarting decisions, and enforcing circuit breaker limits.

## Watchdog & Rescue Ledger (`rescue-ledger.ts`)

The rescue process is driven by an out-of-process periodic task (running every 15 minutes) executing the headless `rescue` command. The command state is tracked in `rescue-ledger.json` under the profile directory.

### Ledger Schema

```ts
export interface RescueLedger {
  bootId: string;
  lastRescueAt: string | null;
  consecutiveFailures: number;
  attempts: Array<{ at: string; action: 'start' | 'restart' }>;
  lastObservedHeartbeatAt: string | null;
}
```

- `bootId`: Wiped and reset to the current OS boot ID when a mismatch is detected, resetting consecutive failure counts to zero to prevent stale locks.
- `consecutiveFailures`: Represents consecutive failures to start or keep the daemon healthy (see failure accounting below).
- `attempts`: Debugging audit log trail recording historical start/restart events.
- `lastObservedHeartbeatAt`: Stores the last heartbeat timestamp observed during the previous watchdog run to enable double-check wedge confirmation.

## Rescue Decisions (`rescue-decision.ts`)

The decision engine maps active signals to one of the target actions:
- `none` (with specific reasons: `not-configured`, `not-registered`, `user-stopped`, `paused`, `upgrading`, `rate-capped`, `circuit-broken`, `healthy`).
- `start`: Triggered if the daemon is down (`!isRunning`) and has been down longer than `SUSTAINED_DOWN_MS` (10 minutes).
- `restart`: Triggered if the daemon is running, but its heartbeat age exceeds `WEDGE_STALE_MS` (30 minutes) **AND** the heartbeat has not advanced since the previous watchdog run (equals `lastObservedHeartbeatAt`).

### Double-Check Wedge Confirmation

To prevent false positive restarts after system sleep/wake cycles (where the heartbeat appears stale because the machine was asleep, but the daemon is healthy and has not had a chance to refresh yet):
1. A wedge-restart is only issued if `lastObservedHeartbeatAt` is non-null and matches the current heartbeat.
2. If the heartbeat advanced, or it is the first watchdog observation (`lastObservedHeartbeatAt === null`), the watchdog judges the daemon `healthy` and updates `lastObservedHeartbeatAt` to wait for the next check.

## Failure Accounting Polarity

Consecutive failures represent genuine failures only:
- **Healthy daemon (`healthy` decision)**: Resets `consecutiveFailures` to `0`.
- **Start/Restart action**: If a prior rescue attempt has been recorded (`lastRescueAt !== null`), it implies the daemon failed to stay healthy following that attempt. Therefore, `consecutiveFailures` is incremented by 1.
- **Paused / Upgrading / Rate-capped / Circuit-broken**: Leaves `consecutiveFailures` unchanged (a paused or user-stopped daemon is not a failure).

## Circuit Breaker (Doctor Finding A16)

- When `consecutiveFailures >= MAX_CONSECUTIVE_FAILURES` (default: 3), the circuit breaker trips. The decision transitions to `circuit-broken` and stops auto-recovery to prevent infinite loop thrashing.
- The `doctor` command checker `checkA16RescueCircuitBreakerTripped` fires a critical finding when the breaker is tripped.
- The standard crashed finder `checkA4Crashed` is suppressed when the breaker is tripped, ensuring only a single actionable `A16` finding is shown to the developer.

[source: src/services/rescue/rescue-ledger.ts; src/services/rescue/rescue-decision.ts; src/cli/commands/doctor/checkers/lifecycle.ts]
