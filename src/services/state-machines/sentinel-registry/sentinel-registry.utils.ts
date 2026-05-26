import type {
  SentinelGateDecision,
  SentinelRegistryContext,
} from 'services/state-machines/sentinel-registry/sentinel-registry.types.ts';

export function gateDecision(context: SentinelRegistryContext): SentinelGateDecision {
  if (context.authPayload !== null) {
    return { skipCapture: true, skipDrain: true, skipHeartbeat: false, reason: 'auth' };
  }
  if (context.pausePayload !== null) {
    return { skipCapture: true, skipDrain: true, skipHeartbeat: true, reason: 'paused' };
  }
  if (context.bufferFullPayload !== null) {
    return { skipCapture: true, skipDrain: false, skipHeartbeat: false, reason: 'buffer_full' };
  }
  return { skipCapture: false, skipDrain: false, skipHeartbeat: false, reason: null };
}
