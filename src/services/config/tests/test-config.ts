import type {
  AccountConfig,
  BackendConfig,
  CaptureConfig,
  GatewayConfig,
  LoggingConfig,
  StaleBinaryConfig,
} from 'services/config/config.types.ts';

export const TEST_ACCOUNT_CONFIG: AccountConfig = {
  apiKey: 'test-api-key',
  userId: 'test-user',
  hostId: 'test-host',
  installedAt: '2026-01-01T00:00:00.000Z',
  installSource: 'brew',
};

export const TEST_BACKEND_CONFIG: BackendConfig = {
  ingestUrl: 'https://test.example/ingest',
  verifyKeyUrl: 'https://test.example/verify',
  watermarksUrl: 'https://test.example/watermarks',
  registerHostIdUrl: 'https://test.example/register',
};

export const TEST_CAPTURE_CONFIG: CaptureConfig = {
  pollIntervalSec: 60,
  bufferPath: '/tmp/test-buffer.db',
  receiptRetentionDays: 30,
  failedRetentionDays: 30,
  bufferSoftPauseBytes: 50_000_000_000,
  bufferSoftResumeBytes: 45_000_000_000,
  uploadMaxBatchesPerSec: 1,
  uploadMaxBytesPerMinute: 1_000_000,
  uploadBackoffOn429Multiplier: 2,
};

export const TEST_LOGGING_CONFIG: LoggingConfig = {
  level: 'info',
  logDir: '/tmp/test-logs',
};

export const TEST_STALE_BINARY_CONFIG: StaleBinaryConfig = {
  warnAfterDays: 30,
  pauseAfterDays: 60,
};

export const TEST_GATEWAY_CONFIG: GatewayConfig = {
  account: TEST_ACCOUNT_CONFIG,
  backend: TEST_BACKEND_CONFIG,
  capture: TEST_CAPTURE_CONFIG,
  logging: TEST_LOGGING_CONFIG,
  staleBinary: TEST_STALE_BINARY_CONFIG,
};

export function makeTestGatewayConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    account: { ...TEST_ACCOUNT_CONFIG, ...overrides.account },
    backend: { ...TEST_BACKEND_CONFIG, ...overrides.backend },
    capture: { ...TEST_CAPTURE_CONFIG, ...overrides.capture },
    logging: { ...TEST_LOGGING_CONFIG, ...overrides.logging },
    staleBinary: { ...TEST_STALE_BINARY_CONFIG, ...overrides.staleBinary },
  };
}
