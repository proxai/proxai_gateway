export type ServiceManagerPhase =
  | 'not_installed'
  | 'installing'
  | 'installed'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'uninstalling'
  | 'uninstalled'
  | 'failed';

export type ServicePlatform = 'launchd' | 'systemd' | 'windows-task';

export interface ServiceManagerInput {
  readonly platform: ServicePlatform;
}

export interface ServiceManagerContext {
  readonly platform: ServicePlatform;
  lastError: string | null;
}

export type ServiceManagerEvent =
  | { type: 'INSTALL' }
  | { type: 'INSTALL_COMPLETE' }
  | { type: 'START' }
  | { type: 'START_COMPLETE' }
  | { type: 'STOP' }
  | { type: 'STOP_COMPLETE' }
  | { type: 'UNINSTALL' }
  | { type: 'UNINSTALL_COMPLETE' }
  | { type: 'ERROR'; message: string };
