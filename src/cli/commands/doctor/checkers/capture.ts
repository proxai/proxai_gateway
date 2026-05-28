import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkD1NoAgentActivity(signals: DoctorSignals): Finding | null {
  if (!signals.daemonRunning) return null;
  if (signals.buffer.pendingCount > 0 || signals.buffer.receiptCount > 0) return null;

  const anySourceExists =
    signals.sourcePaths.claudeCodeExists ||
    signals.sourcePaths.cursorExists ||
    signals.sourcePaths.codexExists ||
    signals.sourcePaths.geminiCliExists;

  if (anySourceExists) {
    return {
      code: 'D1',
      severity: Severity.info,
      confidence: Confidence.likely,
      cause:
        'Capture cycling but no records captured — agent directories exist but no sessions recorded yet',
      action: 'Start a coding session; first capture occurs on the next cycle (within 2 min)',
    };
  }

  return {
    code: 'D1',
    severity: Severity.warning,
    confidence: Confidence.likely,
    cause: 'No agent source directories found — no supported coding agents detected',
    action:
      'Install a supported agent (Claude Code, Cursor, Codex, Gemini CLI) and start a session',
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
    cause: `One or more source parsers experiencing poll errors (${signals.recentEvents.retriableCount} retriable events)`,
    action: 'Check logs for source.poll errors; run proxai-gateway inspect for details',
  };
}
