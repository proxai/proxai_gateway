import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkB1InvalidKey(signals: DoctorSignals): Finding | null {
  if (!signals.sentinels.authFailed) return null;
  return {
    code: 'B1',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause: 'AUTH_FAILED sentinel present — API key rejected by server',
    action: 'Run: proxai-gateway setup --force with a valid key; verify at proxai.co',
  };
}

export function checkB2AuthUnconfirmedLoop(signals: DoctorSignals): Finding | null {
  if (signals.sentinels.authFailed) return null;
  if (signals.recentEvents.authUnconfirmedCount <= 0) return null;
  return {
    code: 'B2',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause: `Auth-unconfirmed loop (${signals.recentEvents.authUnconfirmedCount} occurrences) — network failure during verifyKey, NOT a key problem`,
    action: `Check connectivity to the nest endpoint; AUTH_FAILED is absent so the key itself is fine`,
  };
}

export function checkB3IngestionKeyAuthError(signals: DoctorSignals): Finding | null {
  const err = signals.daemonState.lastUploadError;
  if (!err) return null;
  const lower = err.toLowerCase();
  if (lower.includes('403') || lower.includes('ingestion key') || lower.includes('ingestion_key')) {
    return {
      code: 'B3',
      severity: Severity.critical,
      confidence: Confidence.confirmed,
      cause: `Ingestion key auth error in last upload cycle: ${err}`,
      action: 'Run: proxai-gateway setup --force with a valid key',
    };
  }
  return null;
}
