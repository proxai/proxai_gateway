import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkA11WindowsServiceUnquotedPath(signals: DoctorSignals): Finding | null {
  if (!signals.windowsExtended.windowsServiceUnquotedPath) {
    return null;
  }
  return {
    code: 'A11',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'The service binary path in the Windows registry contains spaces but is unquoted, exposing the host to privilege hijacking.',
    action:
      'Add double quotes around the service binPath: "sc config proxai-gateway binpath= \\"\\"%ProgramFiles%\\ProxAI\\Gateway\\bin\\proxai-gateway.exe\\" --service\\"".',
  };
}

export function checkA12WindowsTaskSchedulerXmlCorrupt(signals: DoctorSignals): Finding | null {
  if (!signals.windowsExtended.windowsTaskSchedulerXmlCorrupt) {
    return null;
  }
  return {
    code: 'A12',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause:
      'The Task Scheduler XML definition is corrupted or unparseable, preventing background daemon task triggers.',
    action:
      'Re-register the scheduled task: "proxai-gateway setup --force" to recreate the XML definition.',
  };
}
