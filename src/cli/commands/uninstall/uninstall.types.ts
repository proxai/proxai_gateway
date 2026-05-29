import type { OutputSink } from 'cli/cli.types.ts';
import type { PromptSink } from 'cli/prompts.ts';
import type { ServiceManager } from 'cli/service-manager';
import type {
  DirectBinaryRemover,
  PackageManagerSweep,
  ShellPathCleaner,
} from 'services/uninstall';

export interface UninstallCommandDeps {
  output: OutputSink;
  prompts: PromptSink;
  configPath: string;
  configDir: string;
  logDir: string;
  serviceUnitPath: string | null;
  serviceManager: ServiceManager;
  devServiceManager: ServiceManager | null;
  devServiceUnitPath: string | null;
  devConfigDir: string;
  devLogDir: string;
  profileRootDir: string;
  profileLogDirRoot: string;
  configExists: () => Promise<boolean>;
  sweep?: PackageManagerSweep;
  binaryRemover?: DirectBinaryRemover;
  pathCleaner?: ShellPathCleaner;
  installDir?: string;
  currentExecPath?: string;
  isDevMode?: boolean;
}

export interface UninstallCommandOptions {
  reset?: boolean;
  yes?: boolean;
}
