import type { GatewayConfig, InstallSource } from 'services/config';
import { runAutoUpgrade as defaultRunAutoUpgrade } from 'services/upgrade';

export type RunAutoUpgradeFn = typeof defaultRunAutoUpgrade;

export interface AutoUpgradeFromConfigInputs {
  binaryPath: string;
  currentVersion: string;
  devMode: boolean;
  loadConfig: () => Promise<GatewayConfig>;
  exitProcess: () => void;
  runAutoUpgrade?: RunAutoUpgradeFn;
}

export async function autoUpgradeFromConfig(inputs: AutoUpgradeFromConfigInputs): Promise<void> {
  const runner = inputs.runAutoUpgrade ?? defaultRunAutoUpgrade;
  let installSource: InstallSource | undefined;
  try {
    const cfg = await inputs.loadConfig();
    installSource = cfg.account.installSource;
  } catch {
    return;
  }
  const upgradeInputs: Parameters<RunAutoUpgradeFn>[0] = {
    binaryPath: inputs.binaryPath,
    currentVersion: inputs.currentVersion,
    devMode: inputs.devMode,
    exitProcess: inputs.exitProcess,
  };
  if (installSource !== undefined) upgradeInputs.installSource = installSource;
  await runner(upgradeInputs);
}
