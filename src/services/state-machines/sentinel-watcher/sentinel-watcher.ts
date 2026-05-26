import { watch } from 'node:fs/promises';
import { SENTINEL_WATCHER_DEBOUNCE_MS } from 'services/state-machines/state-machines.constants.ts';
import type {
  SentinelKind,
  SentinelWatcherDeps,
  SentinelWatcherHandle,
} from 'services/state-machines/sentinel-watcher/sentinel-watcher.types.ts';
import {
  buildAbsentEvent,
  buildPresentEvent,
  classifySentinel,
  fileExists,
} from 'services/state-machines/sentinel-watcher/sentinel-watcher.utils.ts';

const ALL_SENTINEL_KINDS: readonly SentinelKind[] = [
  'auth-failed',
  'paused',
  'buffer-full',
  'session-stopped',
  'update-available',
];

export async function startSentinelWatcher(
  deps: SentinelWatcherDeps,
): Promise<SentinelWatcherHandle> {
  const debounceMs = deps.debounceMs ?? SENTINEL_WATCHER_DEBOUNCE_MS;
  const ac = new AbortController();
  const pending = new Map<SentinelKind, ReturnType<typeof setTimeout>>();
  const log = deps.logger;

  await Promise.all(ALL_SENTINEL_KINDS.map((kind) => dispatchCurrent(kind, deps)));

  const watching = (async (): Promise<void> => {
    try {
      const iter = watch(deps.paths.configDir, { signal: ac.signal });
      for await (const event of iter) {
        if (typeof event.filename !== 'string' || event.filename.length === 0) continue;
        const kind = classifySentinel(event.filename, deps.paths);
        if (kind === null) continue;
        const existing = pending.get(kind);
        if (existing !== undefined) clearTimeout(existing);
        pending.set(
          kind,
          setTimeout(() => {
            pending.delete(kind);
            void dispatchCurrent(kind, deps).catch((err: unknown) => {
              log?.warn(
                {
                  event: 'sentinel_watcher.dispatch_failed',
                  kind,
                  error: err instanceof Error ? err.message : String(err),
                },
                'sentinel watcher failed to dispatch event',
              );
            });
          }, debounceMs),
        );
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      log?.warn(
        {
          event: 'sentinel_watcher.fatal',
          error: err instanceof Error ? err.message : String(err),
        },
        'sentinel watcher loop exited unexpectedly',
      );
    }
  })();

  return {
    async stop(): Promise<void> {
      ac.abort();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      await watching;
    },
  };
}

async function dispatchCurrent(kind: SentinelKind, deps: SentinelWatcherDeps): Promise<void> {
  const pathForKind = pickPath(kind, deps);
  const exists = await fileExists(pathForKind);
  if (exists) {
    const event = await buildPresentEvent(kind, deps.paths);
    if (event !== null) deps.target.send(event);
  } else {
    deps.target.send(buildAbsentEvent(kind));
  }
}

function pickPath(kind: SentinelKind, deps: SentinelWatcherDeps): string {
  switch (kind) {
    case 'auth-failed':
      return deps.paths.authFailed;
    case 'paused':
      return deps.paths.paused;
    case 'buffer-full':
      return deps.paths.bufferFull;
    case 'session-stopped':
      return deps.paths.sessionStopped;
    case 'update-available':
      return deps.paths.updateAvailable;
  }
}
