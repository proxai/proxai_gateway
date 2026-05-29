import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import type {
  DoctorCommandDeps,
  DoctorCommandOptions,
  Finding,
} from 'cli/commands/doctor/doctor.types.ts';
import { gatherSignals } from 'cli/commands/doctor/gather-signals.ts';
import { renderDoctorOutput, generateDoctorHtml } from 'cli/commands/doctor/render-doctor.ts';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import chalk from 'chalk';
import { readDevModeSentinel } from 'core/io/fs/dev-mode-sentinel.ts';
import { profileRootDir } from 'core/io/fs/profile.ts';
import {
  checkA1NotSetUp,
  checkA2UnitNotRegistered,
  checkA3StoppedByUser,
  checkA4Crashed,
  checkA5Wedged,
} from 'cli/commands/doctor/checkers/lifecycle.ts';
import {
  checkB1InvalidKey,
  checkB2AuthUnconfirmedLoop,
  checkB3IngestionKeyAuthError,
} from 'cli/commands/doctor/checkers/auth.ts';
import {
  checkC1RateLimited,
  checkC2NetworkFailure,
  checkC3DrainWedged,
  checkC4BufferRecovery,
  checkC5BufferOscillating,
  checkC6ParserValidationErrors,
  checkC7QuarantinedRows,
} from 'cli/commands/doctor/checkers/upload.ts';
import {
  checkD1NoAgentActivity,
  checkD2OneSourceErroring,
} from 'cli/commands/doctor/checkers/capture.ts';
import {
  checkE1StaleBinary,
  checkE2BrewUpdatePending,
  checkE3WriteFailed,
  checkE4SuccessOldVersionRunning,
} from 'cli/commands/doctor/checkers/binary.ts';
import {
  checkF1ConfigDirNotWritable,
  checkF2DiskSpaceLow,
  checkF3LogDirNotWritable,
  checkF4ClockSkew,
  checkF5LinuxNoLinger,
  checkF6WindowsUserUnresolvable,
  checkF7MacOsQuarantine,
} from 'cli/commands/doctor/checkers/filesystem.ts';
import {
  checkG1ReceiptsTableReadable,
  checkG2BufferDbCorrupt,
  checkG3RegressionLoop,
} from 'cli/commands/doctor/checkers/data-integrity.ts';

import type { DoctorSignals } from 'cli/commands/doctor/doctor.types.ts';

type Checker = (signals: DoctorSignals) => Finding | null;

const ALL_CHECKERS: readonly Checker[] = [
  checkA1NotSetUp,
  checkA2UnitNotRegistered,
  checkA3StoppedByUser,
  checkA4Crashed,
  checkA5Wedged,
  checkB1InvalidKey,
  checkB2AuthUnconfirmedLoop,
  checkB3IngestionKeyAuthError,
  checkC1RateLimited,
  checkC2NetworkFailure,
  checkC3DrainWedged,
  checkC4BufferRecovery,
  checkC5BufferOscillating,
  checkC6ParserValidationErrors,
  checkC7QuarantinedRows,
  checkD1NoAgentActivity,
  checkD2OneSourceErroring,
  checkE1StaleBinary,
  checkE2BrewUpdatePending,
  checkE3WriteFailed,
  checkE4SuccessOldVersionRunning,
  checkF1ConfigDirNotWritable,
  checkF2DiskSpaceLow,
  checkF3LogDirNotWritable,
  checkF4ClockSkew,
  checkF5LinuxNoLinger,
  checkF6WindowsUserUnresolvable,
  checkF7MacOsQuarantine,
  checkG1ReceiptsTableReadable,
  checkG2BufferDbCorrupt,
  checkG3RegressionLoop,
];

function runCheckers(signals: DoctorSignals): Finding[] {
  const findings: Finding[] = [];
  for (const checker of ALL_CHECKERS) {
    const result = checker(signals);
    if (result !== null) {
      findings.push(result);
    }
  }
  return findings;
}

export async function runDoctor(
  deps: DoctorCommandDeps,
  options: DoctorCommandOptions,
): Promise<CommandResult> {
  deps.output.info('Gathering diagnostic signals...');

  const signals = await gatherSignals(deps);
  const findings = runCheckers(signals);

  const isDevMode = await readDevModeSentinel(join(profileRootDir(), 'DEV_MODE'));
  const isCompact = options.compact === true || !isDevMode;
  const output = renderDoctorOutput(findings, signals, isCompact);

  deps.output.info(output);

  if (options.output !== undefined) {
    const MONTHS = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const now = new Date();
    const monthStr = MONTHS[now.getMonth()];
    const dayStr = String(now.getDate()).padStart(2, '0');
    const hourStr = String(now.getHours()).padStart(2, '0');
    const minStr = String(now.getMinutes()).padStart(2, '0');
    const secStr = String(now.getSeconds()).padStart(2, '0');

    const filename = `gateway-doctor-${monthStr}_${dayStr}_${hourStr}_${minStr}_${secStr}.html`;

    const homedirPath = homedir();
    let targetPath: string;
    if (options.output === true || options.output === '') {
      targetPath = join(homedirPath, 'Desktop', filename);
    } else {
      const rawPath = String(options.output);
      const resolved = resolve(rawPath);
      if (rawPath.endsWith('/') || !rawPath.split('/').pop()?.includes('.')) {
        targetPath = join(resolved, filename);
      } else {
        targetPath = resolved;
      }
    }

    const htmlContent = generateDoctorHtml(findings, signals, now.toLocaleString());
    await writeFile(targetPath, htmlContent, 'utf-8');
    deps.output.success(`Diagnostic HTML report exported to: ${chalk.cyan(targetPath)}`);
  }

  return { exitCode: EXIT_CODE.ok };
}
