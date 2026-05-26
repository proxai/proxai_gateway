export type {
  SentinelKind,
  SentinelWatcherPaths,
  SentinelEventTarget,
  SentinelWatcherDeps,
  SentinelWatcherHandle,
} from 'services/state-machines/sentinel-watcher/sentinel-watcher.types.ts';
export {
  classifySentinel,
  fileExists,
  buildPresentEvent,
  buildAbsentEvent,
} from 'services/state-machines/sentinel-watcher/sentinel-watcher.utils.ts';
export { startSentinelWatcher } from 'services/state-machines/sentinel-watcher/sentinel-watcher.ts';
