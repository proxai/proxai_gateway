import { assign, setup } from 'xstate';
import type {
  UninstallContext,
  UninstallEvent,
  UninstallInput,
} from 'services/state-machines/uninstall/uninstall.types.ts';

export const uninstallMachine = setup({
  types: {
    context: {} as UninstallContext,
    events: {} as UninstallEvent,
    input: {} as UninstallInput,
  },
}).createMachine({
  id: 'uninstall',
  initial: 'idle',
  context: ({ input }) => ({
    resetMode: input.resetMode,
    serviceStopped: false,
    pathsSwept: 0,
    bufferRemoved: false,
    sentinelsRemoved: 0,
    lastError: null,
  }),
  on: {
    ERROR: {
      target: '.failed',
      actions: assign({ lastError: ({ event }) => event.message }),
    },
  },
  states: {
    idle: {
      on: { BEGIN: { target: 'stopping_service' } },
    },
    stopping_service: {
      on: {
        SERVICE_STOPPED: {
          target: 'sweeping_paths',
          actions: assign({ serviceStopped: () => true }),
        },
      },
    },
    sweeping_paths: {
      on: {
        PATHS_SWEPT: {
          target: 'removing_buffer',
          actions: assign({ pathsSwept: ({ event }) => event.count }),
        },
      },
    },
    removing_buffer: {
      on: {
        BUFFER_REMOVED: {
          target: 'removing_sentinels',
          actions: assign({ bufferRemoved: () => true }),
        },
      },
    },
    removing_sentinels: {
      on: {
        SENTINELS_REMOVED: {
          target: 'done',
          actions: assign({ sentinelsRemoved: ({ event }) => event.count }),
        },
      },
    },
    done: { type: 'final' },
    failed: {},
  },
});

export type UninstallMachine = typeof uninstallMachine;
