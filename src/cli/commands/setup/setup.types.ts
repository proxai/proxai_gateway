import type { OutputSink } from 'cli/cli.types.ts';
import type { PromptSink } from 'cli/prompts.ts';
import type { ServiceManager } from 'cli/service-manager';
import type { WatchdogManager } from 'cli/watchdog-manager/types.ts';
import type { InstallSource } from 'services/config';
import type { HttpClient } from 'services/http';

export interface SetupCommandDeps {
  output: OutputSink;
  prompts: PromptSink;
  configPath: string;
  bufferDbPath: string;
  logDir: string;
  defaultNestBaseUrl: string;
  authFailedSentinelPath: string;
  bufferFullSentinelPath?: string;
  serviceUnitPath: string | null;
  sessionStoppedSentinelPath?: string;
  consentSentinelPath?: string;
  programPath: string;
  configExists: () => Promise<boolean>;
  httpClientFactory: (apiKey: string, hostId: string) => HttpClient;
  readMachineUuid?: () => Promise<string>;
  readBootId?: () => Promise<string>;
  readLastSuccessAt?: () => Promise<string | null>;
  now?: () => string;
  platform: NodeJS.Platform;
  windowsUserId?: string;
  serviceManager?: ServiceManager;
  watchdogUnitPaths?: {
    timerPath?: string;
    servicePath?: string;
    plistPath?: string;
    xmlPath?: string;
  };
  watchdogManager?: WatchdogManager;
}

export interface SetupCommandOptions {
  apiKey?: string;
  installSource?: InstallSource;
  skipKeyFormatCheck?: boolean;
  noStart?: boolean;
  yes?: boolean;
}
