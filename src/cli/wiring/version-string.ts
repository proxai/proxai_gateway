import {
  formatVersionString,
  readInstallSourceSync,
  type VersionInstallSource,
} from 'cli/version-string.ts';

export interface BuildVersionStringInputs {
  version: string;
  installSourcePath: string;
}

export function buildVersionString(inputs: BuildVersionStringInputs): string {
  const source: VersionInstallSource = readInstallSourceSync(inputs.installSourcePath);
  return formatVersionString(inputs.version, source);
}
