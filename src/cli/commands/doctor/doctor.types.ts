import type { ServiceManager } from 'cli/service-manager';
import type { OutputSink } from 'cli/cli.types.ts';

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
  | 'G3';

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
}

export interface DoctorCommandOptions {
  readonly profile?: string;
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
}
