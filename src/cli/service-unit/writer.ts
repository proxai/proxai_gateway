import { dirname } from 'node:path';

import { ensureDir, setMode, writeAtomic } from 'core/io/fs';
import type { ProfileName } from 'core/io/fs/profile.types.ts';
import { buildLaunchdPlist } from 'cli/service-unit/launchd-plist.ts';
import { profileLaunchdLabel } from 'cli/service-unit/dev-labels.ts';
import {
  buildScheduledTaskXml,
  encodeScheduledTaskXml,
} from 'cli/service-unit/scheduled-task-xml.ts';
import { buildSystemdUnit } from 'cli/service-unit/systemd-unit.ts';

export interface WriteServiceUnitInput {
  serviceUnitPath: string;
  programPath: string;
  platform: NodeJS.Platform;
  windowsUserId?: string;
  profileName?: ProfileName;
  programArgs?: readonly string[];
}

export async function writeServiceUnit(input: WriteServiceUnitInput): Promise<void> {
  await ensureDir(dirname(input.serviceUnitPath), 0o755);
  const profileName = input.profileName ?? 'prod';
  const programArgs = input.programArgs ?? ['run', '--profile', profileName];
  if (input.platform === 'win32') {
    const userIdInput: { userId?: string } =
      input.windowsUserId !== undefined ? { userId: input.windowsUserId } : {};
    const xml = buildScheduledTaskXml({
      programPath: input.programPath,
      programArgs,
      ...userIdInput,
    });
    await writeAtomic(input.serviceUnitPath, encodeScheduledTaskXml(xml));
    return;
  }
  const unit =
    input.platform === 'darwin'
      ? buildLaunchdPlist({
          programPath: input.programPath,
          programArgs,
          label: profileLaunchdLabel(profileName),
        })
      : buildSystemdUnit({ programPath: input.programPath, programArgs });
  await writeAtomic(input.serviceUnitPath, unit);
  await setMode(input.serviceUnitPath, 0o644);
}

export interface ServiceUnitRecreateConfig {
  serviceUnitPath: string;
  programPath: string;
  platform: NodeJS.Platform;
  windowsUserId?: string;
  profileName?: ProfileName;
}

export interface EnsureServiceUnitDeps {
  config: ServiceUnitRecreateConfig;
  fileExists?: (path: string) => Promise<boolean>;
  writer?: (input: WriteServiceUnitInput) => Promise<void>;
  onRecreate?: () => void;
}

export async function ensureServiceUnitExists(deps: EnsureServiceUnitDeps): Promise<boolean> {
  const fileExists = deps.fileExists ?? defaultFileExists;
  const exists = await fileExists(deps.config.serviceUnitPath);
  if (exists) return false;
  deps.onRecreate?.();
  const writer = deps.writer ?? writeServiceUnit;
  const profileName = deps.config.profileName ?? 'prod';
  const programArgs: readonly string[] = ['run', '--profile', profileName];
  const writeInput: WriteServiceUnitInput = {
    serviceUnitPath: deps.config.serviceUnitPath,
    programPath: deps.config.programPath,
    platform: deps.config.platform,
    profileName,
    programArgs,
  };
  if (deps.config.windowsUserId !== undefined) {
    writeInput.windowsUserId = deps.config.windowsUserId;
  }
  await writer(writeInput);
  return true;
}

function defaultFileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}
