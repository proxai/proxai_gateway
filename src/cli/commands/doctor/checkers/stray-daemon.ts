import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkA6AbruptDaemonTermination(signals: DoctorSignals): Finding | null {
  if (signals.daemonRunning || signals.sentinels.sessionStopped) {
    return null;
  }
  const lastCapture = signals.daemonState.captureLastCycleAt;
  if (lastCapture === null) {
    return null;
  }
  return {
    code: 'A6',
    severity: Severity.critical,
    confidence: Confidence.likely,
    cause:
      'The gateway daemon terminated abruptly without running its clean exit routines, suggesting an unhandled crash or SIGKILL.',
    action:
      'Run "proxai-gateway logs" to inspect the stack trace, and restart the service via "proxai-gateway restart".',
  };
}

export function checkA7ZombieDaemon(signals: DoctorSignals): Finding | null {
  if (!signals.processExtended.zombieProcessesDetected) {
    return null;
  }
  return {
    code: 'A7',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'One or more orphaned (zombie) gateway background processes are running outside the service manager.',
    action:
      'Terminate conflicting background processes: "killall proxai-gateway" (macOS/Linux) or "Stop-Process" (Windows).',
  };
}

export function checkA8GracefulTerminationLockup(signals: DoctorSignals): Finding | null {
  if (!signals.daemonRunning || !signals.processExtended.controlSocketExists) {
    return null;
  }
  const isDraining = signals.processExtended.controlSocketActive === false;
  if (!isDraining) {
    return null;
  }
  return {
    code: 'A8',
    severity: Severity.warning,
    confidence: Confidence.likely,
    cause:
      'The daemon is trapped in a graceful shutdown draining cycle, blocking new execution instances.',
    action:
      'Force-stop the lingering process: "proxai-gateway stop --force" to clear socket handles.',
  };
}

export function checkA9HelperProcessHealthy(signals: DoctorSignals): Finding | null {
  if (
    signals.processExtended.helperProcessHealthy === true ||
    signals.processExtended.helperProcessHealthy === null
  ) {
    return null;
  }
  return {
    code: 'A9',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'The daemon background helper processes have crashed or failed to initialize, degrading ingestion.',
    action:
      'Restart the background daemon to respawn and initialize native helper processors cleanly.',
  };
}

export function checkA10ThreadWatcherExhaustion(signals: DoctorSignals): Finding | null {
  const lag = signals.processExtended.watcherThreadLagMs;
  if (lag === null || lag < 500) {
    return null;
  }
  return {
    code: 'A10',
    severity: Severity.warning,
    confidence: Confidence.likely,
    cause: `Active file watcher thread pools are saturated (latency ${lag.toString()}ms), causing delayed capturing.`,
    action:
      'Ensure nested build folders (node_modules, target, dist) are added to config.toml watch exclusions.',
  };
}
