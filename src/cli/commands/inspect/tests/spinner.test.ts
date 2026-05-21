import { expect, test } from 'bun:test';

import { createSpinner } from 'cli/commands/inspect/spinner.ts';

function makeWriter(): { writes: string[]; write: (text: string) => void } {
  const writes: string[] = [];
  return {
    writes,
    write: (text: string): void => {
      writes.push(text);
    },
  };
}

test('createSpinner: non-tty writes nothing', () => {
  const writer = makeWriter();
  const spinner = createSpinner(writer, false);
  spinner.start('init');
  spinner.update('scanning');
  spinner.stop();
  expect(writer.writes).toHaveLength(0);
});

test('createSpinner: tty writes frames and animates', async () => {
  const writer = makeWriter();
  const spinner = createSpinner(writer, true);
  spinner.start('init');
  spinner.update('scanning claude');
  await new Promise((resolve) => setTimeout(resolve, 160));
  spinner.stop();
  expect(writer.writes[0]).toBe('\x1B[?25l');
  expect(writer.writes.some((s) => s.includes('scanning claude'))).toBe(true);
  expect(writer.writes.length).toBeGreaterThan(3);
});

test('createSpinner: tty stop without start is safe', () => {
  const writer = makeWriter();
  const spinner = createSpinner(writer, true);
  spinner.stop();
  expect(writer.writes).toEqual(['\r\x1B[K\x1B[?25h']);
});
