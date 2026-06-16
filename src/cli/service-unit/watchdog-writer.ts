import { dirname } from 'node:path';
import { ensureDir, setMode, writeAtomic } from 'core/io/fs';
import type { ProfileName } from 'core/io/fs/profile.types.ts';
import { buildWatchdogLaunchdPlist } from 'cli/service-unit/watchdog-launchd-plist.ts';
import {
  buildWatchdogSystemdService,
  buildWatchdogSystemdTimer,
} from 'cli/service-unit/watchdog-systemd-units.ts';
import { buildWatchdogScheduledTaskXml } from 'cli/service-unit/watchdog-scheduled-task-xml.ts';
import { encodeScheduledTaskXml } from 'cli/service-unit/scheduled-task-xml.ts';

export interface WriteWatchdogServiceUnitInput {
  platform: NodeJS.Platform;
  profileName: ProfileName;
  programPath: string;
  plistPath?: string | undefined;
  xmlPath?: string | undefined;
  timerPath?: string | undefined;
  servicePath?: string | undefined;
}

export async function writeWatchdogServiceUnit(
  input: WriteWatchdogServiceUnitInput,
): Promise<void> {
  if (input.platform === 'darwin') {
    if (input.plistPath === undefined) {
      return;
    }
    await ensureDir(dirname(input.plistPath), 0o755);
    const plist = buildWatchdogLaunchdPlist({
      programPath: input.programPath,
      profile: input.profileName,
    });
    await writeAtomic(input.plistPath, plist);
    await setMode(input.plistPath, 0o644);
    return;
  }

  if (input.platform === 'win32') {
    if (input.xmlPath === undefined) {
      return;
    }
    await ensureDir(dirname(input.xmlPath), 0o755);
    const xml = buildWatchdogScheduledTaskXml({
      programPath: input.programPath,
      profile: input.profileName,
    });
    await writeAtomic(input.xmlPath, encodeScheduledTaskXml(xml));
    return;
  }

  if (input.platform === 'linux') {
    if (input.timerPath === undefined || input.servicePath === undefined) {
      return;
    }
    await ensureDir(dirname(input.timerPath), 0o755);
    await ensureDir(dirname(input.servicePath), 0o755);
    const timerUnit = buildWatchdogSystemdTimer({
      programPath: input.programPath,
      profile: input.profileName,
    });
    const serviceUnit = buildWatchdogSystemdService({
      programPath: input.programPath,
      profile: input.profileName,
    });
    await writeAtomic(input.timerPath, timerUnit);
    await setMode(input.timerPath, 0o644);
    await writeAtomic(input.servicePath, serviceUnit);
    await setMode(input.servicePath, 0o644);
    return;
  }
}

export interface EnsureWatchdogUnitDeps {
  platform: NodeJS.Platform;
  profileName: ProfileName;
  programPath: string;
  plistPath?: string | undefined;
  xmlPath?: string | undefined;
  timerPath?: string | undefined;
  servicePath?: string | undefined;
  fileExists?: (path: string) => Promise<boolean>;
  writer?: (input: WriteWatchdogServiceUnitInput) => Promise<void>;
}

export async function ensureWatchdogUnitExists(deps: EnsureWatchdogUnitDeps): Promise<boolean> {
  const fileExists = deps.fileExists ?? ((p) => Bun.file(p).exists());
  const writer = deps.writer ?? writeWatchdogServiceUnit;

  const writeInput: WriteWatchdogServiceUnitInput = {
    platform: deps.platform,
    profileName: deps.profileName,
    programPath: deps.programPath,
    plistPath: deps.plistPath,
    xmlPath: deps.xmlPath,
    timerPath: deps.timerPath,
    servicePath: deps.servicePath,
  };

  let shouldWrite = false;
  if (deps.platform === 'darwin') {
    if (deps.plistPath !== undefined && !(await fileExists(deps.plistPath))) {
      shouldWrite = true;
    }
  } else if (deps.platform === 'win32') {
    if (deps.xmlPath !== undefined && !(await fileExists(deps.xmlPath))) {
      shouldWrite = true;
    }
  } else if (deps.platform === 'linux') {
    if (
      deps.timerPath !== undefined &&
      deps.servicePath !== undefined &&
      (!(await fileExists(deps.timerPath)) || !(await fileExists(deps.servicePath)))
    ) {
      shouldWrite = true;
    }
  }

  if (shouldWrite) {
    await writer(writeInput);
    return true;
  }

  return false;
}
