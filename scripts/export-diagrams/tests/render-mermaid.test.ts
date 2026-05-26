import { expect, test } from 'bun:test';
import { renderMermaid } from 'scripts/export-diagrams/render-mermaid.ts';
import type { MachineConfigLike } from 'scripts/export-diagrams/export-diagrams.types.ts';

test('renders initial transition for a simple sequential machine', () => {
  const config: MachineConfigLike = {
    initial: 'idle',
    states: {
      idle: { on: { GO: { target: 'running' } } },
      running: { on: { STOP: { target: 'idle' } } },
    },
  };
  const result = renderMermaid('demo', config);
  expect(result).toContain('stateDiagram-v2');
  expect(result).toContain('[*] --> idle');
  expect(result).toContain('idle --> running: GO');
  expect(result).toContain('running --> idle: STOP');
});

test('renders final states with -> [*]', () => {
  const config: MachineConfigLike = {
    initial: 'a',
    states: {
      a: { on: { NEXT: { target: 'b' } } },
      b: { type: 'final' },
    },
  };
  const result = renderMermaid('demo', config);
  expect(result).toContain('b --> [*]');
});

test('renders parallel-region children as nested states', () => {
  const config: MachineConfigLike = {
    states: {
      auth: {
        initial: 'absent',
        states: {
          absent: { on: { TRIGGER: { target: 'present' } } },
          present: {},
        },
      },
    },
  };
  const result = renderMermaid('demo', config);
  expect(result).toContain('state auth {');
  expect(result).toContain('[*] --> absent');
  expect(result).toContain('absent --> present: TRIGGER');
});

test('renders always transitions with always label', () => {
  const config: MachineConfigLike = {
    initial: 'start',
    states: {
      start: { always: { target: 'finish', guard: 'isReady' } },
      finish: { type: 'final' },
    },
  };
  const result = renderMermaid('demo', config);
  expect(result).toContain('start --> finish: always [isReady]');
});

test('renders invoke onDone transitions', () => {
  const config: MachineConfigLike = {
    initial: 'fetching',
    states: {
      fetching: {
        invoke: { src: 'fetch', onDone: { target: 'done' } },
      },
      done: { type: 'final' },
    },
  };
  const result = renderMermaid('demo', config);
  expect(result).toContain('fetching --> done: onDone');
});

test('lists multiple guarded transitions on the same event', () => {
  const config: MachineConfigLike = {
    initial: 'checking',
    states: {
      checking: {
        on: {
          EVAL: [{ target: 'a', guard: 'isA' }, { target: 'b', guard: 'isB' }, { target: 'c' }],
        },
      },
      a: {},
      b: {},
      c: {},
    },
  };
  const result = renderMermaid('demo', config);
  expect(result).toContain('checking --> a: EVAL [isA]');
  expect(result).toContain('checking --> b: EVAL [isB]');
  expect(result).toContain('checking --> c: EVAL');
});
