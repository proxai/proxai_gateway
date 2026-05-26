import { basename } from 'node:path';
import { nowIsoUtc } from 'core/utils';
import { readAuthFailedSentinel } from 'services/polling/auth-failed-sentinel.ts';
import { readBufferFullSentinel } from 'services/polling/buffer-full-sentinel.ts';
import { readPauseReason } from 'services/polling/pause-sentinel.ts';
import { readSessionStoppedSentinel } from 'services/polling/session-stopped-sentinel.ts';
import { readUpdateAvailableSentinel } from 'services/polling/update-available-sentinel.ts';
import type { SentinelRegistryEvent } from 'services/state-machines/sentinel-registry/sentinel-registry.types.ts';
import type {
  SentinelKind,
  SentinelWatcherPaths,
} from 'services/state-machines/sentinel-watcher/sentinel-watcher.types.ts';

export function classifySentinel(
  filename: string,
  paths: SentinelWatcherPaths,
): SentinelKind | null {
  if (filename === basename(paths.authFailed)) return 'auth-failed';
  if (filename === basename(paths.paused)) return 'paused';
  if (filename === basename(paths.bufferFull)) return 'buffer-full';
  if (filename === basename(paths.sessionStopped)) return 'session-stopped';
  if (filename === basename(paths.updateAvailable)) return 'update-available';
  return null;
}

export async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

export async function buildPresentEvent(
  kind: SentinelKind,
  paths: SentinelWatcherPaths,
): Promise<SentinelRegistryEvent | null> {
  switch (kind) {
    case 'auth-failed': {
      const payload = await readAuthFailedSentinel(paths.authFailed);
      if (payload === null) return null;
      return {
        type: 'AUTH_FAILED_WRITTEN',
        payload: {
          reason: payload.reason,
          detectedAtUtc: payload.detectedAt === '' ? nowIsoUtc() : payload.detectedAt,
        },
      };
    }
    case 'paused': {
      const reason = await readPauseReason(paths.paused);
      return { type: 'PAUSE_REQUESTED', payload: { reason } };
    }
    case 'buffer-full': {
      const payload = await readBufferFullSentinel(paths.bufferFull);
      if (payload === null) return null;
      return {
        type: 'PRESSURE_CROSSED_PAUSE',
        payload: {
          pendingBytes: payload.pendingBytes,
          thresholdBytes: payload.threshold,
          setAtUtc: payload.setAt,
        },
      };
    }
    case 'session-stopped': {
      const payload = await readSessionStoppedSentinel(paths.sessionStopped);
      if (payload === null) return null;
      return {
        type: 'STOP_REQUESTED',
        payload: {
          bootId: payload.bootId,
          setAtUtc: payload.setAt,
        },
      };
    }
    case 'update-available': {
      const payload = await readUpdateAvailableSentinel(paths.updateAvailable);
      if (payload === null) return null;
      return {
        type: 'BREW_UPDATE_AVAILABLE',
        payload: {
          latestVersion: payload.latestVersion,
          currentVersion: payload.currentVersion,
          detectedAtUtc: payload.detectedAt,
          assetUrl: payload.assetUrl ?? null,
        },
      };
    }
  }
}

export function buildAbsentEvent(kind: SentinelKind): SentinelRegistryEvent {
  switch (kind) {
    case 'auth-failed':
      return { type: 'AUTH_FAILED_CLEARED' };
    case 'paused':
      return { type: 'RESUME_REQUESTED' };
    case 'buffer-full':
      return { type: 'PRESSURE_CROSSED_RESUME' };
    case 'session-stopped':
      return { type: 'BOOT_ID_MISMATCH' };
    case 'update-available':
      return { type: 'BREW_UP_TO_DATE', latestVersion: '' };
  }
}
