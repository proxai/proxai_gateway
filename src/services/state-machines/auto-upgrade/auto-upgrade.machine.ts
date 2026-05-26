import { assign, setup } from 'xstate';
import type {
  AutoUpgradeContext,
  AutoUpgradeEvent,
  AutoUpgradeInput,
} from 'services/state-machines/auto-upgrade/auto-upgrade.types.ts';

export const autoUpgradeMachine = setup({
  types: {
    context: {} as AutoUpgradeContext,
    events: {} as AutoUpgradeEvent,
    input: {} as AutoUpgradeInput,
  },
  guards: {
    isBrew: ({ context }) => context.installSource === 'brew',
    canRunInPlace: ({ context }) => context.installSource !== 'brew' && context.binaryPath !== null,
  },
}).createMachine({
  id: 'auto-upgrade',
  initial: 'idle',
  context: ({ input }) => ({
    installSource: input.installSource,
    currentVersion: input.currentVersion,
    binaryPath: input.binaryPath,
    updateAvailableSentinelPath: input.updateAvailableSentinelPath,
    latestVersion: null,
    assetUrl: null,
    downloadedBytes: null,
    lastError: null,
    exitedAt: null,
  }),
  states: {
    idle: {
      on: {
        START: {
          target: 'checking_install_source',
        },
      },
    },
    checking_install_source: {
      always: [
        { guard: 'isBrew', target: 'brew_branch' },
        { guard: 'canRunInPlace', target: 'in_place_branch' },
        { target: 'done' },
      ],
    },
    brew_branch: {
      initial: 'fetching_version',
      states: {
        fetching_version: {
          on: {
            VERSION_OK_UPDATE_AVAILABLE: {
              target: 'update_available',
              actions: assign({
                latestVersion: ({ event }) => event.latestVersion,
                assetUrl: ({ event }) => event.assetUrl,
              }),
            },
            VERSION_OK_NO_UPDATE: {
              target: 'up_to_date',
              actions: assign({
                latestVersion: ({ event }) => event.latestVersion,
              }),
            },
            VERSION_NO_RELEASE: {
              target: 'no_release',
              actions: assign({
                lastError: ({ event }) => event.reason,
              }),
            },
            VERSION_ERROR: {
              target: 'error',
              actions: assign({
                lastError: ({ event }) => event.reason,
              }),
            },
          },
        },
        update_available: { type: 'final' },
        up_to_date: { type: 'final' },
        no_release: { type: 'final' },
        error: { type: 'final' },
      },
      onDone: {
        target: 'done',
      },
    },
    in_place_branch: {
      initial: 'fetching_release_meta',
      states: {
        fetching_release_meta: {
          on: {
            VERSION_OK_UPDATE_AVAILABLE: {
              target: 'resolving_asset',
              actions: assign({
                latestVersion: ({ event }) => event.latestVersion,
                assetUrl: ({ event }) => event.assetUrl,
              }),
            },
            VERSION_OK_NO_UPDATE: {
              target: 'up_to_date',
              actions: assign({
                latestVersion: ({ event }) => event.latestVersion,
              }),
            },
            VERSION_NO_RELEASE: {
              target: 'failed',
              actions: assign({
                lastError: ({ event }) => event.reason,
              }),
            },
            VERSION_ERROR: {
              target: 'failed',
              actions: assign({
                lastError: ({ event }) => event.reason,
              }),
            },
          },
        },
        resolving_asset: {
          on: {
            ASSET_RESOLVED: {
              target: 'downloading',
              actions: assign({
                assetUrl: ({ event }) => event.assetUrl,
              }),
            },
            ASSET_NOT_FOUND: {
              target: 'failed',
              actions: assign({
                lastError: () => 'no matching release asset',
              }),
            },
          },
        },
        downloading: {
          on: {
            DOWNLOAD_OK: {
              target: 'replacing_binary',
              actions: assign({
                downloadedBytes: ({ event }) => event.bytes,
              }),
            },
            DOWNLOAD_EMPTY: {
              target: 'failed',
              actions: assign({
                lastError: () => 'download returned empty body',
              }),
            },
          },
        },
        replacing_binary: {
          on: {
            BINARY_REPLACED: {
              target: 'exiting_process',
            },
          },
        },
        exiting_process: {
          on: {
            EXIT: {
              target: 'exited',
              actions: assign({
                exitedAt: ({ event }) => event.exitedAtUtc,
              }),
            },
          },
        },
        exited: { type: 'final' },
        up_to_date: { type: 'final' },
        failed: { type: 'final' },
      },
      onDone: {
        target: 'done',
      },
    },
    done: {
      type: 'final',
    },
  },
});

export type AutoUpgradeMachine = typeof autoUpgradeMachine;
