import { deriveHostId, readMachineUuid as defaultReadMachineUuid } from 'core/system';
import { AuthError, GatewayError } from 'core/utils';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';

import type { SetupCommandDeps } from 'cli/commands/setup/setup.types.ts';

export type VerifyAndRegisterResult =
  | { ok: true; userId: string; hostId: string }
  | { ok: false; result: CommandResult };

export async function verifyAndRegister(
  deps: SetupCommandDeps,
  apiKey: string,
  isReplace: boolean,
  previous: { hostId: string | null; userId: string | null },
): Promise<VerifyAndRegisterResult> {
  const http = deps.httpClientFactory(apiKey, '');
  let userId: string;
  try {
    const verification = await http.verifyKey();
    if (!verification.success) {
      deps.output.error(
        verification.message.length > 0
          ? `ingestion key not accepted: ${verification.message}`
          : 'ingestion key not accepted',
      );
      return { ok: false, result: { exitCode: EXIT_CODE.authError } };
    }
    if (verification.userId === null || verification.userId.length === 0) {
      deps.output.error('verify-key response missing user id; cannot derive stable host_id');
      return { ok: false, result: { exitCode: EXIT_CODE.authError } };
    }
    userId = verification.userId;
  } catch (err) {
    if (err instanceof AuthError) {
      deps.output.error('ingestion key rejected by server (invalid, revoked, or wrong type)');
      return { ok: false, result: { exitCode: EXIT_CODE.authError } };
    }
    deps.output.error(formatError('verify-key failed', err));
    return { ok: false, result: { exitCode: EXIT_CODE.error } };
  }

  let machineUuid: string;
  try {
    machineUuid = await (deps.readMachineUuid ?? defaultReadMachineUuid)();
  } catch (err) {
    deps.output.error(formatError('failed to read machine UUID', err));
    return { ok: false, result: { exitCode: EXIT_CODE.error } };
  }
  const hostId = deriveHostId(machineUuid, userId);

  if (isReplace && previous.hostId !== null && previous.userId !== null) {
    if (previous.userId === userId && previous.hostId === hostId) {
      deps.output.info('host_id stable (same machine, same user)');
    } else if (previous.userId !== userId) {
      deps.output.info('host_id rederived for new user');
    } else {
      deps.output.info('host_id rederived from machine UUID');
    }
  }

  const httpForRegister = deps.httpClientFactory(apiKey, hostId);
  try {
    const registration = await httpForRegister.registerHostId();
    if (registration.registered) {
      deps.output.info(`host_id bound on backend (host_id: ${hostId})`);
    } else {
      deps.output.info('host_id already bound on backend');
    }
  } catch (err) {
    if (err instanceof AuthError) {
      deps.output.error(
        'this ingestion key is already bound to another machine; create a new ingestion key on https://proxai.co for this machine',
      );
      return { ok: false, result: { exitCode: EXIT_CODE.authError } };
    }
    deps.output.error(formatError('host_id registration failed', err));
    return { ok: false, result: { exitCode: EXIT_CODE.error } };
  }

  return { ok: true, userId, hostId };
}

function formatError(prefix: string, err: unknown): string {
  if (err instanceof GatewayError) return `${prefix}: ${err.message}`;
  return `${prefix}: ${(err as Error).message ?? String(err)}`;
}
