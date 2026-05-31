import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkF17V8SyncEventLoopLag(signals: DoctorSignals): Finding | null {
  const lag = signals.performanceExtended.eventLoopLagMs;
  if (lag === null || lag < 100) {
    return null;
  }
  return {
    code: 'F17',
    severity: Severity.critical,
    confidence: Confidence.likely,
    cause: `High event loop lag (${lag.toString()}ms) is blocking the thread, stalling heartbeats and watcher operations.`,
    action:
      'Prune historical session logs larger than 50MB and ensure that directory watch filters exclude large build folders.',
  };
}

export function checkF18V8HeapExhaustion(signals: DoctorSignals): Finding | null {
  if (!signals.performanceExtended.gcThrashingActive) {
    return null;
  }
  return {
    code: 'F18',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'The JavaScript engine is thrashing on garbage collection, indicating sustained memory pressure.',
    action:
      'Prune large logs, restart the background service, and add standard folder ignore arrays to config.toml.',
  };
}

export function checkG10CompressionSpikes(signals: DoctorSignals): Finding | null {
  const spikeSec = signals.performanceExtended.zstdCompressionCpuSpikeSec;
  if (spikeSec === null || spikeSec < 1.5) {
    return null;
  }
  return {
    code: 'G10',
    severity: Severity.warning,
    confidence: Confidence.likely,
    cause: `Verbatim telemetry payload compression is creating severe CPU spikes (${spikeSec.toString()} seconds in single cycle).`,
    action:
      'Divide large session buffers into smaller chunks, or optimize background parse exclusions in config.toml.',
  };
}
