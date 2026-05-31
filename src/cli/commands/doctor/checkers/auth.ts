import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkB1InvalidKey(signals: DoctorSignals): Finding | null {
  if (!signals.sentinels.authFailed) return null;
  return {
    code: 'B1',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'The configured gateway key has been rejected by the ProxAI server, meaning it is invalid or deleted.',
    action:
      'Retrieve a valid gateway key from your ProxAI dashboard (https://proxai.co) and reconfigure by running: "proxai-gateway setup new"',
  };
}

export function checkB2AuthUnconfirmedLoop(signals: DoctorSignals): Finding | null {
  if (signals.sentinels.authFailed) return null;
  if (signals.recentEvents.authUnconfirmedCount <= 0) return null;
  return {
    code: 'B2',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause: `API key network verification is looping (${signals.recentEvents.authUnconfirmedCount} occurrences) due to connectivity issues. The local API key is valid, but the verification requests are failing to reach the gateway.`,
    action:
      'Check your internet connectivity, proxy configuration, and firewall rules to ensure that the API server is reachable.',
  };
}

export function checkB3IngestionKeyAuthError(signals: DoctorSignals): Finding | null {
  const err = signals.daemonState.lastUploadError;
  if (!err) return null;
  const lower = err.toLowerCase();
  if (lower.includes('403') || lower.includes('gateway key') || lower.includes('ingestion_key')) {
    return {
      code: 'B3',
      severity: Severity.critical,
      confidence: Confidence.confirmed,
      cause: 'Log upload failed because the configured gateway key is invalid or has expired.',
      action:
        'Generate a fresh gateway key from your ProxAI dashboard (https://proxai.co) and reconfigure by running: "proxai-gateway setup new"',
    };
  }
  return null;
}
