import { assign, setup } from 'xstate';
import type {
  DrainLoopContext,
  DrainLoopEvent,
  DrainLoopInput,
} from 'services/state-machines/drain-loop/drain-loop.types.ts';

export const drainLoopMachine = setup({
  types: {
    context: {} as DrainLoopContext,
    events: {} as DrainLoopEvent,
    input: {} as DrainLoopInput,
  },
}).createMachine({
  id: 'drain-loop',
  initial: 'waiting',
  context: ({ input }) => ({
    intervalMs: input.intervalMs,
    cyclesCompleted: 0,
    cyclesSkipped: 0,
    lastCycleAtUtc: null,
    lastCycleDurationMs: null,
    lastSkipReason: null,
    lastAccepted: 0,
    lastRetriable: 0,
    lastFatal: 0,
    lastRecovered: 0,
    lastAcceptedBytes: 0,
    consecutiveRetriableBreak: false,
    bufferFullCleared: false,
  }),
  states: {
    waiting: {
      on: {
        TICK: {
          target: 'evaluating_gate',
          actions: assign({
            lastCycleAtUtc: ({ event }) => event.startedAtUtc,
            lastSkipReason: () => null,
            bufferFullCleared: () => false,
          }),
        },
      },
    },
    evaluating_gate: {
      on: {
        GATE_BLOCKED: {
          target: 'skipped',
          actions: assign({
            cyclesSkipped: ({ context }) => context.cyclesSkipped + 1,
            lastSkipReason: ({ event }) => event.reason,
          }),
        },
        GATE_CLEAR: {
          target: 'draining',
        },
      },
    },
    draining: {
      on: {
        DRAIN_COMPLETE: {
          target: 'pruning',
          actions: assign({
            lastAccepted: ({ event }) => event.accepted,
            lastRetriable: ({ event }) => event.retriable,
            lastFatal: ({ event }) => event.fatal,
            lastRecovered: ({ event }) => event.recovered,
            lastAcceptedBytes: ({ event }) => event.acceptedBytes,
            consecutiveRetriableBreak: ({ event }) => event.consecutiveRetriableBreak,
          }),
        },
      },
    },
    pruning: {
      on: {
        PRUNE_COMPLETE: {
          target: 'checking_resume',
        },
      },
    },
    checking_resume: {
      on: {
        RESUME_EVALUATED: {
          target: 'persisting_metrics',
          actions: assign({
            bufferFullCleared: ({ event }) => event.clearedBufferFull,
          }),
        },
      },
    },
    persisting_metrics: {
      on: {
        METRICS_PERSISTED: {
          target: 'waiting',
          actions: assign({
            cyclesCompleted: ({ context }) => context.cyclesCompleted + 1,
            lastCycleDurationMs: ({ event }) => event.durationMs,
          }),
        },
      },
    },
    skipped: {
      on: {
        METRICS_PERSISTED: {
          target: 'waiting',
          actions: assign({
            lastCycleDurationMs: ({ event }) => event.durationMs,
          }),
        },
      },
    },
  },
});

export type DrainLoopMachine = typeof drainLoopMachine;
