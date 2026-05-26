import { assign, setup } from 'xstate';
import type {
  QuarantineLifecycleContext,
  QuarantineLifecycleEvent,
  QuarantineLifecycleInput,
} from 'services/state-machines/quarantine-lifecycle/quarantine-lifecycle.types.ts';

export const quarantineLifecycleMachine = setup({
  types: {
    context: {} as QuarantineLifecycleContext,
    events: {} as QuarantineLifecycleEvent,
    input: {} as QuarantineLifecycleInput,
  },
}).createMachine({
  id: 'quarantine-lifecycle',
  initial: 'quarantined',
  context: ({ input }) => ({
    record: input.record,
    prunedAtUtc: null,
  }),
  states: {
    quarantined: {
      on: {
        PRUNE: {
          target: 'pruned',
          actions: assign({
            prunedAtUtc: ({ event }) => event.prunedAtUtc,
          }),
        },
      },
    },
    pruned: {
      type: 'final',
    },
  },
});

export type QuarantineLifecycleMachine = typeof quarantineLifecycleMachine;
