import { expect, test } from 'bun:test';
import { startKeyHandler } from 'cli/commands/status/key-handler.ts';
import type { ReadableInputStream } from 'cli/commands/status/key-handler.types.ts';

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);

interface FakeStream extends ReadableInputStream {
  emit(chunk: string): void;
  rawMode: boolean;
  resumed: boolean;
  paused: boolean;
}

function makeFakeStream(): FakeStream {
  const handlers: ((chunk: Buffer) => void)[] = [];
  const fake: FakeStream = {
    isTTY: true,
    rawMode: false,
    resumed: false,
    paused: false,
    setRawMode(value: boolean): void {
      this.rawMode = value;
    },
    on(event, listener): unknown {
      if (event === 'data') handlers.push(listener);
      return this;
    },
    off(event, listener): unknown {
      if (event === 'data') {
        const idx = handlers.indexOf(listener);
        if (idx >= 0) handlers.splice(idx, 1);
      }
      return this;
    },
    resume(): void {
      this.resumed = true;
    },
    pause(): void {
      this.paused = true;
    },
    emit(chunk: string): void {
      for (const h of handlers) h(Buffer.from(chunk, 'utf8'));
    },
  };
  return fake;
}

test('pressing q invokes onQuit', () => {
  const stream = makeFakeStream();
  let quits = 0;
  const handle = startKeyHandler({ stdin: stream, onQuit: () => quits++ });
  stream.emit('q');
  expect(quits).toBe(1);
  handle.stop();
});

test('pressing escape invokes onQuit', () => {
  const stream = makeFakeStream();
  let quits = 0;
  const handle = startKeyHandler({ stdin: stream, onQuit: () => quits++ });
  stream.emit(ESC);
  expect(quits).toBe(1);
  handle.stop();
});

test('pressing Ctrl+C invokes onQuit', () => {
  const stream = makeFakeStream();
  let quits = 0;
  const handle = startKeyHandler({ stdin: stream, onQuit: () => quits++ });
  stream.emit(CTRL_C);
  expect(quits).toBe(1);
  handle.stop();
});

test('pressing Ctrl+D invokes onQuit', () => {
  const stream = makeFakeStream();
  let quits = 0;
  const handle = startKeyHandler({ stdin: stream, onQuit: () => quits++ });
  stream.emit(CTRL_D);
  expect(quits).toBe(1);
  handle.stop();
});

test('pressing other keys does not invoke onQuit', () => {
  const stream = makeFakeStream();
  let quits = 0;
  const handle = startKeyHandler({ stdin: stream, onQuit: () => quits++ });
  stream.emit('a');
  stream.emit('A');
  stream.emit('\r');
  stream.emit(' ');
  expect(quits).toBe(0);
  handle.stop();
});

test('raw mode is set on start and restored on stop', () => {
  const stream = makeFakeStream();
  const handle = startKeyHandler({ stdin: stream, onQuit: () => {} });
  expect(stream.rawMode).toBe(true);
  expect(stream.resumed).toBe(true);
  handle.stop();
  expect(stream.rawMode).toBe(false);
  expect(stream.paused).toBe(true);
});

test('onQuit only fires once even after multiple quit keys', () => {
  const stream = makeFakeStream();
  let quits = 0;
  const handle = startKeyHandler({ stdin: stream, onQuit: () => quits++ });
  stream.emit('q');
  stream.emit('q');
  stream.emit(CTRL_C);
  expect(quits).toBe(1);
  handle.stop();
});
