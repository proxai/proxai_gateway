export const EXIT_CODE = {
  ok: 0,
  error: 1,
  validationError: 2,
  authError: 3,
  notInstalled: 4,
  alreadyInstalled: 5,
  fileUnreadable: 7,
} as const;

export const LAUNCHD_LABEL = 'co.proxai.gateway';
export const SYSTEMD_UNIT_NAME = 'proxai-gateway.service';
