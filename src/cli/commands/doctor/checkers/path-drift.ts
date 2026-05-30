import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkE7HomebrewRelocationDrift(signals: DoctorSignals): Finding | null {
  if (signals.platform !== 'darwin' || signals.macOsQuarantineXattr === null) {
    return null;
  }
  const isIntelOnM1 = process.arch === 'x64' && signals.filesystem.configDirWritable;
  if (!isIntelOnM1) {
    return null;
  }
  return {
    code: 'E7',
    severity: Severity.warning,
    confidence: Confidence.likely,
    cause:
      'The gateway binary is running under Rosetta emulation, causing path collisions with the native Apple Silicon Homebrew prefix.',
    action:
      'Reinstall the gateway natively under the arm64 architecture using the official homebrew installer.',
  };
}
