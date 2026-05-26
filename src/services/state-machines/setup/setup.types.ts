export type SetupPhase =
  | 'prompting_consent'
  | 'collecting_ingestion_key'
  | 'verifying_key'
  | 'writing_config'
  | 'writing_consent_sentinel'
  | 'done'
  | 'cancelled'
  | 'failed';

export interface SetupContext {
  consentAccepted: boolean;
  ingestionKeyMasked: string | null;
  keyVerified: boolean;
  configWritten: boolean;
  sentinelWritten: boolean;
  lastError: string | null;
}

export type SetupEvent =
  | { type: 'CONSENT_ACCEPTED' }
  | { type: 'CONSENT_DECLINED' }
  | { type: 'KEY_PROVIDED'; maskedKey: string }
  | { type: 'KEY_VERIFY_SUCCESS' }
  | { type: 'KEY_VERIFY_FAILURE'; reason: string }
  | { type: 'CONFIG_WRITTEN' }
  | { type: 'SENTINEL_WRITTEN' }
  | { type: 'ERROR'; message: string };
