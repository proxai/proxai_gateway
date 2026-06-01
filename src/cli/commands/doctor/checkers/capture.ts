import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkD1NoAgentActivity(signals: DoctorSignals): Finding | null {
  if (!signals.daemonRunning) return null;
  if (signals.buffer.pendingCount > 0 || signals.buffer.receiptCount > 0) return null;

  const anySourceExists =
    signals.sourcePaths.claudeCodeExists ||
    signals.sourcePaths.cursorExists ||
    signals.sourcePaths.codexExists;

  if (anySourceExists) {
    return {
      code: 'D1',
      severity: Severity.info,
      confidence: Confidence.likely,
      cause:
        'Coding agent directories exist but no active session or command history has been recorded yet.',
      action:
        'Start a coding session by running commands/prompts in your agent; capture will trigger automatically within 2 minutes.',
    };
  }

  return {
    code: 'D1',
    severity: Severity.warning,
    confidence: Confidence.likely,
    cause: 'No supported coding agents (Claude Code, Cursor, Codex) are detected on this system.',
    action:
      'Install a supported coding agent, start a session, and run a prompt to begin capturing activity.',
  };
}

export function checkD2OneSourceErroring(signals: DoctorSignals): Finding | null {
  if (
    signals.recentEvents.retriableCount <= 0 &&
    signals.recentEvents.fatalValidationErrorCount <= 0
  )
    return null;
  if (signals.buffer.pendingCount > 0 || signals.buffer.receiptCount > 0) return null;
  if (signals.recentEvents.fatalValidationErrorCount > 0) return null;

  return {
    code: 'D2',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause: `One or more coding agent parsers encountered log polling errors (${signals.recentEvents.retriableCount} retriable failures).`,
    action:
      'Run "proxai-gateway inspect" to diagnose the parser errors and check your agent log file permissions.',
  };
}
