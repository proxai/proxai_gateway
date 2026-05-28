import { existsSync, readFileSync } from 'node:fs';

import type { ProfileName } from 'core/io/fs/profile.types.ts';
import { writeServiceUnit } from 'cli/service-unit/writer.ts';
import type { WriteServiceUnitInput } from 'cli/service-unit/writer.ts';

export interface ServiceUnitRefreshConfig {
  readonly serviceUnitPath: string;
  readonly programPath: string;
  readonly platform: NodeJS.Platform;
  readonly profileName: ProfileName;
  readonly windowsUserId?: string;
}

export async function refreshServiceUnitIfLegacy(config: ServiceUnitRefreshConfig): Promise<void> {
  if (!existsSync(config.serviceUnitPath)) return;
  const body = readFileSync(config.serviceUnitPath, 'utf8');
  if (body.includes('--profile')) return;
  const input: WriteServiceUnitInput = {
    serviceUnitPath: config.serviceUnitPath,
    programPath: config.programPath,
    platform: config.platform,
    profileName: config.profileName,
  };
  if (config.windowsUserId !== undefined) {
    input.windowsUserId = config.windowsUserId;
  }
  await writeServiceUnit(input);
}
