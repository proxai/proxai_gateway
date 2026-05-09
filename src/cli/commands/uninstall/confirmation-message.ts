import { isDirectBinary } from 'services/uninstall';

import type { UninstallCommandDeps } from 'cli/commands/uninstall/uninstall.types.ts';

const SENTINEL_LIST =
  'PAUSED, AUTH_FAILED, BUFFER_FULL, SESSION_STOPPED, UPDATE_AVAILABLE, CONSENT_ACCEPTED';

export function buildConfirmationMessage(deps: UninstallCommandDeps, reset: boolean): string {
  const execPath = deps.currentExecPath ?? process.execPath;
  const lines: string[] = [];
  lines.push('This will:');
  lines.push('  • stop and unregister the proxai-gateway daemon');
  if (deps.serviceUnitPath !== null) {
    lines.push(`  • remove the service unit at ${deps.serviceUnitPath}`);
  }
  lines.push('  • sweep package-manager installs (npm, pnpm, yarn, bun, brew)');
  if (isDirectBinary(execPath)) {
    lines.push(`  • remove the proxai-gateway binary at ${execPath}`);
  }
  lines.push('  • clean up the PATH entry from your shell rc / Windows User PATH');
  if (reset) {
    lines.push('');
    lines.push('--reset will additionally wipe local state:');
    lines.push(`  • ${deps.configDir}  (config, buffer DB, sentinels: ${SENTINEL_LIST})`);
    lines.push(`  • ${deps.logDir}  (logs)`);
    lines.push('');
    lines.push('Server-side state is preserved. Re-setup will resume cursors from server.');
    lines.push('Pending unuploaded batches will be lost; their bytes will be re-captured.');
  } else {
    lines.push('');
    lines.push('Local state (config, buffer, logs) is preserved.');
    lines.push('Pass --reset to also wipe local state.');
  }
  lines.push('');
  const phrase = reset ? 'uninstall --reset' : 'uninstall';
  lines.push(`Type '${phrase}' to confirm, or leave empty to abort`);
  return lines.join('\n');
}
