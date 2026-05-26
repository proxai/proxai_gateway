import { QUIT_KEYS } from 'cli/commands/status/status.constants.ts';
import type { KeyHandlerDeps, KeyHandlerHandle } from 'cli/commands/status/key-handler.types.ts';

export function startKeyHandler(deps: KeyHandlerDeps): KeyHandlerHandle {
  const { stdin, onQuit } = deps;
  let stopped = false;

  if (stdin.isTTY && stdin.setRawMode !== undefined) {
    stdin.setRawMode(true);
  }
  stdin.resume?.();

  const onData = (chunk: Buffer): void => {
    if (stopped) return;
    const str = chunk.toString('utf8');
    if (str.length === 0) return;
    const first = str[0] ?? '';
    if (QUIT_KEYS.includes(first)) {
      stopped = true;
      onQuit();
    }
  };

  stdin.on('data', onData);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      stdin.off('data', onData);
      if (stdin.isTTY && stdin.setRawMode !== undefined) {
        stdin.setRawMode(false);
      }
      stdin.pause?.();
    },
  };
}
