export type ProfileName = 'prod' | 'dev';

export interface ProfileSentinelPaths {
  readonly authFailed: string;
  readonly bufferFull: string;
  readonly sessionStopped: string;
  readonly consent: string;
  readonly updateAvailable: string;
}

export interface ProfileContext {
  readonly name: ProfileName;
  readonly isDev: boolean;
  readonly configDir: string;
  readonly configFilePath: string;
  readonly bufferDbPath: string;
  readonly logDir: string;
  readonly sentinels: ProfileSentinelPaths;
  readonly controlSocketPath: string;
  readonly defaultNestBaseUrl: string;
}

export const VALID_PROFILES: readonly ProfileName[] = ['prod', 'dev'];
