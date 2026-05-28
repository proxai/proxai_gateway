import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import type {
  DoctorCommandDeps,
  DoctorCommandOptions,
  Finding,
} from 'cli/commands/doctor/doctor.types.ts';
import { gatherSignals } from 'cli/commands/doctor/gather-signals.ts';
import { renderDoctorOutput } from 'cli/commands/doctor/render-doctor.ts';
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
  _options: DoctorCommandOptions,
): Promise<CommandResult> {
  deps.output.info('Gathering diagnostic signals...');

  const signals = await gatherSignals(deps);
  const findings = runCheckers(signals);
  const output = renderDoctorOutput(findings, signals);

  deps.output.info(output);

  return { exitCode: EXIT_CODE.ok };
}
