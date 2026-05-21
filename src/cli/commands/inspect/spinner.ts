import chalk from 'chalk';

import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from 'cli/commands/inspect/inspect.constants.ts';

export interface SpinnerWriter {
  write: (text: string) => void;
}

export interface Spinner {
  start: (text: string) => void;
  update: (text: string) => void;
  stop: () => void;
}

export function createSpinner(stdout: SpinnerWriter, isTty: boolean): Spinner {
  let frameIndex = 0;
  let currentText = '';
  let handle: ReturnType<typeof setInterval> | null = null;

  const writeFrame = (): void => {
    stdout.write(`\r${chalk.cyan(SPINNER_FRAMES[frameIndex])} ${currentText}`);
  };

  const advance = (): void => {
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
    writeFrame();
  };

  return {
    start: (text: string): void => {
      currentText = text;
      if (!isTty) return;
      stdout.write('\x1B[?25l');
      handle = setInterval(advance, SPINNER_INTERVAL_MS);
    },
    update: (text: string): void => {
      currentText = text;
      if (!isTty) return;
      stdout.write('\r\x1B[K');
      writeFrame();
    },
    stop: (): void => {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
      if (!isTty) return;
      stdout.write('\r\x1B[K\x1B[?25h');
    },
  };
}
