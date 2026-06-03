import { startKeyHandler } from 'cli/commands/status/key-handler.ts';
import {
  CLEAR_TO_END_OF_LINE,
  CLEAR_TO_END_OF_SCREEN,
  CURSOR_HOME,
  ENTER_ALT_BUFFER,
  HIDE_CURSOR,
  LEAVE_ALT_BUFFER,
  SHOW_CURSOR,
  STATUS_REFRESH_INTERVAL_MS,
} from 'cli/commands/status/status.constants.ts';
import type { WatchLoopDeps, WatchLoopHandle } from 'cli/commands/status/watch-loop.types.ts';

export function startWatchLoop(deps: WatchLoopDeps): WatchLoopHandle {
  const intervalMs = deps.intervalMs ?? STATUS_REFRESH_INTERVAL_MS;
  const useAltBuffer = deps.clearScreen ?? true;
  let stopped = false;
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const sigintHandler = (): void => {
    handleSignal('SIGINT');
  };
  const sigtermHandler = (): void => {
    handleSignal('SIGTERM');
  };
  const sighupHandler = (): void => {
    handleSignal('SIGHUP');
  };
  const uncaughtHandler = (err: unknown): void => {
    cleanup();
    console.error(err);
    process.exit(1);
  };

  function removeHooks(): void {
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
    process.off('SIGHUP', sighupHandler);
    process.off('uncaughtException', uncaughtHandler);
  }

  function handleSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void {
    cleanup();
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(1);
    }
  }

  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    removeHooks();
    if (scheduled !== undefined) {
      clearTimeout(scheduled);
    }
    keyHandler.stop();
    if (useAltBuffer) {
      deps.output.info(`${SHOW_CURSOR}${LEAVE_ALT_BUFFER}`);
    }
    if (resolveDone !== null) resolveDone();
  };

  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);
  process.on('SIGHUP', sighupHandler);
  process.on('uncaughtException', uncaughtHandler);

  const keyHandler = startKeyHandler({ stdin: deps.stdin, onQuit: cleanup });

  if (useAltBuffer) {
    deps.output.info(`${ENTER_ALT_BUFFER}${HIDE_CURSOR}${CURSOR_HOME}`);
  }

  let scheduled: ReturnType<typeof setTimeout> | undefined = undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const inputs = await deps.gatherFrame();
      if (stopped) return;
      const rendered = deps.render(inputs);
      if (useAltBuffer) {
        deps.output.info(paintFrame(rendered));
      } else {
        deps.output.info(rendered);
      }
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

export function paintFrame(rendered: string): string {
  const lines = rendered.split('\n');
  const painted = lines.map((line) => `${line}${CLEAR_TO_END_OF_LINE}`).join('\n');
  return `${CURSOR_HOME}${painted}${CLEAR_TO_END_OF_SCREEN}`;
}
