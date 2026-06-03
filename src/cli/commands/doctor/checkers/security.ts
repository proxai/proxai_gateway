import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkB4InsecureApiKeyTransmission(signals: DoctorSignals): Finding | null {
  if (
    !signals.securityExtended.configUnescapedBackslashes &&
    !signals.networkExtended.tlsInspectionDetected
  ) {
    return null;
  }
  const isBypassed = process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0';
  if (!isBypassed) {
    return null;
  }
  return {
    code: 'B4',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'SSL validation is explicitly disabled (NODE_TLS_REJECT_UNAUTHORIZED=0), exposing gateway keys to interception.',
    action:
      'Remove NODE_TLS_REJECT_UNAUTHORIZED=0 from your environment and shell configuration profiles.',
  };
}

export function checkB5PermissiveConfigPermissions(signals: DoctorSignals): Finding | null {
  if (!signals.configExists) {
    return null;
  }
  const isPermissive = signals.securityExtended.configValueConstraintsViolated;
  if (!isPermissive) {
    return null;
  }
  return {
    code: 'B5',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause:
      'The gateway configuration file stores plain-text API keys but has overly permissive group/world permissions.',
    action: `Restrict directory permissions to the owner only: "chmod 600 ${signals.configDirPath}/config.toml".`,
  };
}

export function checkB6OverlyBroadDirectoryWatches(signals: DoctorSignals): Finding | null {
  const obsoleteKeys = signals.securityExtended.configObsoleteKeys;
  if (obsoleteKeys.length === 0) {
    return null;
  }
  return {
    code: 'B6',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause: `The gateway is monitoring overly broad folders [${obsoleteKeys.join(', ')}] which risk ingesting high-risk credential files.`,
    action:
      'Narrow down the watched directory paths in config.toml to active, discrete project workspaces.',
  };
}
