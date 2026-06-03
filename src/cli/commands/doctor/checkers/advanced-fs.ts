import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkF8MacOsTccFDA(signals: DoctorSignals): Finding | null {
  if (signals.platform !== 'darwin') {
    return null;
  }
  if (signals.filesystem.configDirWritable) {
    return null;
  }
  return {
    code: 'F8',
    severity: Severity.critical,
    confidence: Confidence.likely,
    cause:
      'macOS Transparency, Consent, and Control (TCC) is blocking access to critical application directories.',
    action:
      'Open System Settings > Privacy & Security > Full Disk Access, add your terminal/editor, and toggle permissions on.',
  };
}

export function checkF9MacOsGatekeeperTranslocation(signals: DoctorSignals): Finding | null {
  if (signals.platform !== 'darwin' || !signals.macOsQuarantineXattr) {
    return null;
  }
  return {
    code: 'F9',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause: 'macOS Gatekeeper has translocated the binary or marked it with a quarantine attribute.',
    action:
      'Clear the quarantine flag by running: "xattr -d com.apple.quarantine $(which proxai-gateway)"',
  };
}

export function checkF10SandboxedTerminalLocks(signals: DoctorSignals): Finding | null {
  if (signals.platform !== 'darwin') {
    return null;
  }
  if (signals.filesystem.configDirWritable) {
    return null;
  }
  return {
    code: 'F10',
    severity: Severity.warning,
    confidence: Confidence.likely,
    cause:
      'The gateway is running inside a sandboxed terminal environment, which restricts write capabilities to user profile paths.',
    action:
      'Run the gateway command from a native external terminal app (e.g. Terminal.app or iTerm2).',
  };
}

export function checkF11SymlinkTraversalLoop(signals: DoctorSignals): Finding | null {
  if (!signals.filesystemExtended.symlinkLoopDetected) {
    return null;
  }
  return {
    code: 'F11',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'An infinite symbolic link recursion loop has been detected inside your monitored workspace directories.',
    action: 'Break the cyclic symlink chain by deleting or unlinking the self-referential symlink.',
  };
}

export function checkF12POSIXExtendedAclBlocked(signals: DoctorSignals): Finding | null {
  if (!signals.filesystemExtended.aclWriteBlocked) {
    return null;
  }
  return {
    code: 'F12',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'Fine-grained POSIX Access Control Lists (ACLs) or immutable attributes are overriding permissions and blocking writes.',
    action: `Clear custom ACL and immutable flags: "chflags nouchg ${signals.configDirPath}" (macOS) or "chattr -i" (Linux).`,
  };
}

export function checkF13BrokenWindowsJunction(signals: DoctorSignals): Finding | null {
  const junctions = signals.filesystemExtended.brokenWindowsJunctions;
  if (junctions.length === 0) {
    return null;
  }
  return {
    code: 'F13',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause: `An active Windows Junction Point [${junctions.join(', ')}] points to an offline or unmounted volume/network share.`,
    action:
      'Re-mount the target network share/volume, or delete and recreate the Junction point locally.',
  };
}

export function checkF14LogRotationInodeDrift(signals: DoctorSignals): Finding | null {
  if (!signals.filesystemExtended.logInodeDriftDetected) {
    return null;
  }
  return {
    code: 'F14',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'The gateway daemon is tailing a stale, unlinked log file following a host log rotation event, stalling ingestion.',
    action:
      'Force-restart the background daemon to release file descriptors and re-establish clean file handles.',
  };
}

export function checkF15PhysicalWriteExhaustion(signals: DoctorSignals): Finding | null {
  if (signals.filesystemExtended.writeProbeSuccess || !signals.filesystem.configDirWritable) {
    return null;
  }
  const err = signals.filesystemExtended.writeProbeError;
  const isRo = err === 'EROFS';
  const isNoSpace = err === 'ENOSPC';
  return {
    code: 'F15',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause: isRo
      ? 'The filesystem has been remounted read-only due to system errors or device corruption.'
      : isNoSpace
        ? 'The partition has run out of available inodes (system ran out of file descriptors).'
        : 'The volume is experiencing severe I/O exhaustion, write throttling, or physical failure.',
    action: isNoSpace
      ? 'Prune obsolete small temporary files. Check current inode utilization via "df -i".'
      : 'Verify partition health using disk utility tools, and check syslog or Event Viewer for storage failures.',
  };
}

export function checkF16SudoHijackOwnershipDrift(signals: DoctorSignals): Finding | null {
  if (!signals.filesystemExtended.sudoOwnershipDrift) {
    return null;
  }
  return {
    code: 'F16',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'Gateway database directories have inherited root-level ownership, blocking standard user process writes.',
    action: `Restore ownership permissions to your active user: "sudo chown -R $(whoami) ${signals.configDirPath}".`,
  };
}
