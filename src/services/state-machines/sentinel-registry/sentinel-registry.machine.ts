import { assign, setup } from 'xstate';
import type {
  SentinelRegistryContext,
  SentinelRegistryEvent,
} from 'services/state-machines/sentinel-registry/sentinel-registry.types.ts';

export const sentinelRegistryMachine = setup({
  types: {
    context: {} as SentinelRegistryContext,
    events: {} as SentinelRegistryEvent,
  },
}).createMachine({
  id: 'sentinel-registry',
  type: 'parallel',
  context: {
    authPayload: null,
    pausePayload: null,
    bufferFullPayload: null,
    sessionStoppedPayload: null,
    brewUpdatePayload: null,
    brewLatestKnownVersion: null,
  },
  states: {
    auth: {
      initial: 'absent',
      states: {
        absent: {
          on: {
            AUTH_FAILED_WRITTEN: {
              target: 'present',
              actions: assign({ authPayload: ({ event }) => event.payload }),
            },
          },
        },
        present: {
          on: {
            AUTH_FAILED_CLEARED: {
              target: 'absent',
              actions: assign({ authPayload: () => null }),
            },
          },
        },
      },
    },
    pause: {
      initial: 'absent',
      states: {
        absent: {
          on: {
            PAUSE_REQUESTED: {
              target: 'present',
              actions: assign({ pausePayload: ({ event }) => event.payload }),
            },
          },
        },
        present: {
          on: {
            RESUME_REQUESTED: {
              target: 'absent',
              actions: assign({ pausePayload: () => null }),
            },
          },
        },
      },
    },
    bufferPressure: {
      initial: 'ok',
      states: {
        ok: {
          on: {
            PRESSURE_CROSSED_PAUSE: {
              target: 'full',
              actions: assign({ bufferFullPayload: ({ event }) => event.payload }),
            },
          },
        },
        full: {
          on: {
            PRESSURE_CROSSED_RESUME: {
              target: 'ok',
              actions: assign({ bufferFullPayload: () => null }),
            },
          },
        },
      },
    },
    session: {
      initial: 'live',
      states: {
        live: {
          on: {
            STOP_REQUESTED: {
              target: 'stopped',
              actions: assign({ sessionStoppedPayload: ({ event }) => event.payload }),
            },
          },
        },
        stopped: {
          on: {
            BOOT_ID_MISMATCH: {
              target: 'live',
              actions: assign({ sessionStoppedPayload: () => null }),
            },
          },
        },
      },
    },
    brewUpdate: {
      initial: 'unknown',
      states: {
        unknown: {
          on: {
            BREW_UPDATE_AVAILABLE: {
              target: 'available',
              actions: assign({
                brewUpdatePayload: ({ event }) => event.payload,
                brewLatestKnownVersion: ({ event }) => event.payload.latestVersion,
              }),
            },
            BREW_UP_TO_DATE: {
              target: 'up_to_date',
              actions: assign({
                brewLatestKnownVersion: ({ event }) => event.latestVersion,
                brewUpdatePayload: () => null,
              }),
            },
          },
        },
        up_to_date: {
          on: {
            BREW_UPDATE_AVAILABLE: {
              target: 'available',
              actions: assign({
                brewUpdatePayload: ({ event }) => event.payload,
                brewLatestKnownVersion: ({ event }) => event.payload.latestVersion,
              }),
            },
            BREW_VERSION_UNKNOWN: {
              target: 'unknown',
            },
          },
        },
        available: {
          on: {
            BREW_UP_TO_DATE: {
              target: 'up_to_date',
              actions: assign({
                brewLatestKnownVersion: ({ event }) => event.latestVersion,
                brewUpdatePayload: () => null,
              }),
            },
            BREW_VERSION_UNKNOWN: {
              target: 'unknown',
              actions: assign({ brewUpdatePayload: () => null }),
            },
          },
        },
      },
    },
  },
});

export type SentinelRegistryMachine = typeof sentinelRegistryMachine;
