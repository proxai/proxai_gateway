import type { OutputSink } from 'cli/cli.types.ts';
import type { PromptSink } from 'cli/prompts.ts';
import type { ServiceManager } from 'cli/service-manager';
import type { InstallSource } from 'services/config';
import type { HttpClient } from 'services/http';

export interface SetupCommandDeps {
  output: OutputSink;
  prompts: PromptSink;
  configPath: string;
  bufferDbPath: string;
  logDir: string;
  authFailedSentinelPath: string;
  serviceUnitPath: string | null;
  sessionStoppedSentinelPath?: string;
  programPath: string;
  configExists: () => Promise<boolean>;
  httpClientFactory: (apiKey: string, hostId: string) => HttpClient;
  readMachineUuid?: () => Promise<string>;
  now?: () => string;
  platform: NodeJS.Platform;
  windowsUserId?: string;
  serviceManager?: ServiceManager;
}

export interface SetupCommandOptions {
  apiKey?: string;
  installSource?: InstallSource;
  skipKeyFormatCheck?: boolean;
  noStart?: boolean;
  force?: boolean;
}
