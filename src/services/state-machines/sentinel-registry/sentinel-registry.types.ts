export interface AuthFailedPayload {
  readonly reason: string;
  readonly detectedAtUtc: string;
}

export interface BufferFullPayload {
  readonly pendingBytes: number;
  readonly thresholdBytes: number;
  readonly setAtUtc: string;
}

export interface SessionStoppedPayload {
  readonly bootId: string;
  readonly setAtUtc: string;
}

export interface BrewUpdatePayload {
  readonly latestVersion: string;
  readonly currentVersion: string;
  readonly detectedAtUtc: string;
  readonly assetUrl: string | null;
}

export interface SentinelRegistryContext {
  authPayload: AuthFailedPayload | null;
  bufferFullPayload: BufferFullPayload | null;
  sessionStoppedPayload: SessionStoppedPayload | null;
  brewUpdatePayload: BrewUpdatePayload | null;
  brewLatestKnownVersion: string | null;
}

export type SentinelRegistryEvent =
  | { type: 'AUTH_FAILED_WRITTEN'; payload: AuthFailedPayload }
  | { type: 'AUTH_FAILED_CLEARED' }
  | { type: 'PRESSURE_CROSSED_PAUSE'; payload: BufferFullPayload }
  | { type: 'PRESSURE_CROSSED_RESUME' }
  | { type: 'STOP_REQUESTED'; payload: SessionStoppedPayload }
  | { type: 'BOOT_ID_MISMATCH' }
  | { type: 'BREW_UPDATE_AVAILABLE'; payload: BrewUpdatePayload }
  | { type: 'BREW_UP_TO_DATE'; latestVersion: string }
  | { type: 'BREW_VERSION_UNKNOWN' };

export interface SentinelGateDecision {
  readonly skipCapture: boolean;
  readonly skipDrain: boolean;
  readonly skipHeartbeat: boolean;
  readonly reason: 'auth' | 'buffer_full' | null;
}
