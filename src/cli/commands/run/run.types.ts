import type { Logger } from 'core/log';

import type { OutputSink } from 'cli/cli.types.ts';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';
import type { GatewayConfig, InstallSource } from 'services/config';
import { HttpClient } from 'services/http';
import type {
  CaptureCycleResult,
  DrainCycleResult,
  HeartbeatCycleResult,
  RegisteredSource,
} from 'services/polling';

export interface RunCommandDeps {
  readonly profileCtx: ProfileContext;
  output: OutputSink;
  config: GatewayConfig;
  authFailedSentinelPath: string;
  bufferFullSentinelPath: string;
  sessionStoppedSentinelPath: string;
  updateAvailableSentinelPath?: string;
  abortSignal: AbortSignal;
  gatewayVersion: string;
  currentVersion?: string;
  binaryPath?: string;
  installSource?: InstallSource;
  devMode?: boolean;
  xstateInspect?: boolean | undefined;
  exitProcess?: () => void;
  sources?: readonly RegisteredSource[];
  onCaptureComplete?: (result: CaptureCycleResult) => void;
  onDrainComplete?: (result: DrainCycleResult) => void;
  onHeartbeatComplete?: (result: HeartbeatCycleResult) => void;
  captureIntervalMs?: number;
  drainIntervalMs?: number;
  heartbeatIntervalMs?: number;
  logger?: Logger;
  httpClient?: HttpClient;
  readBootId?: () => Promise<string>;
}
