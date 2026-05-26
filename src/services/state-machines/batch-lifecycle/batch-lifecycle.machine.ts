import { assign, setup } from 'xstate';
import type {
  BatchLifecycleContext,
  BatchLifecycleEvent,
  BatchLifecycleInput,
} from 'services/state-machines/batch-lifecycle/batch-lifecycle.types.ts';

export const batchLifecycleMachine = setup({
  types: {
    context: {} as BatchLifecycleContext,
    events: {} as BatchLifecycleEvent,
    input: {} as BatchLifecycleInput,
  },
  actions: {
    incrementAttempts: assign({
      attempts: ({ context }) => context.attempts + 1,
    }),
  },
}).createMachine({
  id: 'batch-lifecycle',
  initial: 'pending',
  context: ({ input }) => ({
    batch: input.batch,
    attempts: 0,
    lastError: null,
    lastRetriableReason: null,
    lastFailureReason: null,
    idempotentOnServer: false,
    recoveredServerWatermarkEnd: null,
    retryAfterMs: null,
    deliveredAtUtc: null,
    failedAtUtc: null,
    prunedAtUtc: null,
  }),
  states: {
    pending: {
      on: {
        DRAIN_PICKS_UP: {
          target: 'uploading',
          actions: 'incrementAttempts',
        },
      },
    },
    uploading: {
      on: {
        ACCEPTED: {
          target: 'delivered',
          actions: assign({
            idempotentOnServer: ({ event }) => event.idempotent,
            deliveredAtUtc: ({ event }) => event.deliveredAtUtc,
          }),
        },
        WATERMARK_REGRESSED: {
          target: 'recovered',
          actions: assign({
            recoveredServerWatermarkEnd: ({ event }) => event.serverWatermarkEnd,
          }),
        },
        VALIDATION_FAILED: {
          target: 'failed.validation',
          actions: assign({
            lastError: ({ event }) => event.error,
            lastFailureReason: () => 'validation' as const,
            failedAtUtc: ({ event }) => event.failedAtUtc,
          }),
        },
        OVERSIZED: {
          target: 'failed.oversized',
          actions: assign({
            lastError: ({ event }) => event.error,
            lastFailureReason: () => 'oversized' as const,
            failedAtUtc: ({ event }) => event.failedAtUtc,
          }),
        },
        AUTH_ERROR: {
          target: 'verifying_auth',
          actions: assign({
            lastError: ({ event }) => event.error,
          }),
        },
        RATE_LIMITED: {
          target: 'retriable_pending',
          actions: assign({
            lastError: ({ event }) => event.error,
            lastRetriableReason: () => 'rate_limit' as const,
            retryAfterMs: ({ event }) => event.retryAfterMs,
          }),
        },
        SERVICE_UNAVAILABLE: {
          target: 'retriable_pending',
          actions: assign({
            lastError: ({ event }) => event.error,
            lastRetriableReason: () => 'service_unavailable' as const,
            retryAfterMs: ({ event }) => event.retryAfterMs,
          }),
        },
        NETWORK_ERROR: {
          target: 'retriable_pending',
          actions: assign({
            lastError: ({ event }) => event.error,
            lastRetriableReason: () => 'network' as const,
            retryAfterMs: () => null,
          }),
        },
        UNKNOWN_ERROR: {
          target: 'failed.unknown',
          actions: assign({
            lastError: ({ event }) => event.error,
            lastFailureReason: () => 'unknown' as const,
            failedAtUtc: ({ event }) => event.failedAtUtc,
          }),
        },
      },
    },
    verifying_auth: {
      on: {
        VERIFY_THREW_AUTH: {
          target: 'failed.auth_invalid',
          actions: assign({
            lastError: ({ event }) => event.error,
            lastFailureReason: () => 'auth_invalid' as const,
            failedAtUtc: ({ event }) => event.failedAtUtc,
          }),
        },
        VERIFY_SUCCESS_FALSE: {
          target: 'failed.auth_invalid',
          actions: assign({
            lastError: ({ event }) => event.error,
            lastFailureReason: () => 'auth_invalid' as const,
            failedAtUtc: ({ event }) => event.failedAtUtc,
          }),
        },
        VERIFY_SUCCESS_TRUE: {
          target: 'retriable_pending',
          actions: assign({
            lastError: ({ event }) => event.error,
            lastRetriableReason: () => 'auth_unconfirmed' as const,
            retryAfterMs: () => null,
          }),
        },
        VERIFY_THREW_OTHER: {
          target: 'retriable_pending',
          actions: assign({
            lastError: ({ event }) => event.error,
            lastRetriableReason: () => 'auth_unconfirmed' as const,
            retryAfterMs: () => null,
          }),
        },
      },
    },
    retriable_pending: {
      on: {
        RETURN_TO_QUEUE: {
          target: 'pending',
        },
      },
    },
    delivered: {
      on: {
        RETENTION_EXPIRED: {
          target: 'pruned',
          actions: assign({
            prunedAtUtc: ({ event }) => event.prunedAtUtc,
          }),
        },
      },
    },
    recovered: {
      type: 'final',
    },
    failed: {
      initial: 'unknown',
      states: {
        validation: {},
        oversized: {},
        auth_invalid: {},
        unknown: {},
      },
      on: {
        RETENTION_EXPIRED: {
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

export type BatchLifecycleMachine = typeof batchLifecycleMachine;
