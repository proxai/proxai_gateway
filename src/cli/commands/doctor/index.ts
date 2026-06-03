import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import type {
  DoctorCommandDeps,
  DoctorCommandOptions,
  Finding,
} from 'cli/commands/doctor/doctor.types.ts';
import { gatherSignals } from 'cli/commands/doctor/gather-signals.ts';
import { renderDoctorOutput, generateDoctorHtml } from 'cli/commands/doctor/render-doctor.ts';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import chalk from 'chalk';
import { readDevModeSentinel } from 'core/io/fs/dev-mode-sentinel.ts';
import { readBootId } from 'core/system/boot-id.ts';
import { profileRootDir, buildProfileContext } from 'core/io/fs/profile.ts';
import { nestVerifyKeyUrl } from 'services/config';
import { buildPlatformServiceContext, platformServiceUnitPath } from 'cli/wiring/platform.ts';
import {
  checkA1NotSetUp,
  checkA2UnitNotRegistered,
  checkA3StoppedByUser,
  checkA4Crashed,
  checkA5Wedged,
} from 'cli/commands/doctor/checkers/lifecycle.ts';
import {
  checkB1InvalidKey,
  checkB2AuthUnconfirmedLoop,
  checkB3IngestionKeyAuthError,
} from 'cli/commands/doctor/checkers/auth.ts';
import {
  checkC1RateLimited,
  checkC2NetworkFailure,
  checkC3DrainWedged,
  checkC4BufferRecovery,
  checkC5BufferOscillating,
  checkC6ParserValidationErrors,
  checkC7QuarantinedRows,
} from 'cli/commands/doctor/checkers/upload.ts';
import {
  checkD1NoAgentActivity,
  checkD2OneSourceErroring,
} from 'cli/commands/doctor/checkers/capture.ts';
import {
  checkE1StaleBinary,
  checkE2BrewUpdatePending,
  checkE3WriteFailed,
  checkE4SuccessOldVersionRunning,
} from 'cli/commands/doctor/checkers/binary.ts';
import {
  checkF1ConfigDirNotWritable,
  checkF2DiskSpaceLow,
  checkF3LogDirNotWritable,
  checkF4ClockSkew,
  checkF5LinuxNoLinger,
  checkF6WindowsUserUnresolvable,
  checkF7MacOsQuarantine,
} from 'cli/commands/doctor/checkers/filesystem.ts';
import {
  checkG1ReceiptsTableReadable,
  checkG2BufferDbCorrupt,
  checkG3RegressionLoop,
} from 'cli/commands/doctor/checkers/data-integrity.ts';

import {
  checkG4JournalMode,
  checkG5BusyTimeout,
  checkG6TransactionLockup,
  checkG7WalCheckpointStarvation,
  checkG8UncommittedJournalStaleLock,
} from 'cli/commands/doctor/checkers/concurrency.ts';
import {
  checkB4InsecureApiKeyTransmission,
  checkB5PermissiveConfigPermissions,
  checkB6OverlyBroadDirectoryWatches,
} from 'cli/commands/doctor/checkers/security.ts';
import {
  checkF17V8SyncEventLoopLag,
  checkF18V8HeapExhaustion,
  checkG10CompressionSpikes,
} from 'cli/commands/doctor/checkers/performance.ts';
import {
  checkC8OutboundTlsInspection,
  checkC9GlobalProxyMismatch,
  checkC10DnsHijackCaptivePortal,
  checkC11ThrottlerResetSkew,
  checkC12ThunderingHerdJitter,
  checkC13OutboxTimeout,
} from 'cli/commands/doctor/checkers/network.ts';
import {
  checkA13SystemdRuntimeDirMissing,
  checkA14SystemdRateLimitHit,
  checkA15SystemdHomeEncryptedTearing,
} from 'cli/commands/doctor/checkers/systemd.ts';
import {
  checkA11WindowsServiceUnquotedPath,
  checkA12WindowsTaskSchedulerXmlCorrupt,
} from 'cli/commands/doctor/checkers/windows.ts';
import {
  checkA6AbruptDaemonTermination,
  checkA7ZombieDaemon,
  checkA8GracefulTerminationLockup,
  checkA9HelperProcessHealthy,
  checkA10ThreadWatcherExhaustion,
} from 'cli/commands/doctor/checkers/stray-daemon.ts';
import { checkE7HomebrewRelocationDrift } from 'cli/commands/doctor/checkers/path-drift.ts';
import {
  checkE5UpgradeLockStale,
  checkE6CorruptedUpgradeBinary,
} from 'cli/commands/doctor/checkers/upgrade-lock.ts';
import {
  checkF8MacOsTccFDA,
  checkF9MacOsGatekeeperTranslocation,
  checkF10SandboxedTerminalLocks,
  checkF11SymlinkTraversalLoop,
  checkF12POSIXExtendedAclBlocked,
  checkF13BrokenWindowsJunction,
  checkF14LogRotationInodeDrift,
  checkF15PhysicalWriteExhaustion,
  checkF16SudoHijackOwnershipDrift,
} from 'cli/commands/doctor/checkers/advanced-fs.ts';
import { checkG9InconsistentSessionUuids } from 'cli/commands/doctor/checkers/data-extended.ts';

import type { DoctorSignals } from 'cli/commands/doctor/doctor.types.ts';

type Checker = (signals: DoctorSignals) => Finding | null;

const ALL_CHECKERS: readonly Checker[] = [
  checkA1NotSetUp,
  checkA2UnitNotRegistered,
  checkA3StoppedByUser,
  checkA4Crashed,
  checkA5Wedged,
  checkA6AbruptDaemonTermination,
  checkA7ZombieDaemon,
  checkA8GracefulTerminationLockup,
  checkA9HelperProcessHealthy,
  checkA10ThreadWatcherExhaustion,
  checkA11WindowsServiceUnquotedPath,
  checkA12WindowsTaskSchedulerXmlCorrupt,
  checkA13SystemdRuntimeDirMissing,
  checkA14SystemdRateLimitHit,
  checkA15SystemdHomeEncryptedTearing,
  checkB1InvalidKey,
  checkB2AuthUnconfirmedLoop,
  checkB3IngestionKeyAuthError,
  checkB4InsecureApiKeyTransmission,
  checkB5PermissiveConfigPermissions,
  checkB6OverlyBroadDirectoryWatches,
  checkC1RateLimited,
  checkC2NetworkFailure,
  checkC3DrainWedged,
  checkC4BufferRecovery,
  checkC5BufferOscillating,
  checkC6ParserValidationErrors,
  checkC7QuarantinedRows,
  checkC8OutboundTlsInspection,
  checkC9GlobalProxyMismatch,
  checkC10DnsHijackCaptivePortal,
  checkC11ThrottlerResetSkew,
  checkC12ThunderingHerdJitter,
  checkC13OutboxTimeout,
  checkD1NoAgentActivity,
  checkD2OneSourceErroring,
  checkE1StaleBinary,
  checkE2BrewUpdatePending,
  checkE3WriteFailed,
  checkE4SuccessOldVersionRunning,
  checkE5UpgradeLockStale,
  checkE6CorruptedUpgradeBinary,
  checkE7HomebrewRelocationDrift,
  checkF1ConfigDirNotWritable,
  checkF2DiskSpaceLow,
  checkF3LogDirNotWritable,
  checkF4ClockSkew,
  checkF5LinuxNoLinger,
  checkF6WindowsUserUnresolvable,
  checkF7MacOsQuarantine,
  checkF8MacOsTccFDA,
  checkF9MacOsGatekeeperTranslocation,
  checkF10SandboxedTerminalLocks,
  checkF11SymlinkTraversalLoop,
  checkF12POSIXExtendedAclBlocked,
  checkF13BrokenWindowsJunction,
  checkF14LogRotationInodeDrift,
  checkF15PhysicalWriteExhaustion,
  checkF16SudoHijackOwnershipDrift,
  checkF17V8SyncEventLoopLag,
  checkF18V8HeapExhaustion,
  checkG1ReceiptsTableReadable,
  checkG2BufferDbCorrupt,
  checkG3RegressionLoop,
  checkG4JournalMode,
  checkG5BusyTimeout,
  checkG6TransactionLockup,
  checkG7WalCheckpointStarvation,
  checkG8UncommittedJournalStaleLock,
  checkG9InconsistentSessionUuids,
  checkG10CompressionSpikes,
];

function runCheckers(signals: DoctorSignals): Finding[] {
  const findings: Finding[] = [];
  for (const checker of ALL_CHECKERS) {
    const result = checker(signals);
    if (result !== null) {
      findings.push(result);
    }
  }
  return findings;
}

function replaceLegacyPaths(finding: Finding, deps: DoctorCommandDeps): Finding {
  const quotePath = (p: string): string => (p.includes(' ') ? `'${p}'` : p);

  const replaceText = (text: string): string => {
    const isLogReference =
      text.includes('log directory') ||
      text.includes('log files') ||
      text.includes('log-inode') ||
      finding.code === 'F3' ||
      finding.code === 'F14';

    let result = text;
    // Replace most specific paths first
    result = result.replace(/~\/\.proxai\/config\.toml/g, quotePath(deps.configFilePath));
    result = result.replace(/~\/\.proxai\/buffer\.db/g, quotePath(deps.bufferDbPath));
    result = result.replace(
      /~\/\.proxai\/\.upgrade\.lock/g,
      quotePath(join(deps.configDirPath, '.upgrade.lock')),
    );

    if (isLogReference) {
      result = result.replace(/~\/\.proxai/g, quotePath(deps.logDirPath));
    } else {
      result = result.replace(/~\/\.proxai/g, quotePath(deps.configDirPath));
    }

    // Additionally check if configDirPath or logDirPath is embedded in the checker message
    // without quotes and has spaces, then quote it to keep shell command syntax safe.
    const configDir = deps.configDirPath;
    if (configDir.includes(' ')) {
      const quotedConfigDir = `'${configDir}'`;
      if (
        result.includes(configDir) &&
        !result.includes(quotedConfigDir) &&
        !result.includes(`"${configDir}"`)
      ) {
        result = result.split(deps.configFilePath).join(quotePath(deps.configFilePath));
        result = result.split(deps.bufferDbPath).join(quotePath(deps.bufferDbPath));
        result = result.split(configDir).join(quotePath(configDir));
      }
    }

    const logDir = deps.logDirPath;
    if (logDir.includes(' ')) {
      const quotedLogDir = `'${logDir}'`;
      if (
        result.includes(logDir) &&
        !result.includes(quotedLogDir) &&
        !result.includes(`"${logDir}"`)
      ) {
        result = result.split(logDir).join(quotePath(logDir));
      }
    }

    return result;
  };

  return {
    ...finding,
    cause: replaceText(finding.cause),
    action: replaceText(finding.action),
  };
}

export async function runDoctor(
  deps: DoctorCommandDeps,
  options: DoctorCommandOptions,
): Promise<CommandResult> {
  deps.output.info('Gathering diagnostic signals...');

  const isDevMode = await readDevModeSentinel(
    join(profileRootDir(), 'DEV_MODE'),
    deps.readBootId ?? readBootId,
  );
  let findings: Finding[];
  let signals: DoctorSignals;

  if (isDevMode && options.profile === undefined) {
    signals = await gatherSignals(deps);
    const devFindings = runCheckers(signals).map((f) => replaceLegacyPaths(f, deps));

    const prodCtx = buildProfileContext('prod');
    const platform = deps.platform;
    const unitPath = platformServiceUnitPath(platform, prodCtx.configDir);
    const prodServiceManager =
      unitPath !== null
        ? (buildPlatformServiceContext(platform, deps.binaryPath, prodCtx.configDir)
            ?.serviceManager ?? null)
        : null;
    const prodDeps: DoctorCommandDeps = {
      output: deps.output,
      bufferDbPath: prodCtx.bufferDbPath,
      configFilePath: prodCtx.configFilePath,
      configDirPath: prodCtx.configDir,
      logDirPath: prodCtx.logDir,
      authFailedSentinelPath: prodCtx.sentinels.authFailed,
      bufferFullSentinelPath: prodCtx.sentinels.bufferFull,
      sessionStoppedSentinelPath: prodCtx.sentinels.sessionStopped,
      updateAvailableSentinelPath: prodCtx.sentinels.updateAvailable,
      nestVerifyKeyUrl: nestVerifyKeyUrl(prodCtx.defaultNestBaseUrl),
      serviceManager: prodServiceManager,
      platform: deps.platform,
      binaryPath: deps.binaryPath,
      currentVersion: deps.currentVersion,
      profileCtx: prodCtx,
    };
    const prodSignals = await gatherSignals(prodDeps);
    const prodFindings = runCheckers(prodSignals).map((f) => replaceLegacyPaths(f, prodDeps));

    const genericCodes = new Set(['C2', 'E2', 'F2', 'F4', 'F6', 'F7']);
    const combinedFindings: Finding[] = [];
    const addedGenericCodes = new Set<string>();

    for (const f of devFindings) {
      if (genericCodes.has(f.code)) {
        if (!addedGenericCodes.has(f.code)) {
          combinedFindings.push(f);
          addedGenericCodes.add(f.code);
        }
      } else {
        combinedFindings.push({
          ...f,
          cause: `[dev] ${f.cause}`,
        });
      }
    }

    for (const f of prodFindings) {
      if (genericCodes.has(f.code)) {
        if (!addedGenericCodes.has(f.code)) {
          combinedFindings.push(f);
          addedGenericCodes.add(f.code);
        }
      } else {
        combinedFindings.push({
          ...f,
          cause: `[prod] ${f.cause}`,
        });
      }
    }

    findings = combinedFindings;
  } else {
    signals = await gatherSignals(deps);
    const rawFindings = runCheckers(signals).map((f) => replaceLegacyPaths(f, deps));

    if (isDevMode) {
      const genericCodes = new Set(['C2', 'E2', 'F2', 'F4', 'F6', 'F7']);
      const profileLabel = deps.profileCtx.name === 'dev' ? '[dev]' : '[prod]';
      findings = rawFindings.map((f) => {
        if (!genericCodes.has(f.code)) {
          return {
            ...f,
            cause: `${profileLabel} ${f.cause}`,
          };
        }
        return f;
      });
    } else {
      findings = rawFindings;
    }
  }

  const output = renderDoctorOutput(findings, signals);

  deps.output.info(output);

  if (options.output !== undefined) {
    const MONTHS = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const now = new Date();
    const monthStr = MONTHS[now.getMonth()];
    const dayStr = String(now.getDate()).padStart(2, '0');
    const hourStr = String(now.getHours()).padStart(2, '0');
    const minStr = String(now.getMinutes()).padStart(2, '0');
    const secStr = String(now.getSeconds()).padStart(2, '0');

    const filename = `gateway-doctor-${monthStr}_${dayStr}_${hourStr}_${minStr}_${secStr}.html`;

    const homedirPath = homedir();
    let targetPath: string;
    if (options.output === true || options.output === '') {
      targetPath = join(homedirPath, 'Desktop', filename);
    } else {
      const rawPath = String(options.output);
      const resolved = resolve(rawPath);
      if (
        rawPath.endsWith('/') ||
        rawPath.endsWith('\\') ||
        !rawPath.split(/[/\\]/).pop()?.includes('.')
      ) {
        targetPath = join(resolved, filename);
      } else {
        targetPath = resolved;
      }
    }

    const htmlContent = generateDoctorHtml(findings, signals, now.toLocaleString());
    await writeFile(targetPath, htmlContent, 'utf-8');
    deps.output.info(`[OK] Diagnostic HTML report exported to: ${chalk.cyan(targetPath)}`);
  }

  return { exitCode: EXIT_CODE.ok };
}
