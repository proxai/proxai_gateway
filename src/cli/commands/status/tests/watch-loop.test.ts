import { expect, test } from 'bun:test';
import { startWatchLoop } from 'cli/commands/status/watch-loop.ts';
import type { ReadableInputStream } from 'cli/commands/status/key-handler.types.ts';
import type { RenderInputs } from 'cli/commands/status/render/render.types.ts';

interface FakeStream extends ReadableInputStream {
  emit(chunk: string): void;
}

function makeStream(): FakeStream {
  const handlers: ((c: Buffer) => void)[] = [];
  const fake: FakeStream = {
    isTTY: false,
    on(event, listener): unknown {
      if (event === 'data') handlers.push(listener);
      return this;
    },
    off(event, listener): unknown {
      if (event === 'data') {
        const i = handlers.indexOf(listener);
        if (i >= 0) handlers.splice(i, 1);
      }
      return this;
    },
    emit(chunk): void {
      for (const h of handlers) h(Buffer.from(chunk));
    },
  };
  return fake;
}

function makeOutput(): {
  calls: string[];
  output: {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
    success: (m: string) => void;
  };
} {
  const calls: string[] = [];
  return {
    calls,
    output: {
      info: (m: string) => calls.push(m),
      warn: (m: string) => calls.push(`WARN ${m}`),
      error: (m: string) => calls.push(`ERR ${m}`),
      success: (m: string) => calls.push(`OK ${m}`),
    },
  };
}

function frameInputs(): RenderInputs {
  return {
    summary: { level: 'ok', headline: 'all good', hint: null },
    snapshot: null,
    notConfigured: false,
    isDevMode: false,
    nowLocal: new Date('2026-05-25T12:00:00Z'),
    version: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test('watch loop renders at least once and quits on q', async () => {
  const stream = makeStream();
  const { calls, output } = makeOutput();
  let renderCount = 0;
  const handle = startWatchLoop({
    output,
    stdin: stream,
    intervalMs: 1000,
    clearScreen: false,
    render: () => {
      renderCount++;
      return `frame ${renderCount.toString()}`;
    },
    gatherFrame: async () => frameInputs(),
  });
  await sleep(50);
  expect(renderCount).toBeGreaterThanOrEqual(1);
  stream.emit('q');
  await handle.wait();
  const initial = renderCount;
  await sleep(100);
  expect(renderCount).toBe(initial);
  expect(calls.length).toBeGreaterThanOrEqual(1);
});

test('watch loop re-renders on each interval', async () => {
  const stream = makeStream();
  const { output } = makeOutput();
  let renderCount = 0;
  const handle = startWatchLoop({
    output,
    stdin: stream,
    intervalMs: 30,
    clearScreen: false,
    render: () => `frame ${(++renderCount).toString()}`,
    gatherFrame: async () => frameInputs(),
  });
  await sleep(120);
  stream.emit('q');
  await handle.wait();
  expect(renderCount).toBeGreaterThanOrEqual(3);
});

test('watch loop quits on Ctrl+C', async () => {
  const stream = makeStream();
  const { output } = makeOutput();
  const handle = startWatchLoop({
    output,
    stdin: stream,
    intervalMs: 1000,
    clearScreen: false,
    render: () => 'frame',
    gatherFrame: async () => frameInputs(),
  });
  await sleep(20);
  stream.emit(String.fromCharCode(3));
  await handle.wait();
  expect(true).toBe(true);
});

test('handle.stop() causes the loop to exit cleanly without sending a quit key', async () => {
  const stream = makeStream();
  const { output } = makeOutput();
  let renderCount = 0;
  const handle = startWatchLoop({
    output,
    stdin: stream,
    intervalMs: 30,
    clearScreen: false,
    render: () => `frame ${(++renderCount).toString()}`,
    gatherFrame: async () => frameInputs(),
  });
  await sleep(60);
  await handle.stop();
  const after = renderCount;
  await sleep(100);
  expect(renderCount).toBe(after);
});

test('gatherFrame errors are surfaced via output.error and loop keeps trying', async () => {
  const stream = makeStream();
  const { calls, output } = makeOutput();
  let count = 0;
  const handle = startWatchLoop({
    output,
    stdin: stream,
    intervalMs: 25,
    clearScreen: false,
    render: () => 'frame',
    gatherFrame: async () => {
      count++;
      if (count === 1) throw new Error('boom');
      return frameInputs();
    },
  });
  await sleep(120);
  stream.emit('q');
  await handle.wait();
  expect(calls.some((c) => c.startsWith('ERR'))).toBe(true);
  expect(count).toBeGreaterThanOrEqual(2);
});
