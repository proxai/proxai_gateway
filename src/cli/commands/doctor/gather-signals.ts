import { access, constants as fsConstants, stat as fsStat } from 'node:fs/promises';
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

async function probeNestReachable(url: string): Promise<boolean | null> {
  try {
    const resp = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });
    return resp.status < 600;
  } catch {
    return false;
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
    nestReachable,
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
    daemonState: dbData.daemonState,
    binary: {
      version: deps.currentVersion,
      mtime: binaryMtime,
      installSource: null,
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
      diskFreeBytes: null,
    },
    network: {
      nestReachable,
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
    clockSkewMs: null,
  };

  return signals;
}
