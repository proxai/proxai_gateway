import type { ServiceManager } from 'cli/service-manager';
import type { OutputSink } from 'cli/cli.types.ts';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';

export const Severity = {
  critical: 'critical',
  warning: 'warning',
  info: 'info',
  healthy: 'healthy',
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export const Confidence = {
  confirmed: 'CONFIRMED',
  likely: 'LIKELY',
} as const;
export type Confidence = (typeof Confidence)[keyof typeof Confidence];

export type FindingCode =
  | 'A1'
  | 'A2'
  | 'A3'
  | 'A4'
  | 'A5'
  | 'B1'
  | 'B2'
  | 'B3'
  | 'C1'
  | 'C2'
  | 'C3'
  | 'C4'
  | 'C5'
  | 'C6'
  | 'C7'
  | 'D1'
  | 'D2'
  | 'E1'
  | 'E2'
  | 'E3'
  | 'E4'
  | 'F1'
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F5'
  | 'F6'
  | 'F7'
  | 'G1'
  | 'G2'
  | 'A6'
  | 'A7'
  | 'A8'
  | 'A9'
  | 'A10'
  | 'A11'
  | 'A12'
  | 'A13'
  | 'A14'
  | 'A15'
  | 'B1'
  | 'B2'
  | 'B3'
  | 'B4'
  | 'B5'
  | 'B6'
  | 'C1'
  | 'C2'
  | 'C3'
  | 'C4'
  | 'C5'
  | 'C6'
  | 'C7'
  | 'C8'
  | 'C9'
  | 'C10'
  | 'C11'
  | 'C12'
  | 'C13'
  | 'D1'
  | 'D2'
  | 'E1'
  | 'E2'
  | 'E3'
  | 'E4'
  | 'E5'
  | 'E6'
  | 'E7'
  | 'F1'
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F5'
  | 'F6'
  | 'F7'
  | 'F8'
  | 'F9'
  | 'F10'
  | 'F11'
  | 'F12'
  | 'F13'
  | 'F14'
  | 'F15'
  | 'F16'
  | 'F17'
  | 'F18'
  | 'G1'
  | 'G2'
  | 'G3'
  | 'G4'
  | 'G5'
  | 'G6'
  | 'G7'
  | 'G8'
  | 'G9'
  | 'G10';

export interface Finding {
  readonly code: FindingCode;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly cause: string;
  readonly action: string;
}

export interface DoctorSignals {
  readonly configExists: boolean;
  readonly configParses: boolean;
  readonly apiKeyPresent: boolean;
  readonly serviceUnitRegistered: boolean;
  readonly daemonRunning: boolean;
  readonly sentinels: {
    readonly authFailed: boolean;
    readonly bufferFull: boolean;
    readonly sessionStopped: boolean;
    readonly updateAvailable: boolean;
  };
  readonly buffer: {
    readonly pendingCount: number;
    readonly pendingBytes: number;
    readonly failedCount: number;
    readonly quarantinedCount: number;
    readonly receiptCount: number;
    readonly lastPruneAt: string | null;
    readonly lastSuccessAt: string | null;
  };
  readonly daemonState: {
    readonly captureLastCycleAt: string | null;
    readonly drainLastCycleAt: string | null;
    readonly lastConsecutiveRetriableBreak: boolean | null;
    readonly lastUploadError: string | null;
  };
  readonly binary: {
    readonly version: string;
    readonly mtime: Date | null;
    readonly installSource: string | null;
  };
  readonly recentEvents: {
    readonly authUnconfirmedCount: number;
    readonly rateLimitedCount: number;
    readonly retriableCount: number;
    readonly fatalValidationErrorCount: number;
    readonly autoUpgradeEvents: readonly string[];
  };
  readonly filesystem: {
    readonly configDirWritable: boolean;
    readonly logDirWritable: boolean;
    readonly diskFreeBytes: number | null;
  };
  readonly network: {
    readonly nestReachable: boolean | null;
  };
  readonly sourcePaths: {
    readonly claudeCodeExists: boolean;
    readonly cursorExists: boolean;
    readonly codexExists: boolean;
    readonly geminiCliExists: boolean;
  };
  readonly resyncEvents: {
    readonly totalCount: number;
    readonly regressionLoops: ReadonlyArray<{
      readonly sourcePathHash: string;
      readonly countInLastHour: number;
    }>;
  };
  readonly platform: NodeJS.Platform;
  readonly systemdLingerEnabled: boolean | null;
  readonly macOsQuarantineXattr: boolean | null;
  readonly clockSkewMs: number | null;
  readonly bufferDbReadable: boolean;
  readonly receiptsTableReadable: boolean;
  readonly clockExtended: {
    readonly localTimeOffsetMinute: number;
    readonly timezone: string | null;
  };
  readonly processExtended: {
    readonly controlSocketExists: boolean;
    readonly controlSocketActive: boolean;
    readonly zombieProcessesDetected: boolean;
    readonly zombieProcessPids: readonly number[];
    readonly helperProcessHealthy: boolean | null;
    readonly watcherThreadLagMs: number | null;
  };
  readonly securityExtended: {
    readonly configUnescapedBackslashes: boolean;
    readonly configObsoleteKeys: readonly string[];
    readonly configValueConstraintsViolated: boolean;
  };
  readonly networkExtended: {
    readonly tlsInspectionDetected: boolean;
    readonly tlsInspectionIssuer: string | null;
    readonly globalProxyMismatch: boolean;
    readonly dnsHijackOrCaptivePortal: boolean;
  };
  readonly filesystemExtended: {
    readonly symlinkLoopDetected: boolean;
    readonly aclWriteBlocked: boolean;
    readonly brokenWindowsJunctions: readonly string[];
    readonly writeProbeSuccess: boolean;
    readonly writeProbeError: string | null;
    readonly sudoOwnershipDrift: boolean;
    readonly logInodeDriftDetected: boolean;
  };
  readonly sqliteExtended: {
    readonly dbJournalMode: string | null;
    readonly dbBusyTimeoutMs: number | null;
    readonly dbTransactionLockup: boolean;
    readonly dbWalCheckpointBusy: boolean | null;
    readonly dbWalCheckpointLogPages: number | null;
    readonly dbWalCheckpointDonePages: number | null;
  };
  readonly performanceExtended: {
    readonly eventLoopLagMs: number | null;
    readonly heapUsedBytes: number | null;
    readonly heapTotalBytes: number | null;
    readonly gcThrashingActive: boolean;
    readonly zstdCompressionCpuSpikeSec: number | null;
  };
  readonly upgradeExtended: {
    readonly upgradeLockExists: boolean;
    readonly upgradeLockStale: boolean;
    readonly upgradeRestoreStateExists: boolean;
    readonly upgradeStagedBinaryCorrupt: boolean;
  };
  readonly windowsExtended: {
    readonly windowsServiceUnquotedPath: boolean;
    readonly windowsTaskSchedulerXmlCorrupt: boolean;
  };
  readonly systemdExtended: {
    readonly systemdRuntimeDirMissing: boolean | null;
    readonly systemdRateLimitHit: boolean | null;
    readonly systemdHomeEncryptedTearing: boolean | null;
  };
}

export interface DoctorCommandOptions {
  readonly profile?: string | undefined;
  readonly output?: string | boolean | undefined;
  readonly compact?: boolean;
}

export interface DoctorCommandDeps {
  readonly output: OutputSink;
  readonly bufferDbPath: string;
  readonly configFilePath: string;
  readonly configDirPath: string;
  readonly logDirPath: string;
  readonly authFailedSentinelPath: string;
  readonly bufferFullSentinelPath: string;
  readonly sessionStoppedSentinelPath: string;
  readonly updateAvailableSentinelPath: string;
  readonly nestVerifyKeyUrl: string;
  readonly serviceManager: ServiceManager | null;
  readonly platform: NodeJS.Platform;
  readonly binaryPath: string;
  readonly currentVersion: string;
  readonly profileCtx: ProfileContext;
  // Injectable so the sudo-ownership check is testable on a Windows runner,
  // where the real process.getuid is undefined. Defaults to process.getuid.
  readonly getuid?: () => number;
  // Injectable so DEV_MODE detection is deterministic in tests — the real
  // readBootId throws on CI Linux (empty /proc boot_id). Defaults to readBootId.
  readonly readBootId?: () => Promise<string>;
}
