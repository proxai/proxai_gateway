import { assign, setup } from 'xstate';
import { PACER_MAX_BACKOFF_STEPS } from 'services/state-machines/pacer/pacer.constants.ts';
import type {
  PacerContext,
  PacerEvent,
  PacerInput,
} from 'services/state-machines/pacer/pacer.types.ts';

export const pacerMachine = setup({
  types: {
    context: {} as PacerContext,
    events: {} as PacerEvent,
    input: {} as PacerInput,
  },
}).createMachine({
  id: 'pacer',
  initial: 'ready',
  context: ({ input }) => ({
    maxBatchesPerSec: input.maxBatchesPerSec,
    maxBytesPerMinute: input.maxBytesPerMinute,
    retryAfterUntilMs: null,
    rate429Step: 0,
    rate5xxStep: 0,
    rate5xxFloorMs: 0,
    pendingNotify429: false,
    pendingNotify5xx: false,
    rateTokens: input.maxBatchesPerSec,
    bytesTokens: input.maxBytesPerMinute,
    lastAcquireBytes: null,
    lastDebitedAtMs: null,
  }),
  on: {
    NOTIFY_RETRY_AFTER: {
      actions: assign({
        retryAfterUntilMs: ({ context, event }) =>
          context.retryAfterUntilMs === null || event.untilMs > context.retryAfterUntilMs
            ? event.untilMs
            : context.retryAfterUntilMs,
      }),
    },
    NOTIFY_429: {
      actions: assign({
        pendingNotify429: () => true,
      }),
    },
    NOTIFY_5XX: {
      actions: assign({
        pendingNotify5xx: () => true,
        rate5xxFloorMs: ({ context, event }) =>
          event.floorMs > context.rate5xxFloorMs ? event.floorMs : context.rate5xxFloorMs,
      }),
    },
    CLEAR_429_PENDING: {
      actions: assign({
        pendingNotify429: () => false,
      }),
    },
    CLEAR_5XX_PENDING: {
      actions: assign({
        pendingNotify5xx: () => false,
      }),
    },
  },
  states: {
    ready: {
      on: {
        ACQUIRE_STARTED: {
          target: 'throttling.applying_retry_after',
          actions: assign({
            lastAcquireBytes: ({ event }) => event.payloadBytes,
            rate429Step: ({ context }) =>
              context.pendingNotify429
                ? Math.min(context.rate429Step + 1, PACER_MAX_BACKOFF_STEPS)
                : 0,
            rate5xxStep: ({ context }) =>
              context.pendingNotify5xx
                ? Math.min(context.rate5xxStep + 1, PACER_MAX_BACKOFF_STEPS)
                : 0,
            pendingNotify429: () => false,
            pendingNotify5xx: () => false,
          }),
        },
      },
    },
    throttling: {
      initial: 'applying_retry_after',
      states: {
        applying_retry_after: {
          on: {
            ENTER_429_BACKOFF: { target: 'applying_429_backoff' },
          },
        },
        applying_429_backoff: {
          on: {
            ENTER_5XX_BACKOFF: { target: 'applying_5xx_backoff' },
          },
        },
        applying_5xx_backoff: {
          on: {
            ENTER_TOKEN_BUCKET: { target: 'applying_token_bucket' },
          },
        },
        applying_token_bucket: {
          on: {
            ENTER_DEBITING: { target: 'debiting' },
          },
        },
        debiting: {
          on: {
            ACQUIRE_COMPLETE: {
              target: '#pacer.ready',
              actions: assign({
                rateTokens: ({ event }) => event.rateTokens,
                bytesTokens: ({ event }) => event.bytesTokens,
                lastDebitedAtMs: ({ event }) => event.debitedAtMs,
                retryAfterUntilMs: () => null,
                rate5xxFloorMs: () => 0,
              }),
            },
          },
        },
      },
    },
  },
});

export type PacerMachine = typeof pacerMachine;
