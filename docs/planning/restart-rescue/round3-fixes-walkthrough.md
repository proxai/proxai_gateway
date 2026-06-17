# Restart & Rescue — Round 3 Sleep Strategy & Observability Alignment Walkthrough

This document details the implementation of the Round 3 sleep strategy and observability alignment edge cases on the `feat/restart-rescue` branch. All requirements have been successfully implemented, unit-tested, and verified to achieve 100.00% statement and branch coverage with zero lints, format issues, or type errors.

---

## 1. Summary of Achievements

- **WATCHDOG RESUME GRACE (HK-2a)**: Mitigated the wake-race condition. Persisted `lastWatchdogRunAt` in the rescue ledger (reset on boot-id mismatch). Graced the rescue check on wake cycles when the watchdog gap exceeds 30 minutes, allowing the daemon to wake up and tick naturally before any wedge action is evaluated.
- **PER-LOOP WEDGE DETECTION (HK-1)**: Hardened the wedge detector by evaluating the capture and drain loops independently using ledger fields `lastObservedCaptureAt` and `lastObservedDrainAt`. If a single loop dies/hangs (while the other loop ticks normally), the watchdog now successfully detects it and restarts the daemon.
- **HEALTHY LEDGER RESET (HK-3)**: Cleared the `lastRescueAt` field upon marking the daemon healthy, ensuring the next subsequent failure starts with a clean slate without inheriting historical attempt data.
- **DAEMON-SIDE RESUME DETECTION (HK-2b & OB-PREREQ)**: Implemented wall-clock delta checks across loop sleeps. Gaps greater than 2 minutes trigger a `daemon.resumed` event and persist `last_resumed_at` to the database metadata.
- **DOCTOR WATCHDOG-MISSING CHECK (OB-1 / A17)**: Added defensive watchdog installation checking during diagnostics. A new warning finding **A17** (`checkA17WatchdogMissing`) warns the user if the daemon service unit is registered but the auto-recovery watchdog service is not installed.
- **SLEEP-AWARE DIAGNOSTICS (OB-2)**: hard-suppressed Doctor checks A5 (wedged capture) and C3 (wedged drain) when `now - lastResumedAt < 300,000ms` (5 minutes), preventing false-positive diagnostics right after the host wakes from sleep.
- **WORDING ALIGNMENT (OB-3)**: Clarified A14 and A5 finding texts to explain that auto-recovery is running or paced recovery is active, signaling "self-healing in progress".
- **STATUS COMMAND SURFACE (OB-5)**: Surface watchdog installation status, auto-recovery restart details, circuit breaker status, and recent sleep-resume events in the `status` command terminal renderer and JSON output.
- **STATE MACHINE CONVENTIONS DOCUMENTATION (OB-6)**: Added architectural notes explaining why sleep/resume is transparent to and omitted from XState machines, keeping them free of unnecessary complexity.
- **100% VERIFIED GATES**:
  - `bun run check` is completely clean (0 warnings, 0 errors, all files formatted).
  - All **3,242 tests** pass successfully.
  - **100.00% function and line coverage** achieved and maintained across all 392 files.
  - Local Docker Linux unit tests pass successfully on both target architectures.

---

## 2. Walkthrough of Implemented Fixes

### HK-2a: Watchdog Resume-Grace
* **Problem**: Spurious restarts could be triggered if a machine went to sleep and woke up, because the daemon heartbeat was frozen during sleep and the watchdog caught it before the daemon could tick.
* **Implementation**:
  - Persisted `lastWatchdogRunAt` in the rescue ledger.
  - Computed the watchdog run gap on each check; if the gap exceeds 30 minutes (`RESUME_GAP_THRESHOLD_MS`), we treat this run as a post-resume grace cycle (`likelyResumed = true`) and return `none/healthy` without performing a wedge check.
  - A down daemon (`!isRunning`) is not graced on wake, ensuring crashed daemons are brought up instantly.

### HK-1: Per-Loop Wedge Detection
* **Problem**: The original watchdog evaluated wedge restarts using the max heartbeat age of both capture and drain cycles. If only one loop hung, the max age still appeared fresh, leaving the hung loop silently dead.
* **Implementation**:
  - Replaced the single `lastObservedHeartbeatAt` with independent `lastObservedCaptureAt` and `lastObservedDrainAt` ledger fields.
  - Wedge check verifies `captureWedged` and `drainWedged` independently against these observed values. If either is wedged, a restart is scheduled.

### HK-3: Clear `lastRescueAt` on Healthy
* **Problem**: `markDaemonHealthy` reset `consecutiveFailures` but kept `lastRescueAt`, causing the next failure after a long healthy stretch to inherit a stale timestamp.
* **Implementation**:
  - Updated `markDaemonHealthy` in [rescue-ledger.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_gateway/src/services/rescue/rescue-ledger.ts) to set `lastRescueAt = null`.

### HK-2b: Daemon-Side Resume Detection
* **Problem**: Loops need to detect wake-from-sleep events to log them and update metadata quickly.
* **Implementation**:
  - Measured wall-clock durations around each loop's `sleep` wrapper in [daemon-loops.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_gateway/src/services/polling/daemon-loops.ts).
  - Gaps greater than 2 minutes (`RESUME_MARGIN_MS`) log `daemon.resumed` and write a `last_resumed_at` timestamp to the buffer db metadata.

### OB-1: Doctor Finding A17 (Watchdog Missing)
* **Problem**: If the watchdog service unit was never registered or was removed, the user was not warned that auto-recovery was disabled.
* **Implementation**:
  - Gathers `watchdog.installed` signal by probing `isInstalled()` from the platform watchdog manager.
  - If the gateway config exists and the service unit is registered but the watchdog is missing, fires warning **A17** recommending `"proxai-gateway start"`.

### OB-2: Sleep-Aware Doctor Checks
* **Problem**: Running `doctor` right after wake from a long sleep reported false-positive wedge findings.
* **Implementation**:
  - Suppressed doctor checkers `checkA5Wedged` and `checkC3DrainWedged` if the daemon resumed within the last 5 minutes (`RESUME_GRACE_MS`).

### OB-5: Status Command Alignment
* **Problem**: The `status` command had no visibility into watchdog installation, auto-recovery, or sleep resume.
* **Implementation**:
  - Gathered watchdog installation status, rescue ledger details, and `lastResumedAt` metadata.
  - Added formatted output rows for:
    - **Watchdog**: `● installed` (auto-recovery on) or `○ not installed` (auto-recovery OFF).
    - **Auto-recovery**: Surfaces the last restart time, consecutive failure count, or a circuit breaker warning if tripped.
    - **Resumed**: Surfaces the relative duration since the last sleep-resume.
  - Exposed all properties in the `--json` payload.

---

## 3. Verification Report

### Static Analysis
```bash
$ bun run check
$ tsc --noEmit
$ oxlint --deny-warnings
Found 0 warnings and 0 errors.
Finished in 43ms on 723 files with 122 rules using 10 threads.
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

### Full Coverage Test Execution
```bash
$ bun run test:cov
====================================================================================================
  COVERAGE GAPS
====================================================================================================
  OK - every file at 100.00% funcs / 100.00% lines

====================================================================================================
  FAILURES (0)
====================================================================================================
  OK - no failing tests

====================================================================================================
  SUMMARY
====================================================================================================
  Tests:    3242 passed | 0 failed | 0 skipped
  Files:    259 total | 0 with failures
  Coverage: lines 100.00% | funcs 100.00% | 392/392 files at 100%
```

### Local Docker Linux Unit Tests
```bash
$ po gateway test
==> run complete — container staying up (po stop gateway:x64 to stop)
=== Summary ===
  ● linux/arm64  proxai-gateway-test-arm64 (running)  (3242/3242 passed)
  ● linux/amd64  proxai-gateway-test-x64 (running)    (3242/3242 passed)
```
