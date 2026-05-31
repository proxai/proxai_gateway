import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';

import type { SetupCommandDeps, SetupCommandOptions } from 'cli/commands/setup/setup.types.ts';

export const INGESTION_KEY_PATTERN = /^[A-Za-z0-9]{4,}-[A-Za-z0-9]{4,}-[A-Za-z0-9]{4,}$/;

export type KeyAcquisitionResult =
  | { ok: true; apiKey: string }
  | { ok: false; result: CommandResult };

export async function acquireApiKey(
  deps: SetupCommandDeps,
  options: SetupCommandOptions,
  isReplace: boolean,
): Promise<KeyAcquisitionResult> {
  let apiKey: string;
  if (isReplace) {
    if (options.apiKey !== undefined) {
      apiKey = options.apiKey.trim();
    } else {
      deps.output.warn('an gateway key is already configured for this machine');
      deps.output.info('to replace it, type the new gateway key, then re-enter it to confirm');
      const first = (await deps.prompts.askApiKey()).trim();
      const second = (await deps.prompts.askApiKey('Type the same key again to confirm:')).trim();
      if (first !== second) {
        deps.output.warn('entries did not match; existing key preserved');
        return { ok: false, result: { exitCode: EXIT_CODE.alreadyInstalled } };
      }
      apiKey = first;
    }
  } else {
    apiKey = (options.apiKey ?? (await deps.prompts.askApiKey())).trim();
  }

  if (apiKey.length === 0) {
    deps.output.error('gateway key is required');
    return { ok: false, result: { exitCode: EXIT_CODE.validationError } };
  }
  if (options.skipKeyFormatCheck !== true && !INGESTION_KEY_PATTERN.test(apiKey)) {
    deps.output.error('gateway key has invalid format (expected three hyphen-separated parts)');
    return { ok: false, result: { exitCode: EXIT_CODE.validationError } };
  }
  return { ok: true, apiKey };
}
