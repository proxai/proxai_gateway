import { access, constants as fsConstants, stat as fsStat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { sentinelHandle } from 'core/io/fs';
import type { DoctorCommandDeps, DoctorSignals } from 'cli/commands/doctor/doctor.types.ts';
import { queryAllDoctorData } from 'services/buffer/doctor-queries.ts';

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
    const resolvedPath = await realpath(binaryPath);
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
  };

  return signals;
}
