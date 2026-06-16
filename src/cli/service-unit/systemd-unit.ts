import { homedir } from 'node:os';
import { join } from 'node:path';

import { SYSTEMD_UNIT_NAME } from 'cli/cli.constants.ts';

export interface SystemdUnitInput {
  programPath: string;
  programArgs?: readonly string[];
  description?: string;
  restartSec?: number;
}

export function buildSystemdUnit(input: SystemdUnitInput): string {
  const args = input.programArgs ?? ['run'];
  const exec = [input.programPath, ...args].join(' ');
  const desc = input.description ?? 'ProxAI Gateway';
  const restartSec = input.restartSec ?? 5;

  return `[Unit]
Description=${desc}
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${exec}
Restart=always
RestartSec=${restartSec.toString()}s
OOMScoreAdjust=-100

[Install]
WantedBy=default.target
`;
}

function systemdUserDir(): string {
  const testProfileRoot = process.env['PROXAI_TEST_PROFILE_ROOT'];
  if (testProfileRoot !== undefined && testProfileRoot.length > 0) {
    return join(testProfileRoot, '.config', 'systemd', 'user');
  }
  return join(homedir(), '.config', 'systemd', 'user');
}

export function defaultSystemdUnitPath(unitName: string = SYSTEMD_UNIT_NAME): string {
  return join(systemdUserDir(), unitName);
}
