import { assign, fromPromise, setup } from 'xstate';
import type {
  BinaryFreshnessCheckEvent,
  BinaryFreshnessContext,
  BinaryFreshnessEvaluation,
  BinaryFreshnessEvent,
  BinaryFreshnessInput,
} from 'services/state-machines/binary-freshness/binary-freshness.types.ts';
import { evaluateBinaryFreshness } from 'services/state-machines/binary-freshness/binary-freshness.utils.ts';

interface EvaluateActorInput {
  readonly event: BinaryFreshnessCheckEvent;
}

export const binaryFreshnessMachine = setup({
  types: {
    context: {} as BinaryFreshnessContext,
    events: {} as BinaryFreshnessEvent,
    input: {} as BinaryFreshnessInput,
  },
  actors: {
    evaluate: fromPromise<BinaryFreshnessEvaluation, EvaluateActorInput>(async ({ input }) =>
      evaluateBinaryFreshness(input.event),
    ),
  },
}).createMachine({
  id: 'binary-freshness',
  initial: 'unchecked',
  context: () => ({
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
        input: ({ event }) => ({
          event: event as BinaryFreshnessCheckEvent,
        }),
        onDone: [
          {
            guard: ({ event }) => event.output.status === 'stale',
            target: 'stale',
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
    stale: {
      on: {
        CHECK: { target: 'checking' },
      },
    },
  },
});

export type BinaryFreshnessMachine = typeof binaryFreshnessMachine;
