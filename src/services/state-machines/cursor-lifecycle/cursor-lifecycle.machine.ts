import { assign, setup } from 'xstate';
import type {
  CursorLifecycleContext,
  CursorLifecycleEvent,
  CursorLifecycleInput,
} from 'services/state-machines/cursor-lifecycle/cursor-lifecycle.types.ts';

export const cursorLifecycleMachine = setup({
  types: {
    context: {} as CursorLifecycleContext,
    events: {} as CursorLifecycleEvent,
    input: {} as CursorLifecycleInput,
  },
}).createMachine({
  id: 'cursor-lifecycle',
  initial: 'unseeded',
  context: ({ input }) => ({
    identity: input.identity,
    watermarkEnd: 0,
    consecutiveErrors: 0,
    lastSeenSizeBytes: null,
    lastSeenPageCount: null,
    lastPolledAt: null,
    generation: 0,
    lastServerWatermarkEnd: null,
  }),
  states: {
    unseeded: {
      on: {
        SYNCED: {
          target: 'healthy',
          actions: assign({
            watermarkEnd: ({ event }) => event.watermarkEnd,
            lastPolledAt: ({ event }) => event.polledAtUtc,
          }),
        },
        POLL_SUCCESS: {
          target: 'healthy',
          actions: assign({
            watermarkEnd: ({ event }) => event.watermarkEnd,
            lastPolledAt: ({ event }) => event.polledAtUtc,
            lastSeenSizeBytes: ({ event }) => event.lastSeenSizeBytes,
            lastSeenPageCount: ({ event }) => event.lastSeenPageCount,
            consecutiveErrors: () => 0,
          }),
        },
      },
    },
    syncing: {
      on: {
        SYNCED: {
          target: 'healthy',
          actions: assign({
            watermarkEnd: ({ event }) => event.watermarkEnd,
            lastPolledAt: ({ event }) => event.polledAtUtc,
          }),
        },
      },
    },
    healthy: {
      on: {
        POLL_SUCCESS: {
          actions: assign({
            watermarkEnd: ({ event }) => event.watermarkEnd,
            lastPolledAt: ({ event }) => event.polledAtUtc,
            lastSeenSizeBytes: ({ event }) => event.lastSeenSizeBytes,
            lastSeenPageCount: ({ event }) => event.lastSeenPageCount,
            consecutiveErrors: () => 0,
          }),
        },
        POLL_ERROR: {
          actions: assign({
            consecutiveErrors: ({ context }) => context.consecutiveErrors + 1,
            lastPolledAt: ({ event }) => event.polledAtUtc,
          }),
        },
        VACUUM_DETECTED: {
          target: 'vacuumed',
        },
        WATERMARK_REGRESSED: {
          target: 'regressed',
          actions: assign({
            lastServerWatermarkEnd: ({ event }) => event.serverWatermarkEnd,
          }),
        },
      },
    },
    vacuumed: {
      on: {
        NEW_GENERATION_CREATED: {
          target: 'healthy',
          actions: assign({
            generation: ({ context }) => context.generation + 1,
            watermarkEnd: () => 0,
            consecutiveErrors: () => 0,
          }),
        },
      },
    },
    regressed: {
      on: {
        REGRESSION_APPLIED: {
          target: 'healthy',
          actions: assign({
            watermarkEnd: ({ context }) => context.lastServerWatermarkEnd ?? context.watermarkEnd,
            lastServerWatermarkEnd: () => null,
            consecutiveErrors: () => 0,
          }),
        },
      },
    },
  },
});

export type CursorLifecycleMachine = typeof cursorLifecycleMachine;
