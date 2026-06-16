import { homedir } from 'node:os';
import { join } from 'node:path';

import { LAUNCHD_LABEL } from 'cli/cli.constants.ts';

export interface LaunchdPlistInput {
  programPath: string;
  programArgs?: readonly string[];
  stdoutPath?: string;
  stderrPath?: string;
  label?: string;
}

export function buildLaunchdPlist(input: LaunchdPlistInput): string {
  const label = input.label ?? LAUNCHD_LABEL;
  const args = input.programArgs ?? ['run'];
  const argsXml = [input.programPath, ...args]
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join('\n');

  const stdoutBlock =
    input.stdoutPath !== undefined
      ? `    <key>StandardOutPath</key>\n    <string>${escapeXml(input.stdoutPath)}</string>\n`
      : '';
  const stderrBlock =
    input.stderrPath !== undefined
      ? `    <key>StandardErrorPath</key>\n    <string>${escapeXml(input.stderrPath)}</string>\n`
      : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
${stdoutBlock}${stderrBlock}</dict>
</plist>
`;
}

function launchAgentsDir(): string {
  const testProfileRoot = process.env['PROXAI_TEST_PROFILE_ROOT'];
  if (testProfileRoot !== undefined && testProfileRoot.length > 0) {
    return join(testProfileRoot, 'Library', 'LaunchAgents');
  }
  return join(homedir(), 'Library', 'LaunchAgents');
}

export function defaultLaunchdPlistPath(label: string = LAUNCHD_LABEL): string {
  return join(launchAgentsDir(), `${label}.plist`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
