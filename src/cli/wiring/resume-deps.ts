import { consoleOutput } from 'cli/output.ts';
import type { ResumeCommandDeps } from 'cli/commands/resume.ts';
import { pausedSentinelPath } from 'core/io/fs';

export function buildResumeDeps(): ResumeCommandDeps {
  return {
    output: consoleOutput(),
    sentinelPath: pausedSentinelPath(),
  };
}
