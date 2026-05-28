import { createActor, type Actor, type AnyActor } from 'xstate';
import { join } from 'node:path';
import { readDevModeSentinel } from 'core/io/fs/dev-mode-sentinel.ts';
import { daemonRootMachine } from 'services/state-machines/daemon-root';
import { startEventRouter } from 'services/state-machines/event-router';
import {
  sentinelRegistryMachine,
  type SentinelRegistryMachine,
} from 'services/state-machines/sentinel-registry';
import { startSentinelWatcher } from 'services/state-machines/sentinel-watcher';
import {
  buildSnapshot,
  persistSnapshotRegistry,
  type MachineSnapshot,
  type SnapshotRegistry,
} from 'services/state-machines/snapshot';
import { SNAPSHOT_FLUSH_INTERVAL_MS } from 'services/state-machines/state-machines.constants.ts';
import { nowIsoUtc } from 'core/utils';
import type {
  DaemonActorsHandle,
  DaemonActorsInput,
} from 'services/state-machines/daemon-actors/daemon-actors.types.ts';

interface NamedActor {
  readonly name: string;
  readonly actor: AnyActor;
}

function snapshotForActor(actor: AnyActor): MachineSnapshot {
  const snapshot = actor.getSnapshot();
  return buildSnapshot(snapshot.value, snapshot.context, snapshot.status, nowIsoUtc());
}

function buildSnapshotRegistry(actors: readonly NamedActor[]): SnapshotRegistry {
  const registry: SnapshotRegistry = {};
  for (const { name, actor } of actors) {
    const machineSnapshot = snapshotForActor(actor);
    const key = name as keyof SnapshotRegistry;
    registry[key] = machineSnapshot;
  }
  return registry;
}

export async function startDaemonActors(input: DaemonActorsInput): Promise<DaemonActorsHandle> {
  const isDevMode = await readDevModeSentinel(join(input.paths.configDir, 'DEV_MODE'));
  let xstateInspect: NonNullable<Parameters<typeof createActor>[1]>['inspect'] = undefined;

  const shouldInspect = isDevMode && input.xstateInspect === true;

  if (shouldInspect) {
    try {
      const { createBrowserInspector } = await import('@statelyai/inspect');
      const inspector = createBrowserInspector();
      xstateInspect = inspector.inspect;
    } catch (err) {
      input.logger?.warn(
        {
          event: 'daemon_actors.inspect_init_failed',
          error: err instanceof Error ? err.message : String(err),
        },
        'failed to initialize stately browser inspector',
      );
    }
  }

  const registryOptions: NonNullable<Parameters<typeof createActor>[1]> = {};
  const rootOptions: NonNullable<Parameters<typeof createActor>[1]> = {};

  if (xstateInspect !== undefined) {
    registryOptions.inspect = xstateInspect;
    rootOptions.inspect = xstateInspect;
  }

  const registry: Actor<SentinelRegistryMachine> = createActor(
    sentinelRegistryMachine,
    registryOptions,
  );
  registry.start();

  const root = createActor(daemonRootMachine, rootOptions);
  root.start();
  root.send({ type: 'CONFIG_LOADED' });
  root.send({ type: 'BUFFER_OPENED' });

  const watcher = await startSentinelWatcher({
    paths: input.paths,
    target: registry,
    ...(input.logger !== undefined ? { logger: input.logger } : {}),
  });

  const actors: NamedActor[] = [
    { name: 'sentinel-registry', actor: registry },
    { name: 'daemon-root', actor: root },
  ];

  const eventRouter = startEventRouter({
    actors: actors.map(({ name, actor }) => ({ name, actor })),
    ...(input.logger !== undefined ? { logger: input.logger } : {}),
  });

  const flushSnapshots = (): void => {
    try {
      persistSnapshotRegistry(input.buffer, buildSnapshotRegistry(actors));
    } catch (err) {
      input.logger?.warn(
        {
          event: 'daemon_actors.snapshot_flush_failed',
          error: err instanceof Error ? err.message : String(err),
        },
        'failed to persist machine snapshots',
      );
    }
  };

  const intervalMs = input.snapshotIntervalMs ?? SNAPSHOT_FLUSH_INTERVAL_MS;
  const flushTimer = setInterval(flushSnapshots, intervalMs);

  return {
    registry,
    root,
    markReady: (bootedAtUtc) => {
      root.send({ type: 'WATERMARKS_SKIPPED' });
      root.send({ type: 'READY', bootedAtUtc });
    },
    requestShutdown: (reason) => {
      root.send({ type: 'SHUTDOWN', reason });
    },
    markExited: (exitedAtUtc) => {
      root.send({ type: 'EXIT', exitedAtUtc });
    },
    flushSnapshots,
    stop: async () => {
      clearInterval(flushTimer);
      flushSnapshots();
      eventRouter.stop();
      await watcher.stop();
      registry.stop();
      root.stop();
    },
  };
}
