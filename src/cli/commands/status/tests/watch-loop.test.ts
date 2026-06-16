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
    isLocalBuild: false,
    binaryPath: null,
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

test('watch loop clears screen and paints frame when clearScreen is true', async () => {
  const stream = makeStream();
  const { calls, output } = makeOutput();
  const handle = startWatchLoop({
    output,
    stdin: stream,
    intervalMs: 1000,
    clearScreen: true,
    render: () => 'hello\nworld',
    gatherFrame: async () => frameInputs(),
  });
  await sleep(50);
  stream.emit('q');
  await handle.wait();

  expect(calls.some((c) => c.includes('\x1b[?1049h'))).toBe(true);
  expect(calls.some((c) => c.includes('\x1b[?1049l'))).toBe(true);
  expect(calls.some((c) => c.includes('hello'))).toBe(true);
});

interface FakeStreamWithRawMode extends FakeStream {
  isTTY: true;
  setRawMode(mode: boolean): void;
  rawModeHistory: boolean[];
}

function makeStreamWithRawMode(): FakeStreamWithRawMode {
  const rawModeHistory: boolean[] = [];
  const base = makeStream();
  return {
    ...base,
    isTTY: true,
    rawModeHistory,
    setRawMode(mode: boolean): void {
      rawModeHistory.push(mode);
    },
  };
}

test('watch loop registers and unregisters signal/exception hooks', async () => {
  const originalOn = process.on;
  const originalOff = process.off;

  const registered: Record<string, unknown[]> = {};
  const unregistered: Record<string, unknown[]> = {};

  process.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (!registered[event]) registered[event] = [];
    registered[event].push(listener);
    return process;
  }) as unknown as typeof process.on;

  process.off = ((event: string, listener: (...args: unknown[]) => void) => {
    if (!unregistered[event]) unregistered[event] = [];
    unregistered[event].push(listener);
    return process;
  }) as unknown as typeof process.off;

  try {
    const stream = makeStreamWithRawMode();
    const { output } = makeOutput();
    const handle = startWatchLoop({
      output,
      stdin: stream,
      intervalMs: 1000,
      clearScreen: true,
      render: () => 'hello',
      gatherFrame: async () => frameInputs(),
    });

    await sleep(20);

    expect(registered['SIGINT']?.length).toBe(1);
    expect(registered['SIGTERM']?.length).toBe(1);
    expect(registered['SIGHUP']?.length).toBe(1);
    expect(registered['uncaughtException']?.length).toBe(1);

    await handle.stop();

    expect(unregistered['SIGINT']?.length).toBe(1);
    expect(unregistered['SIGTERM']?.length).toBe(1);
    expect(unregistered['SIGHUP']?.length).toBe(1);
    expect(unregistered['uncaughtException']?.length).toBe(1);

    expect(stream.rawModeHistory).toEqual([true, false]);
  } finally {
    process.on = originalOn;
    process.off = originalOff;
  }
});

test('watch loop handles SIGINT by restoring terminal state and triggering signal', async () => {
  const originalOn = process.on;
  const originalOff = process.off;
  const originalKill = process.kill;
  const originalExit = process.exit;

  const registered: Record<string, ((...args: unknown[]) => void)[]> = {};
  let killCalled: { pid: number; signal: string } | null = null;
  let exitCalledWith: number | null = null;

  process.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (!registered[event]) registered[event] = [];
    registered[event].push(listener as (...args: unknown[]) => void);
    return process;
  }) as unknown as typeof process.on;

  process.off = (() => process) as unknown as typeof process.off;
  process.kill = ((pid: number, signal: string) => {
    killCalled = { pid, signal };
    return true;
  }) as unknown as typeof process.kill;
  process.exit = ((code?: number) => {
    exitCalledWith = code ?? 0;
    return undefined as never;
  }) as unknown as typeof process.exit;

  try {
    const stream = makeStreamWithRawMode();
    const { calls, output } = makeOutput();
    const handle = startWatchLoop({
      output,
      stdin: stream,
      intervalMs: 1000,
      clearScreen: true,
      render: () => 'hello',
      gatherFrame: async () => frameInputs(),
    });

    await sleep(20);

    const sigintListener = registered['SIGINT']?.[0];
    expect(sigintListener).toBeDefined();

    if (sigintListener) {
      sigintListener();
    }

    expect(calls.some((c) => c.includes('\x1b[?1049l'))).toBe(true);
    expect(stream.rawModeHistory).toEqual([true, false]);

    expect(killCalled as unknown).toEqual({ pid: process.pid, signal: 'SIGINT' });
    expect(exitCalledWith as unknown).toBe(null);

    await handle.stop();
  } finally {
    process.on = originalOn;
    process.off = originalOff;
    process.kill = originalKill;
    process.exit = originalExit;
  }
});

test('watch loop handles SIGTERM by restoring terminal state and triggering signal', async () => {
  const originalOn = process.on;
  const originalOff = process.off;
  const originalKill = process.kill;
  const originalExit = process.exit;

  const registered: Record<string, ((...args: unknown[]) => void)[]> = {};
  let killCalled: { pid: number; signal: string } | null = null;
  let exitCalledWith: number | null = null;

  process.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (!registered[event]) registered[event] = [];
    registered[event].push(listener as (...args: unknown[]) => void);
    return process;
  }) as unknown as typeof process.on;

  process.off = (() => process) as unknown as typeof process.off;
  process.kill = ((pid: number, signal: string) => {
    killCalled = { pid, signal };
    return true;
  }) as unknown as typeof process.kill;
  process.exit = ((code?: number) => {
    exitCalledWith = code ?? 0;
    return undefined as never;
  }) as unknown as typeof process.exit;

  try {
    const stream = makeStreamWithRawMode();
    const { calls, output } = makeOutput();
    const handle = startWatchLoop({
      output,
      stdin: stream,
      intervalMs: 1000,
      clearScreen: true,
      render: () => 'hello',
      gatherFrame: async () => frameInputs(),
    });

    await sleep(20);

    const sigtermListener = registered['SIGTERM']?.[0];
    expect(sigtermListener).toBeDefined();

    if (sigtermListener) {
      sigtermListener();
    }

    expect(calls.some((c) => c.includes('\x1b[?1049l'))).toBe(true);
    expect(stream.rawModeHistory).toEqual([true, false]);
    expect(killCalled as unknown).toEqual({ pid: process.pid, signal: 'SIGTERM' });
    expect(exitCalledWith as unknown).toBe(null);

    await handle.stop();
  } finally {
    process.on = originalOn;
    process.off = originalOff;
    process.kill = originalKill;
    process.exit = originalExit;
  }
});

test('watch loop handles SIGHUP by restoring terminal state and triggering signal', async () => {
  const originalOn = process.on;
  const originalOff = process.off;
  const originalKill = process.kill;
  const originalExit = process.exit;

  const registered: Record<string, ((...args: unknown[]) => void)[]> = {};
  let killCalled: { pid: number; signal: string } | null = null;
  let exitCalledWith: number | null = null;

  process.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (!registered[event]) registered[event] = [];
    registered[event].push(listener as (...args: unknown[]) => void);
    return process;
  }) as unknown as typeof process.on;

  process.off = (() => process) as unknown as typeof process.off;
  process.kill = ((pid: number, signal: string) => {
    killCalled = { pid, signal };
    return true;
  }) as unknown as typeof process.kill;
  process.exit = ((code?: number) => {
    exitCalledWith = code ?? 0;
    return undefined as never;
  }) as unknown as typeof process.exit;

  try {
    const stream = makeStreamWithRawMode();
    const { calls, output } = makeOutput();
    const handle = startWatchLoop({
      output,
      stdin: stream,
      intervalMs: 1000,
      clearScreen: true,
      render: () => 'hello',
      gatherFrame: async () => frameInputs(),
    });

    await sleep(20);

    const sighupListener = registered['SIGHUP']?.[0];
    expect(sighupListener).toBeDefined();

    if (sighupListener) {
      sighupListener();
    }

    expect(calls.some((c) => c.includes('\x1b[?1049l'))).toBe(true);
    expect(stream.rawModeHistory).toEqual([true, false]);
    expect(killCalled as unknown).toEqual({ pid: process.pid, signal: 'SIGHUP' });
    expect(exitCalledWith as unknown).toBe(null);

    await handle.stop();
  } finally {
    process.on = originalOn;
    process.off = originalOff;
    process.kill = originalKill;
    process.exit = originalExit;
  }
});

test('watch loop handles kill error by calling process.exit(1)', async () => {
  const originalOn = process.on;
  const originalOff = process.off;
  const originalKill = process.kill;
  const originalExit = process.exit;

  const registered: Record<string, ((...args: unknown[]) => void)[]> = {};
  let exitCalledWith: number | null = null;

  process.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (!registered[event]) registered[event] = [];
    registered[event].push(listener as (...args: unknown[]) => void);
    return process;
  }) as unknown as typeof process.on;

  process.off = (() => process) as unknown as typeof process.off;
  process.kill = (() => {
    throw new Error('kill failed');
  }) as unknown as typeof process.kill;
  process.exit = ((code?: number) => {
    exitCalledWith = code ?? 0;
    return undefined as never;
  }) as unknown as typeof process.exit;

  try {
    const stream = makeStreamWithRawMode();
    const { output } = makeOutput();
    const handle = startWatchLoop({
      output,
      stdin: stream,
      intervalMs: 1000,
      clearScreen: true,
      render: () => 'hello',
      gatherFrame: async () => frameInputs(),
    });

    await sleep(20);

    const sigintListener = registered['SIGINT']?.[0];
    expect(sigintListener).toBeDefined();

    if (sigintListener) {
      sigintListener();
    }

    expect(exitCalledWith as unknown).toBe(1);

    await handle.stop();
  } finally {
    process.on = originalOn;
    process.off = originalOff;
    process.kill = originalKill;
    process.exit = originalExit;
  }
});

test('watch loop handles uncaughtException by restoring terminal state and exiting with 1', async () => {
  const originalOn = process.on;
  const originalOff = process.off;
  const originalExit = process.exit;
  const originalConsoleError = console.error;

  const registered: Record<string, ((...args: unknown[]) => void)[]> = {};
  let exitCalledWith: number | null = null;
  let consoleErrorCalledWith: unknown = null;

  process.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (!registered[event]) registered[event] = [];
    registered[event].push(listener as (...args: unknown[]) => void);
    return process;
  }) as unknown as typeof process.on;

  process.off = (() => process) as unknown as typeof process.off;
  process.exit = ((code?: number) => {
    exitCalledWith = code ?? 0;
    return undefined as never;
  }) as unknown as typeof process.exit;

  console.error = (arg: unknown) => {
    consoleErrorCalledWith = arg;
  };

  try {
    const stream = makeStreamWithRawMode();
    const { calls, output } = makeOutput();
    const handle = startWatchLoop({
      output,
      stdin: stream,
      intervalMs: 1000,
      clearScreen: true,
      render: () => 'hello',
      gatherFrame: async () => frameInputs(),
    });

    await sleep(20);

    const uncaughtListener = registered['uncaughtException']?.[0];
    expect(uncaughtListener).toBeDefined();

    const testError = new Error('test uncaught error');
    if (uncaughtListener) {
      uncaughtListener(testError);
    }

    expect(calls.some((c) => c.includes('\x1b[?1049l'))).toBe(true);
    expect(stream.rawModeHistory).toEqual([true, false]);
    expect(exitCalledWith as unknown).toBe(1);
    expect(consoleErrorCalledWith).toBe(testError);

    await handle.stop();
  } finally {
    process.on = originalOn;
    process.off = originalOff;
    process.exit = originalExit;
    console.error = originalConsoleError;
  }
});
