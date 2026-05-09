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
  const restartSec = input.restartSec ?? 10;

  return `[Unit]
Description=${desc}
After=network-online.target

[Service]
Type=simple
ExecStart=${exec}
Restart=on-failure
RestartSec=${restartSec.toString()}s

[Install]
WantedBy=default.target
`;
}

export function defaultSystemdUnitPath(unitName: string = SYSTEMD_UNIT_NAME): string {
  return join(homedir(), '.config', 'systemd', 'user', unitName);
}
