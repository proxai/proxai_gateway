import { assign, setup } from 'xstate';
import type {
  SourcePollContext,
  SourcePollEvent,
  SourcePollInput,
} from 'services/state-machines/source-poll/source-poll.types.ts';

export const sourcePollMachine = setup({
  types: {
    context: {} as SourcePollContext,
    events: {} as SourcePollEvent,
    input: {} as SourcePollInput,
  },
}).createMachine({
  id: 'source-poll',
  initial: 'idle',
  context: ({ input }) => ({
    sourceApp: input.sourceApp,
    filesDiscovered: 0,
    filesProcessed: 0,
    filesFailed: 0,
    batchesEmitted: 0,
    quarantineEmitted: 0,
    cursorUpdates: 0,
    startedAtUtc: null,
    finishedAtUtc: null,
    lastError: null,
  }),
  states: {
    idle: {
      on: {
        BEGIN_POLL: {
          target: 'discovering',
          actions: assign({
            startedAtUtc: ({ event }) => event.startedAtUtc,
            filesDiscovered: () => 0,
            filesProcessed: () => 0,
            filesFailed: () => 0,
            batchesEmitted: () => 0,
            quarantineEmitted: () => 0,
            cursorUpdates: () => 0,
            lastError: () => null,
          }),
        },
      },
    },
    discovering: {
      on: {
        FILES_FOUND: {
          target: 'processing',
          actions: assign({
            filesDiscovered: ({ event }) => event.count,
          }),
        },
        NO_FILES: {
          target: 'emitting_results',
        },
        DISCOVERY_ERROR: {
          target: 'errored',
          actions: assign({
            lastError: ({ event }) => event.message,
          }),
        },
      },
    },
    processing: {
      on: {
        FILE_PROCESSED: {
          actions: assign({
            filesProcessed: ({ context }) => context.filesProcessed + 1,
            batchesEmitted: ({ context, event }) => context.batchesEmitted + event.batchesEmitted,
            quarantineEmitted: ({ context, event }) =>
              context.quarantineEmitted + event.quarantineEmitted,
            cursorUpdates: ({ context, event }) => context.cursorUpdates + event.cursorUpdates,
          }),
        },
        FILE_FAILED: {
          actions: assign({
            filesFailed: ({ context }) => context.filesFailed + 1,
            lastError: ({ event }) => event.message,
          }),
        },
        ALL_FILES_PROCESSED: {
          target: 'emitting_results',
        },
      },
    },
    emitting_results: {
      on: {
        EMIT_COMPLETE: {
          target: 'done',
          actions: assign({
            finishedAtUtc: ({ event }) => event.finishedAtUtc,
          }),
        },
      },
    },
    done: {
      on: {
        BEGIN_POLL: {
          target: 'discovering',
          actions: assign({
            startedAtUtc: ({ event }) => event.startedAtUtc,
            filesDiscovered: () => 0,
            filesProcessed: () => 0,
            filesFailed: () => 0,
            batchesEmitted: () => 0,
            quarantineEmitted: () => 0,
            cursorUpdates: () => 0,
            lastError: () => null,
            finishedAtUtc: () => null,
          }),
        },
      },
    },
    errored: {
      on: {
        BEGIN_POLL: {
          target: 'discovering',
          actions: assign({
            startedAtUtc: ({ event }) => event.startedAtUtc,
            filesDiscovered: () => 0,
            filesProcessed: () => 0,
            filesFailed: () => 0,
            batchesEmitted: () => 0,
            quarantineEmitted: () => 0,
            cursorUpdates: () => 0,
            lastError: () => null,
            finishedAtUtc: () => null,
          }),
        },
      },
    },
  },
});

export type SourcePollMachine = typeof sourcePollMachine;
