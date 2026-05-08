import { dirname } from 'node:path';

import { ensureDir, setMode, writeAtomic } from 'core/io/fs';
import { buildLaunchdPlist } from 'cli/launchd-plist.ts';
import { buildScheduledTaskXml, encodeScheduledTaskXml } from 'cli/scheduled-task-xml.ts';
import { buildSystemdUnit } from 'cli/systemd-unit.ts';

export interface WriteServiceUnitInput {
  serviceUnitPath: string;
  programPath: string;
  platform: NodeJS.Platform;
  windowsUserId?: string;
}

export async function writeServiceUnit(input: WriteServiceUnitInput): Promise<void> {
  await ensureDir(dirname(input.serviceUnitPath));
  if (input.platform === 'win32') {
    const userIdInput: { userId?: string } =
      input.windowsUserId !== undefined ? { userId: input.windowsUserId } : {};
    const xml = buildScheduledTaskXml({
      programPath: input.programPath,
      ...userIdInput,
    });
    await writeAtomic(input.serviceUnitPath, encodeScheduledTaskXml(xml));
    return;
  }
  const unit =
    input.platform === 'darwin'
      ? buildLaunchdPlist({ programPath: input.programPath })
      : buildSystemdUnit({ programPath: input.programPath });
  await writeAtomic(input.serviceUnitPath, unit);
  await setMode(input.serviceUnitPath, 0o644);
}

export interface ServiceUnitRecreateConfig {
  serviceUnitPath: string;
  programPath: string;
  platform: NodeJS.Platform;
  windowsUserId?: string;
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
  const writeInput: WriteServiceUnitInput = {
    serviceUnitPath: deps.config.serviceUnitPath,
    programPath: deps.config.programPath,
    platform: deps.config.platform,
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
