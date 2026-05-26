import { assign, setup } from 'xstate';
import type {
  HeartbeatLoopContext,
  HeartbeatLoopEvent,
  HeartbeatLoopInput,
} from 'services/state-machines/heartbeat-loop/heartbeat-loop.types.ts';

export const heartbeatLoopMachine = setup({
  types: {
    context: {} as HeartbeatLoopContext,
    events: {} as HeartbeatLoopEvent,
    input: {} as HeartbeatLoopInput,
  },
}).createMachine({
  id: 'heartbeat-loop',
  initial: 'waiting',
  context: ({ input }) => ({
    intervalMs: input.intervalMs,
    versionCheckIntervalMs: input.versionCheckIntervalMs,
    cyclesCompleted: 0,
    cyclesSkipped: 0,
    lastCycleAtUtc: null,
    lastCycleDurationMs: null,
    lastFreshness: null,
    lastVersionCheckAtUtc: null,
    ranAutoUpgrade: false,
  }),
  states: {
    waiting: {
      on: {
        TICK: {
          target: 'evaluating_gate',
          actions: assign({
            lastCycleAtUtc: ({ event }) => event.startedAtUtc,
            ranAutoUpgrade: () => false,
          }),
        },
      },
    },
    evaluating_gate: {
      on: {
        GATE_BLOCKED: {
          target: 'skipped',
          actions: assign({
            cyclesSkipped: ({ context }) => context.cyclesSkipped + 1,
          }),
        },
        GATE_CLEAR: {
          target: 'checking_freshness',
        },
      },
    },
    checking_freshness: {
      on: {
        FRESHNESS_CHECKED: {
          target: 'throttle_check',
          actions: assign({
            lastFreshness: ({ event }) => event.status,
          }),
        },
      },
    },
    throttle_check: {
      on: {
        THROTTLE_ALLOWS: {
          target: 'version_check_branch',
        },
        THROTTLE_BLOCKS: {
          target: 'persisting_metrics',
        },
      },
    },
    version_check_branch: {
      on: {
        VERSION_CHECK_COMPLETE: {
          target: 'persisting_metrics',
          actions: assign({
            ranAutoUpgrade: ({ event }) => event.ranAutoUpgrade,
            lastVersionCheckAtUtc: ({ event }) => event.checkedAtUtc,
          }),
        },
      },
    },
    persisting_metrics: {
      on: {
        METRICS_PERSISTED: {
          target: 'waiting',
          actions: assign({
            cyclesCompleted: ({ context }) => context.cyclesCompleted + 1,
            lastCycleDurationMs: ({ event }) => event.durationMs,
          }),
        },
      },
    },
    skipped: {
      on: {
        METRICS_PERSISTED: {
          target: 'waiting',
          actions: assign({
            lastCycleDurationMs: ({ event }) => event.durationMs,
          }),
        },
      },
    },
  },
});

export type HeartbeatLoopMachine = typeof heartbeatLoopMachine;
