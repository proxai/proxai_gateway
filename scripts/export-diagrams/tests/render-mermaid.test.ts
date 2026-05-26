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

test('renders top-level on transitions as wildcard sources', () => {
  const config: MachineConfigLike = {
    initial: 'a',
    states: { a: {} },
    on: {
      RESET: { target: 'a' },
    },
  };
  const result = renderMermaid('demo', config);
  expect(result).toContain('[*] --> a: RESET');
});

test('renders invoke onError transitions', () => {
  const config: MachineConfigLike = {
    initial: 'fetching',
    states: {
      fetching: {
        invoke: { src: 'fetch', onError: { target: 'failed' } },
      },
      failed: { type: 'final' },
    },
  };
  const result = renderMermaid('demo', config);
  expect(result).toContain('fetching --> failed: onError');
});

test('renders final and always inside a nested state', () => {
  const config: MachineConfigLike = {
    initial: 'parent',
    states: {
      parent: {
        initial: 'child',
        states: {
          child: { always: { target: 'leaf', guard: 'ready' } },
          leaf: { type: 'final' },
        },
      },
    },
  };
  const result = renderMermaid('demo', config);
  expect(result).toContain('leaf --> [*]');
  expect(result).toContain('child --> leaf: always [ready]');
});

test('renders guard as object with type', () => {
  const config: MachineConfigLike = {
    initial: 'checking',
    states: {
      checking: {
        on: {
          EVAL: { target: 'done', guard: { type: 'isReady' } },
        },
      },
      done: {},
    },
  };
  const result = renderMermaid('demo', config);
  expect(result).toContain('checking --> done: EVAL [isReady]');
});

test('renders guard as object without type as guarded', () => {
  const config: MachineConfigLike = {
    initial: 'checking',
    states: {
      checking: {
        on: {
          EVAL: { target: 'done', guard: {} },
        },
      },
      done: {},
    },
  };
  const result = renderMermaid('demo', config);
  expect(result).toContain('checking --> done: EVAL [guarded]');
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
