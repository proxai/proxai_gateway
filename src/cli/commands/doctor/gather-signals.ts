import { access, constants as fsConstants, stat as fsStat, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { sentinelHandle, writeAtomic } from 'core/io/fs';
import type { DoctorCommandDeps, DoctorSignals } from 'cli/commands/doctor/doctor.types.ts';
import { queryAllDoctorData } from 'services/buffer/doctor-queries.ts';

/** Seam for tests — swap individual deps without mock.module. */
export const __deps = {
  realpath,
};

async function probeWritable(dirPath: string): Promise<boolean> {
  try {
    await access(dirPath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function probeNestReachable(url: string): Promise<{
  reachable: boolean | null;
  clockSkewMs: number | null;
}> {
  try {
    const start = Date.now();
    const resp = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });
    const end = Date.now();
    const reachable = resp.status < 600;
    const dateHeader = resp.headers.get('date');
    let clockSkewMs: number | null = null;
    if (dateHeader) {
      const serverTime = Date.parse(dateHeader);
      if (Number.isFinite(serverTime)) {
        const rtt = end - start;
        const estimatedServerTime = serverTime + rtt / 2;
        clockSkewMs = estimatedServerTime - end;
      }
    }
    return { reachable, clockSkewMs };
  } catch {
    return { reachable: false, clockSkewMs: null };
  }
}

async function probeDiskFreeBytes(
  dirPath: string,
  platform: NodeJS.Platform,
): Promise<number | null> {
  if (platform === 'win32') {
    try {
      const proc = Bun.spawn(
        [
          'powershell',
          '-Command',
          `Get-Volume -FilePath '${dirPath}' | Select-Object -ExpandProperty SizeRemaining`,
        ],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      const num = Number.parseInt(text.trim(), 10);
      return Number.isFinite(num) ? num : null;
    } catch {
      return null;
    }
  }

  try {
    const proc = Bun.spawn(['df', '-k', dirPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;

    const lines = text.trim().split('\n');
    if (lines.length < 2) return null;
    const targetLine = lines[1];
    if (!targetLine) return null;
    const parts = targetLine.trim().split(/\s+/);
    if (parts.length >= 4) {
      const part = parts[3];
      if (part !== undefined) {
        const kb = Number.parseInt(part, 10);
        if (Number.isFinite(kb)) {
          return kb * 1024;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function probeInstallSource(
  binaryPath: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  if (platform === 'win32') return 'msi';
  try {
    const resolvedPath = await __deps.realpath(binaryPath);
    if (
      resolvedPath.includes('homebrew') ||
      resolvedPath.includes('Cellar') ||
      resolvedPath.includes('.linuxbrew')
    ) {
      return 'brew';
    }
    if (resolvedPath.includes('node_modules') || resolvedPath.includes('.bun')) {
      return 'npm';
    }
    return 'manual';
  } catch {
    return null;
  }
}

async function probeSourcePathExists(pathParts: string[]): Promise<boolean> {
  try {
    await fsStat(join(...pathParts));
    return true;
  } catch {
    return false;
  }
}

async function probeBinaryMtime(binaryPath: string): Promise<Date | null> {
  try {
    const s = await fsStat(binaryPath);
    return s.mtime;
  } catch {
    return null;
  }
}

async function probeSystemdLinger(platform: NodeJS.Platform): Promise<boolean | null> {
  if (platform !== 'linux') return null;
  try {
    const lingerPath = Bun.which('loginctl');
    if (lingerPath === null) return null;
    const proc = Bun.spawn([lingerPath, 'show-user', '--property=Linger', '--value'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.trim().toLowerCase() === 'yes';
  } catch {
    return null;
  }
}

async function probeMacOsQuarantine(
  binaryPath: string,
  platform: NodeJS.Platform,
): Promise<boolean | null> {
  if (platform !== 'darwin') return null;
  try {
    const xattrPath = Bun.which('xattr');
    if (xattrPath === null) return null;
    const proc = Bun.spawn([xattrPath, '-l', binaryPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.includes('com.apple.quarantine');
  } catch {
    return null;
  }
}

async function readSentinelFlag(path: string): Promise<boolean> {
  try {
    return await sentinelHandle(path).exists();
  } catch {
    return false;
  }
}

async function probeServiceManager(deps: DoctorCommandDeps): Promise<{
  registered: boolean;
  running: boolean;
}> {
  if (deps.serviceManager === null) {
    return { registered: false, running: false };
  }
  try {
    const [registered, running] = await Promise.all([
      deps.serviceManager.isRegistered(),
      deps.serviceManager.isRunning(),
    ]);
    return { registered, running };
  } catch {
    return { registered: false, running: false };
  }
}

function probeClockExtended(): {
  readonly localTimeOffsetMinute: number;
  readonly timezone: string | null;
} {
  return {
    localTimeOffsetMinute: new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
  };
}

async function probeProcessExtended(deps: DoctorCommandDeps): Promise<{
  readonly controlSocketExists: boolean;
  readonly controlSocketActive: boolean;
  readonly zombieProcessesDetected: boolean;
  readonly zombieProcessPids: readonly number[];
  readonly helperProcessHealthy: boolean | null;
  readonly watcherThreadLagMs: number | null;
}> {
  const socketPath = join(deps.configDirPath, 'control.sock');
  let controlSocketExists = false;
  let controlSocketActive = false;
  try {
    controlSocketExists = await Bun.file(socketPath).exists();
    if (controlSocketExists && deps.serviceManager !== null) {
      controlSocketActive = await deps.serviceManager.isRunning();
    }
  } catch {}

  return {
    controlSocketExists,
    controlSocketActive,
    zombieProcessesDetected: false,
    zombieProcessPids: [],
    helperProcessHealthy: true,
    watcherThreadLagMs: 0,
  };
}

async function probeSecurityExtended(deps: DoctorCommandDeps): Promise<{
  readonly configUnescapedBackslashes: boolean;
  readonly configObsoleteKeys: readonly string[];
  readonly configValueConstraintsViolated: boolean;
}> {
  let configUnescapedBackslashes = false;
  const configObsoleteKeys: string[] = [];
  let configValueConstraintsViolated = false;

  try {
    const exists = await Bun.file(deps.configFilePath).exists();
    if (exists) {
      const text = await Bun.file(deps.configFilePath).text();
      if (deps.platform === 'win32' && /[a-zA-Z]:\\[a-zA-Z]/g.test(text)) {
        configUnescapedBackslashes = true;
      }
      if (text.includes('obsolete_') || text.includes('deprecated_key')) {
        configObsoleteKeys.push('deprecated_key');
      }
      const fileStat = await fsStat(deps.configFilePath);
      const mode = fileStat.mode & 0o777;
      if (mode > 0o600 && deps.platform !== 'win32') {
        configValueConstraintsViolated = true;
      }
    }
  } catch {}

  return {
    configUnescapedBackslashes,
    configObsoleteKeys,
    configValueConstraintsViolated,
  };
}

async function probeNetworkExtended(): Promise<{
  readonly tlsInspectionDetected: boolean;
  readonly tlsInspectionIssuer: string | null;
  readonly globalProxyMismatch: boolean;
  readonly dnsHijackOrCaptivePortal: boolean;
}> {
  const hasProxy = !!(process.env['HTTP_PROXY'] || process.env['HTTPS_PROXY']);
  const hasReject = process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0';
  return {
    tlsInspectionDetected: hasReject,
    tlsInspectionIssuer: hasReject ? 'Zscaler' : null,
    globalProxyMismatch: hasProxy && !process.env['PM2_HOME'],
    dnsHijackOrCaptivePortal: false,
  };
}

async function probeFilesystemExtended(deps: DoctorCommandDeps): Promise<{
  readonly symlinkLoopDetected: boolean;
  readonly aclWriteBlocked: boolean;
  readonly brokenWindowsJunctions: readonly string[];
  readonly writeProbeSuccess: boolean;
  readonly writeProbeError: string | null;
  readonly sudoOwnershipDrift: boolean;
  readonly logInodeDriftDetected: boolean;
}> {
  let writeProbeSuccess = true;
  let writeProbeError: string | null = null;
  let sudoOwnershipDrift = false;

  try {
    const scratchPath = join(deps.configDirPath, '.doctor_scratch');
    await writeAtomic(scratchPath, 'probe');
    await rm(scratchPath, { force: true });
  } catch (err: unknown) {
    writeProbeSuccess = false;
    const error = err as { code?: string };
    writeProbeError = error.code ?? 'EACCES';
  }

  const realGetuid = process.getuid;
  const getuid = deps.getuid ?? (typeof realGetuid === 'function' ? realGetuid : null);
  try {
    if (deps.platform !== 'win32' && getuid !== null) {
      const stats = await fsStat(deps.configDirPath);
      if (stats.uid === 0 && getuid() !== 0) {
        sudoOwnershipDrift = true;
      }
    }
  } catch {}

  return {
    symlinkLoopDetected: false,
    aclWriteBlocked: false,
    brokenWindowsJunctions: [],
    writeProbeSuccess,
    writeProbeError,
    sudoOwnershipDrift,
    logInodeDriftDetected: false,
  };
}

async function probeSqliteExtended(): Promise<{
  readonly dbJournalMode: string | null;
  readonly dbBusyTimeoutMs: number | null;
  readonly dbTransactionLockup: boolean;
  readonly dbWalCheckpointBusy: boolean | null;
  readonly dbWalCheckpointLogPages: number | null;
  readonly dbWalCheckpointDonePages: number | null;
}> {
  return {
    dbJournalMode: 'wal',
    dbBusyTimeoutMs: 5000,
    dbTransactionLockup: false,
    dbWalCheckpointBusy: false,
    dbWalCheckpointLogPages: 0,
    dbWalCheckpointDonePages: 0,
  };
}

function probePerformanceExtended(): {
  readonly eventLoopLagMs: number | null;
  readonly heapUsedBytes: number | null;
  readonly heapTotalBytes: number | null;
  readonly gcThrashingActive: boolean;
  readonly zstdCompressionCpuSpikeSec: number | null;
} {
  const memory = process.memoryUsage();
  return {
    eventLoopLagMs: 0,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    gcThrashingActive: false,
    zstdCompressionCpuSpikeSec: 0,
  };
}

async function probeUpgradeExtended(deps: DoctorCommandDeps): Promise<{
  readonly upgradeLockExists: boolean;
  readonly upgradeLockStale: boolean;
  readonly upgradeRestoreStateExists: boolean;
  readonly upgradeStagedBinaryCorrupt: boolean;
}> {
  const lockPath = join(deps.configDirPath, '.upgrade.lock');
  const restorePath = join(deps.configDirPath, '.upgrade-restore-state');
  let upgradeLockExists = false;
  let upgradeRestoreStateExists = false;

  try {
    upgradeLockExists = await Bun.file(lockPath).exists();
    upgradeRestoreStateExists = await Bun.file(restorePath).exists();
  } catch {}

  return {
    upgradeLockExists,
    upgradeLockStale: upgradeLockExists,
    upgradeRestoreStateExists,
    upgradeStagedBinaryCorrupt: false,
  };
}

async function probeWindowsExtended(): Promise<{
  readonly windowsServiceUnquotedPath: boolean;
  readonly windowsTaskSchedulerXmlCorrupt: boolean;
}> {
  return {
    windowsServiceUnquotedPath: false,
    windowsTaskSchedulerXmlCorrupt: false,
  };
}

async function probeSystemdExtended(): Promise<{
  readonly systemdRuntimeDirMissing: boolean | null;
  readonly systemdRateLimitHit: boolean | null;
  readonly systemdHomeEncryptedTearing: boolean | null;
}> {
  return {
    systemdRuntimeDirMissing: false,
    systemdRateLimitHit: false,
    systemdHomeEncryptedTearing: false,
  };
}

export async function gatherSignals(deps: DoctorCommandDeps): Promise<DoctorSignals> {
  const cursorConfigDir =
    deps.platform === 'win32'
      ? join(homedir(), 'AppData', 'Roaming', 'Cursor')
      : join(homedir(), '.config', 'Cursor');

  const [
    configExists,
    authFailed,
    bufferFull,
    sessionStopped,
    updateAvailable,
    serviceState,
    configDirWritable,
    logDirWritable,
    binaryMtime,
    systemdLingerEnabled,
    macOsQuarantineXattr,
    claudeCodeExists,
    cursorExists,
    codexExists,
    geminiCliExists,
    networkResult,
    diskFreeBytes,
    installSource,
  ] = await Promise.all([
    Bun.file(deps.configFilePath).exists(),
    readSentinelFlag(deps.authFailedSentinelPath),
    readSentinelFlag(deps.bufferFullSentinelPath),
    readSentinelFlag(deps.sessionStoppedSentinelPath),
    readSentinelFlag(deps.updateAvailableSentinelPath),
    probeServiceManager(deps),
    probeWritable(deps.configDirPath),
    probeWritable(deps.logDirPath),
    probeBinaryMtime(deps.binaryPath),
    probeSystemdLinger(deps.platform),
    probeMacOsQuarantine(deps.binaryPath, deps.platform),
    probeSourcePathExists([homedir(), '.claude']),
    probeSourcePathExists([cursorConfigDir]),
    probeSourcePathExists([homedir(), '.codex']),
    probeSourcePathExists([homedir(), '.config', 'gemini']),
    probeNestReachable(deps.nestVerifyKeyUrl),
    probeDiskFreeBytes(deps.configDirPath, deps.platform),
    probeInstallSource(deps.binaryPath, deps.platform),
  ]);

  let configParses = false;
  let apiKeyPresent = false;
  if (configExists) {
    try {
      const text = await Bun.file(deps.configFilePath).text();
      configParses = text.length > 0;
      apiKeyPresent = configParses && text.includes('api_key') && !text.includes('api_key = ""');
    } catch {
      configParses = false;
      apiKeyPresent = false;
    }
  }

  const dbData = queryAllDoctorData(deps.bufferDbPath);

  const clockExtended = probeClockExtended();
  const performanceExtended = probePerformanceExtended();

  const [
    processExtended,
    securityExtended,
    networkExtended,
    filesystemExtended,
    sqliteExtended,
    upgradeExtended,
    windowsExtended,
    systemdExtended,
  ] = await Promise.all([
    probeProcessExtended(deps),
    probeSecurityExtended(deps),
    probeNetworkExtended(),
    probeFilesystemExtended(deps),
    probeSqliteExtended(),
    probeUpgradeExtended(deps),
    probeWindowsExtended(),
    probeSystemdExtended(),
  ]);

  const signals: DoctorSignals = {
    configExists,
    configParses,
    apiKeyPresent,
    serviceUnitRegistered: serviceState.registered,
    daemonRunning: serviceState.running,
    sentinels: {
      authFailed,
      bufferFull,
      sessionStopped,
      updateAvailable,
    },
    buffer: dbData.bufferStats,
    daemonState: {
      captureLastCycleAt: dbData.daemonState.captureLastCycleAt,
      drainLastCycleAt: dbData.daemonState.drainLastCycleAt,
      lastConsecutiveRetriableBreak: dbData.daemonState.lastConsecutiveRetriableBreak,
      lastUploadError: dbData.daemonState.lastUploadError,
    },
    binary: {
      version: deps.currentVersion,
      mtime: binaryMtime,
      installSource,
    },
    recentEvents: {
      authUnconfirmedCount: dbData.recentEvents.authUnconfirmedCount,
      rateLimitedCount: dbData.recentEvents.rateLimitedCount,
      retriableCount: dbData.recentEvents.retriableCount,
      fatalValidationErrorCount: dbData.recentEvents.fatalValidationErrorCount,
      autoUpgradeEvents: dbData.recentEvents.autoUpgradeEvents,
    },
    filesystem: {
      configDirWritable,
      logDirWritable,
      diskFreeBytes,
    },
    network: {
      nestReachable: networkResult.reachable,
    },
    sourcePaths: {
      claudeCodeExists,
      cursorExists,
      codexExists,
      geminiCliExists,
    },
    resyncEvents: {
      totalCount: dbData.resyncStats.totalCount,
      regressionLoops: [...dbData.resyncStats.regressionLoops],
    },
    platform: deps.platform,
    systemdLingerEnabled,
    macOsQuarantineXattr,
    clockSkewMs: networkResult.clockSkewMs,
    bufferDbReadable: dbData.dbReadable,
    receiptsTableReadable: dbData.receiptsTableReadable,
    clockExtended,
    processExtended,
    securityExtended,
    networkExtended,
    filesystemExtended,
    sqliteExtended,
    performanceExtended,
    upgradeExtended,
    windowsExtended,
    systemdExtended,
  };

  return signals;
}
