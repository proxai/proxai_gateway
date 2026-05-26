import { startKeyHandler } from 'cli/commands/status/key-handler.ts';
import {
  CLEAR_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
  STATUS_REFRESH_INTERVAL_MS,
} from 'cli/commands/status/status.constants.ts';
import type { WatchLoopDeps, WatchLoopHandle } from 'cli/commands/status/watch-loop.types.ts';

export function startWatchLoop(deps: WatchLoopDeps): WatchLoopHandle {
  const intervalMs = deps.intervalMs ?? STATUS_REFRESH_INTERVAL_MS;
  const clearScreen = deps.clearScreen ?? true;
  let stopped = false;
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimeout(scheduled);
    keyHandler.stop();
    if (clearScreen) deps.output.info(SHOW_CURSOR);
    if (resolveDone !== null) resolveDone();
  };

  const keyHandler = startKeyHandler({ stdin: deps.stdin, onQuit: cleanup });

  if (clearScreen) deps.output.info(HIDE_CURSOR);

  let scheduled: ReturnType<typeof setTimeout> = setTimeout(() => {}, 0);
  clearTimeout(scheduled);

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const inputs = await deps.gatherFrame();
      if (stopped) return;
      const rendered = deps.render(inputs);
      const screen = clearScreen ? CLEAR_SCREEN + rendered : rendered;
      deps.output.info(screen);
    } catch (err) {
      if (!stopped) {
        deps.output.error(err instanceof Error ? err.message : String(err));
      }
    }
    if (!stopped) {
      scheduled = setTimeout(() => {
        void tick();
      }, intervalMs);
    }
  };

  void tick();

  return {
    wait: () => done,
    stop: async () => {
      cleanup();
      await done;
    },
  };
}
