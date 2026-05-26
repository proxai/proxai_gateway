export const EXIT_CODE = {
  ok: 0,
  error: 1,
  validationError: 2,
  authError: 3,
  notInstalled: 4,
  alreadyInstalled: 5,
  fileUnreadable: 7,
  // Auto-upgrade replaced the binary; exit non-zero so launchd / systemd /
  // schtasks respawn the daemon under the new binary. Value matches BSD
  // EX_TEMPFAIL semantics ("temporary failure, please retry").
  upgradeRespawn: 75,
} as const;

export const LAUNCHD_LABEL = 'co.proxai.gateway';
export const SYSTEMD_UNIT_NAME = 'proxai-gateway.service';
export const WINDOWS_TASK_NAME = 'ProxAI Gateway';
