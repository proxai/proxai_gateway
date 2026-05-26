import { assign, setup } from 'xstate';
import type { SetupContext, SetupEvent } from 'services/state-machines/setup/setup.types.ts';

export const setupMachine = setup({
  types: {
    context: {} as SetupContext,
    events: {} as SetupEvent,
  },
}).createMachine({
  id: 'setup',
  initial: 'prompting_consent',
  context: {
    consentAccepted: false,
    ingestionKeyMasked: null,
    keyVerified: false,
    configWritten: false,
    sentinelWritten: false,
    lastError: null,
  },
  on: {
    ERROR: {
      target: '.failed',
      actions: assign({ lastError: ({ event }) => event.message }),
    },
  },
  states: {
    prompting_consent: {
      on: {
        CONSENT_ACCEPTED: {
          target: 'collecting_ingestion_key',
          actions: assign({ consentAccepted: () => true }),
        },
        CONSENT_DECLINED: {
          target: 'cancelled',
        },
      },
    },
    collecting_ingestion_key: {
      on: {
        KEY_PROVIDED: {
          target: 'verifying_key',
          actions: assign({ ingestionKeyMasked: ({ event }) => event.maskedKey }),
        },
      },
    },
    verifying_key: {
      on: {
        KEY_VERIFY_SUCCESS: {
          target: 'writing_config',
          actions: assign({ keyVerified: () => true }),
        },
        KEY_VERIFY_FAILURE: {
          target: 'collecting_ingestion_key',
          actions: assign({ lastError: ({ event }) => event.reason }),
        },
      },
    },
    writing_config: {
      on: {
        CONFIG_WRITTEN: {
          target: 'writing_consent_sentinel',
          actions: assign({ configWritten: () => true }),
        },
      },
    },
    writing_consent_sentinel: {
      on: {
        SENTINEL_WRITTEN: {
          target: 'done',
          actions: assign({ sentinelWritten: () => true }),
        },
      },
    },
    done: { type: 'final' },
    cancelled: { type: 'final' },
    failed: {
      on: {
        CONSENT_ACCEPTED: { target: 'collecting_ingestion_key' },
        KEY_PROVIDED: { target: 'verifying_key' },
      },
    },
  },
});

export type SetupMachine = typeof setupMachine;
