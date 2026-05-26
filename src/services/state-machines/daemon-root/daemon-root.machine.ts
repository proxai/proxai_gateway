import { assign, setup } from 'xstate';
import type {
  DaemonRootContext,
  DaemonRootEvent,
} from 'services/state-machines/daemon-root/daemon-root.types.ts';

export const daemonRootMachine = setup({
  types: {
    context: {} as DaemonRootContext,
    events: {} as DaemonRootEvent,
  },
}).createMachine({
  id: 'daemon-root',
  initial: 'boot',
  context: {
    bootedAtUtc: null,
    exitedAtUtc: null,
    watermarksSynced: false,
    shutdownReason: null,
  },
  states: {
    boot: {
      initial: 'loading_config',
      states: {
        loading_config: {
          on: { CONFIG_LOADED: { target: 'opening_buffer' } },
        },
        opening_buffer: {
          on: { BUFFER_OPENED: { target: 'sync_decision' } },
        },
        sync_decision: {
          on: {
            WATERMARKS_SYNCED: {
              target: 'ready',
              actions: assign({ watermarksSynced: () => true }),
            },
            WATERMARKS_SKIPPED: {
              target: 'ready',
            },
          },
        },
        ready: {
          type: 'final',
        },
      },
      onDone: {
        target: 'running',
      },
    },
    running: {
      on: {
        READY: {
          actions: assign({ bootedAtUtc: ({ event }) => event.bootedAtUtc }),
        },
        SHUTDOWN: {
          target: 'draining_for_shutdown',
          actions: assign({ shutdownReason: ({ event }) => event.reason }),
        },
      },
    },
    draining_for_shutdown: {
      on: {
        DRAIN_FOR_SHUTDOWN_COMPLETE: {
          target: 'exited',
        },
        EXIT: {
          target: 'exited',
          actions: assign({ exitedAtUtc: ({ event }) => event.exitedAtUtc }),
        },
      },
    },
    exited: {
      type: 'final',
      entry: assign({
        exitedAtUtc: ({ context, event }) =>
          event.type === 'EXIT'
            ? event.exitedAtUtc
            : (context.exitedAtUtc ?? new Date().toISOString()),
      }),
    },
  },
});

export type DaemonRootMachine = typeof daemonRootMachine;
