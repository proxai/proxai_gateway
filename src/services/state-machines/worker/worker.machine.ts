import { assign, setup } from 'xstate';
import type {
  WorkerContext,
  WorkerEvent,
  WorkerInput,
} from 'services/state-machines/worker/worker.types.ts';

export const workerMachine = setup({
  types: {
    context: {} as WorkerContext,
    events: {} as WorkerEvent,
    input: {} as WorkerInput,
  },
}).createMachine({
  id: 'worker',
  initial: 'spawned',
  context: ({ input }) => ({
    sourceApp: input.sourceApp,
    workerId: input.workerId,
    startedAtUtc: null,
    finishedAtUtc: null,
    result: null,
    errorMessage: null,
  }),
  states: {
    spawned: {
      on: {
        BEGIN_RUN: {
          target: 'running',
          actions: assign({
            startedAtUtc: ({ event }) => event.startedAtUtc,
          }),
        },
      },
    },
    running: {
      on: {
        RESULT_POSTED: {
          target: 'posting_result',
          actions: assign({
            result: ({ event }) => event.result,
            finishedAtUtc: ({ event }) => event.finishedAtUtc,
          }),
        },
        ERROR: {
          target: 'errored',
          actions: assign({
            errorMessage: ({ event }) => event.message,
            finishedAtUtc: ({ event }) => event.finishedAtUtc,
          }),
        },
      },
    },
    posting_result: {
      on: {
        TERMINATE: {
          target: 'terminated',
        },
      },
    },
    errored: {
      on: {
        TERMINATE: {
          target: 'terminated',
        },
      },
    },
    terminated: {
      type: 'final',
    },
  },
});

export type WorkerMachine = typeof workerMachine;
