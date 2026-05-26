import { assign, setup } from 'xstate';
import type {
  ServiceManagerContext,
  ServiceManagerEvent,
  ServiceManagerInput,
} from 'services/state-machines/service-manager/service-manager.types.ts';

export const serviceManagerMachine = setup({
  types: {
    context: {} as ServiceManagerContext,
    events: {} as ServiceManagerEvent,
    input: {} as ServiceManagerInput,
  },
}).createMachine({
  id: 'service-manager',
  initial: 'not_installed',
  context: ({ input }) => ({
    platform: input.platform,
    lastError: null,
  }),
  on: {
    ERROR: {
      target: '.failed',
      actions: assign({ lastError: ({ event }) => event.message }),
    },
  },
  states: {
    not_installed: {
      on: { INSTALL: { target: 'installing' } },
    },
    installing: {
      on: { INSTALL_COMPLETE: { target: 'installed' } },
    },
    installed: {
      on: {
        START: { target: 'starting' },
        UNINSTALL: { target: 'uninstalling' },
      },
    },
    starting: {
      on: { START_COMPLETE: { target: 'running' } },
    },
    running: {
      on: { STOP: { target: 'stopping' } },
    },
    stopping: {
      on: { STOP_COMPLETE: { target: 'stopped' } },
    },
    stopped: {
      on: {
        START: { target: 'starting' },
        UNINSTALL: { target: 'uninstalling' },
      },
    },
    uninstalling: {
      on: { UNINSTALL_COMPLETE: { target: 'uninstalled' } },
    },
    uninstalled: {
      type: 'final',
    },
    failed: {
      on: {
        INSTALL: { target: 'installing' },
        START: { target: 'starting' },
        STOP: { target: 'stopping' },
        UNINSTALL: { target: 'uninstalling' },
      },
    },
  },
});

export type ServiceManagerMachine = typeof serviceManagerMachine;
