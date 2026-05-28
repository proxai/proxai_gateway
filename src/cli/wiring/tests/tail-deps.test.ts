import { expect, test } from 'bun:test';

import { buildTailDeps, buildTailOptions } from 'cli/wiring/tail-deps.ts';

const ORIGINAL_LOG = console.log;
test('buildTailDeps: wires logDir, abortSignal, output; emit forwards to console.log', () => {
  const ctrl = new AbortController();
  const deps = buildTailDeps({ logDir: '/tmp/logs', abortSignal: ctrl.signal });
  expect(deps.logDir).toBe('/tmp/logs');
  expect(deps.abortSignal).toBe(ctrl.signal);
  const captured: string[] = [];
  console.log = (line?: string): void => {
    captured.push(String(line));
  };
  try {
    deps.emit('line');
  } finally {
    console.log = ORIGINAL_LOG;
  }
  expect(captured).toEqual(['line']);
});

test('buildTailOptions: returns empty when nothing set', () => {
  expect(buildTailOptions({})).toEqual({});
});

test('buildTailOptions: forwards each flag', () => {
  const out = buildTailOptions({
    lines: '100',
    static: true,
    source: 'codex',
    level: 'warn',
    since: '1h',
    raw: true,
  });
  expect(out).toEqual({
    lines: 100,
    static: true,
    source: 'codex',
    level: 'warn',
    since: '1h',
    raw: true,
  });
});

test('buildTailOptions: omits flags that are false or undefined', () => {
  expect(buildTailOptions({ static: false, raw: false })).toEqual({});
});
