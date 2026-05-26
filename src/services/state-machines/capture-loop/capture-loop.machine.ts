import { assign, setup } from 'xstate';
import type {
  CaptureLoopContext,
  CaptureLoopEvent,
  CaptureLoopInput,
} from 'services/state-machines/capture-loop/capture-loop.types.ts';

export const captureLoopMachine = setup({
  types: {
    context: {} as CaptureLoopContext,
    events: {} as CaptureLoopEvent,
    input: {} as CaptureLoopInput,
  },
}).createMachine({
  id: 'capture-loop',
  initial: 'waiting',
  context: ({ input }) => ({
    intervalMs: input.intervalMs,
    cyclesCompleted: 0,
    cyclesSkipped: 0,
    lastCycleAtUtc: null,
    lastCycleDurationMs: null,
    lastSkipReason: null,
    lastBatchesEmitted: 0,
    lastQuarantineEmitted: 0,
    pendingBytes: null,
    bufferFull: false,
  }),
  states: {
    waiting: {
      on: {
        TICK: {
          target: 'evaluating_gate',
          actions: assign({
            lastCycleAtUtc: ({ event }) => event.startedAtUtc,
            lastSkipReason: () => null,
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
          target: 'running_cycle',
        },
      },
    },
    running_cycle: {
      on: {
        POLL_COMPLETE: {
          target: 'committing',
          actions: assign({
            lastBatchesEmitted: ({ event }) => event.batchesEmitted,
            lastQuarantineEmitted: ({ event }) => event.quarantineEmitted,
          }),
        },
      },
    },
    committing: {
      on: {
        COMMITTED: {
          target: 'checking_pressure',
        },
      },
    },
    checking_pressure: {
      on: {
        PRESSURE_EVALUATED: {
          target: 'persisting_metrics',
          actions: assign({
            pendingBytes: ({ event }) => event.pendingBytes,
            bufferFull: ({ event }) => event.shouldPause,
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

export type CaptureLoopMachine = typeof captureLoopMachine;
