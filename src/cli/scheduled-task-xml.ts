import { join } from 'node:path';

import { WINDOWS_TASK_NAME } from 'cli/cli.constants.ts';
import { configDir } from 'core/io/fs';

export interface ScheduledTaskXmlInput {
  programPath: string;
  programArgs?: readonly string[];
  taskName?: string;
  userId?: string;
}

export function buildScheduledTaskXml(input: ScheduledTaskXmlInput): string {
  const args = input.programArgs ?? ['run'];
  const userId = input.userId ?? 'INTERACTIVE';
  const argumentsXml = escapeXml(args.join(' '));

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>ProxAI Gateway daemon</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(input.programPath)}</Command>
      <Arguments>${argumentsXml}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function defaultScheduledTaskXmlPath(): string {
  return join(configDir(), 'scheduled-task.xml');
}

export function defaultScheduledTaskName(): string {
  return WINDOWS_TASK_NAME;
}

/**
 * Encodes XML text as UTF-16 LE with a BOM. Windows `schtasks /Create /XML`
 * requires UTF-16 input — UTF-8 bytes are silently misinterpreted.
 */
export function encodeScheduledTaskXml(xml: string): Uint8Array {
  const bom = '﻿';
  const text = bom + xml;
  const buffer = new ArrayBuffer(text.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < text.length; i++) {
    view.setUint16(i * 2, text.charCodeAt(i), true);
  }
  return new Uint8Array(buffer);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
