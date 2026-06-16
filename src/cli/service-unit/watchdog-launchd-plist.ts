import type { ProfileName } from 'core/io/fs/profile.types.ts';
import { watchdogLaunchdLabel } from 'cli/service-unit/watchdog-labels.ts';

export interface WatchdogLaunchdPlistInput {
  programPath: string;
  profile: ProfileName;
  stdoutPath?: string;
  stderrPath?: string;
}

export function buildWatchdogLaunchdPlist(input: WatchdogLaunchdPlistInput): string {
  const label = watchdogLaunchdLabel(input.profile);
  const args = ['rescue', '--profile', input.profile];
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
    <key>StartInterval</key>
    <integer>900</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
${stdoutBlock}${stderrBlock}</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
