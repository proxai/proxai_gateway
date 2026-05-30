import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkC8OutboundTlsInspection(signals: DoctorSignals): Finding | null {
  if (!signals.networkExtended.tlsInspectionDetected) {
    return null;
  }
  const issuer = signals.networkExtended.tlsInspectionIssuer ?? 'Unknown Interceptor';
  return {
    code: 'C8',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause: `Outbound HTTPS traffic is decrypted by a corporate proxy interceptor: "${issuer}".`,
    action:
      'Export the corporate root CA from your Keychain and export it in NODE_EXTRA_CA_CERTS in your shell profile.',
  };
}

export function checkC9GlobalProxyMismatch(signals: DoctorSignals): Finding | null {
  if (!signals.networkExtended.globalProxyMismatch) {
    return null;
  }
  return {
    code: 'C9',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause:
      'Global OS HTTP proxy settings exist but are not inherited by the background daemon (PM2/launchd) context.',
    action:
      'Define the HTTP_PROXY / HTTPS_PROXY variables explicitly in your daemon configuration or launch shell.',
  };
}

export function checkC10DnsHijackCaptivePortal(signals: DoctorSignals): Finding | null {
  if (!signals.networkExtended.dnsHijackOrCaptivePortal) {
    return null;
  }
  return {
    code: 'C10',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'DNS lookup returned private landing page IPs or active captive portal blocks from your local network gateway.',
    action:
      'Authenticate on the network landing page, or bypass local hijacked DNS to restore API accessibility.',
  };
}

export function checkC11ThrottlerResetSkew(signals: DoctorSignals): Finding | null {
  const skew = signals.clockSkewMs;
  if (skew === null || Math.abs(skew) < 30000) {
    return null;
  }
  return {
    code: 'C11',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause: `Local clock skew (${Math.round(skew / 1000).toString()}s) causes invalid rate-limit reset calculations.`,
    action:
      'Sync system time with an upstream NTP server to restore accurate rate-limiting retry boundaries.',
  };
}

export function checkC12ThunderingHerdJitter(signals: DoctorSignals): Finding | null {
  const loops = signals.resyncEvents.regressionLoops.filter((l) => l.countInLastHour > 5);
  if (loops.length === 0) {
    return null;
  }
  return {
    code: 'C12',
    severity: Severity.warning,
    confidence: Confidence.likely,
    cause:
      'Multiple concurrent instances are executing retry loops in lockstep, inducing thundering herd server starvation.',
    action: 'Configure randomized retry backoff jitter in your API gateway retry configurations.',
  };
}

export function checkC13OutboxTimeout(signals: DoctorSignals): Finding | null {
  const recentEvents = signals.recentEvents;
  if (recentEvents.retriableCount < 10) {
    return null;
  }
  return {
    code: 'C13',
    severity: Severity.critical,
    confidence: Confidence.likely,
    cause: 'The gateway network outbox is experiencing persistent resync request timeouts.',
    action:
      'Verify server status and lower upload_max_bytes_per_minute in config.toml to slice packet sizes.',
  };
}
