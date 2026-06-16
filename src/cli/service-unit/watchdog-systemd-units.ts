import type { ProfileName } from 'core/io/fs/profile.types.ts';
import { watchdogSystemdServiceName } from 'cli/service-unit/watchdog-labels.ts';

export interface WatchdogSystemdInput {
  programPath: string;
  profile: ProfileName;
}

export function buildWatchdogSystemdService(input: WatchdogSystemdInput): string {
  return `[Unit]
Description=ProxAI Gateway Watchdog (${input.profile})

[Service]
Type=oneshot
ExecStart=${input.programPath} rescue --profile ${input.profile}
TimeoutStartSec=120
`;
}

export function buildWatchdogSystemdTimer(input: WatchdogSystemdInput): string {
  const serviceName = watchdogSystemdServiceName(input.profile);
  return `[Unit]
Description=ProxAI Gateway Watchdog timer (${input.profile})

[Timer]
Unit=${serviceName}
OnBootSec=2min
OnUnitActiveSec=15min
AccuracySec=2min
Persistent=true

[Install]
WantedBy=timers.target
`;
}
