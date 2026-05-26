import type {
  UnifiedStatusSummary,
  UnifiedSummaryInputs,
} from 'cli/commands/status/unified-summary.types.ts';

export function deriveUnifiedSummary(inputs: UnifiedSummaryInputs): UnifiedStatusSummary {
  if (!inputs.configured) {
    return {
      level: 'inactive',
      headline: 'Not set up yet.',
      hint: 'Run `proxai-gateway setup` to connect your account.',
    };
  }
  if (inputs.authFailed) {
    return {
      level: 'error',
      headline: 'Account authentication failed.',
      hint: 'Run `proxai-gateway setup --force` to reconfigure your account.',
    };
  }
  if (inputs.sessionStopped) {
    return {
      level: 'warning',
      headline: 'Account configured. Session stopped for this boot.',
      hint: 'Reboot your machine or run `proxai-gateway start` to resume.',
    };
  }
  if (inputs.paused) {
    const reason = inputs.pausedReason.length > 0 ? ` (${inputs.pausedReason})` : '';
    return {
      level: 'warning',
      headline: `Account configured. Daemon paused${reason}.`,
      hint: 'Run `proxai-gateway resume` to resume capturing.',
    };
  }
  if (inputs.bufferFull) {
    const pct = formatPressurePercent(inputs.bufferFullPendingBytes, inputs.bufferFullThreshold);
    return {
      level: 'warning',
      headline: `Account configured. Buffer almost full${pct}.`,
      hint: 'Waiting for uploads to free space. No action needed.',
    };
  }
  if (!inputs.daemonRunning) {
    return {
      level: 'warning',
      headline: 'Account configured. Background service is not running.',
      hint: 'Run `proxai-gateway start` to start the background service.',
    };
  }
  return {
    level: 'ok',
    headline: 'Account configured. Background service is running.',
    hint: null,
  };
}

function formatPressurePercent(pending: number | null, threshold: number | null): string {
  if (pending === null || threshold === null || threshold === 0) return '';
  const pct = Math.min(100, Math.round((pending / threshold) * 100));
  return ` (${pct.toString()}%)`;
}
