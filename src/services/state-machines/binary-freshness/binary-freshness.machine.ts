import { assign, fromPromise, setup } from 'xstate';
import { pausePolling } from 'services/polling/pause-sentinel.ts';
import type {
  BinaryFreshnessCheckEvent,
  BinaryFreshnessContext,
  BinaryFreshnessEvaluation,
  BinaryFreshnessEvent,
  BinaryFreshnessInput,
} from 'services/state-machines/binary-freshness/binary-freshness.types.ts';
import {
  buildStalePauseReason,
  evaluateBinaryFreshness,
} from 'services/state-machines/binary-freshness/binary-freshness.utils.ts';

interface EvaluateActorInput {
  readonly event: BinaryFreshnessCheckEvent;
  readonly pauseSentinelPath: string;
}

export const binaryFreshnessMachine = setup({
  types: {
    context: {} as BinaryFreshnessContext,
    events: {} as BinaryFreshnessEvent,
    input: {} as BinaryFreshnessInput,
  },
  actors: {
    evaluate: fromPromise<BinaryFreshnessEvaluation, EvaluateActorInput>(async ({ input }) => {
      const result = evaluateBinaryFreshness(input.event);
      if (result.status === 'stale_paused' && result.daysSinceInstall !== null) {
        await pausePolling(
          input.pauseSentinelPath,
          buildStalePauseReason(result.daysSinceInstall, input.event.pauseAfterDays),
        );
      }
      return result;
    }),
  },
}).createMachine({
  id: 'binary-freshness',
  initial: 'unchecked',
  context: ({ input }) => ({
    pauseSentinelPath: input.pauseSentinelPath,
    lastEvaluatedAt: null,
    lastDaysSinceInstall: null,
  }),
  states: {
    unchecked: {
      on: {
        CHECK: { target: 'checking' },
      },
    },
    checking: {
      invoke: {
        id: 'evaluate',
        src: 'evaluate',
        input: ({ context, event }) => ({
          event: event as BinaryFreshnessCheckEvent,
          pauseSentinelPath: context.pauseSentinelPath,
        }),
        onDone: [
          {
            guard: ({ event }) => event.output.status === 'stale_paused',
            target: 'stale_paused',
            actions: assign({
              lastEvaluatedAt: ({ event }) => event.output.evaluatedAtMs,
              lastDaysSinceInstall: ({ event }) => event.output.daysSinceInstall,
            }),
          },
          {
            guard: ({ event }) => event.output.status === 'warning',
            target: 'warning',
            actions: assign({
              lastEvaluatedAt: ({ event }) => event.output.evaluatedAtMs,
              lastDaysSinceInstall: ({ event }) => event.output.daysSinceInstall,
            }),
          },
          {
            target: 'fresh',
            actions: assign({
              lastEvaluatedAt: ({ event }) => event.output.evaluatedAtMs,
              lastDaysSinceInstall: ({ event }) => event.output.daysSinceInstall,
            }),
          },
        ],
        onError: { target: 'fresh' },
      },
    },
    fresh: {
      on: {
        CHECK: { target: 'checking' },
      },
    },
    warning: {
      on: {
        CHECK: { target: 'checking' },
      },
    },
    stale_paused: {
      on: {
        CHECK: { target: 'checking' },
      },
    },
  },
});

export type BinaryFreshnessMachine = typeof binaryFreshnessMachine;
