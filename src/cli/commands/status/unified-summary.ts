import type {
  UnifiedStatusSummary,
  UnifiedSummaryInputs,
} from 'cli/commands/status/unified-summary.types.ts';

export function deriveUnifiedSummary(inputs: UnifiedSummaryInputs): UnifiedStatusSummary {
  const isDevProfile = inputs.profileName === 'dev';

  if (!inputs.configured) {
    return {
      level: 'inactive',
      headline: 'Not set up yet.',
      hint: isDevProfile
        ? 'Run `proxai-gateway setup --profile dev` to connect your account.'
        : 'Run `proxai-gateway setup` to connect your account.',
    };
  }
  if (inputs.authFailed) {
    return {
      level: 'error',
      headline: 'Account authentication failed.',
      hint: isDevProfile
        ? 'Run `proxai-gateway setup --profile dev --force` to reconfigure your account.'
        : 'Run `proxai-gateway setup --force` to reconfigure your account.',
    };
  }
  if (inputs.sessionStopped) {
    return {
      level: 'warning',
      headline: isDevProfile
        ? 'Account configured. Dev daemon stopped for this boot.'
        : 'Account configured. Session stopped for this boot.',
      hint: isDevProfile
        ? 'Restart your dev daemon to resume.'
        : 'Reboot your machine or run `proxai-gateway start` to resume.',
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
    if (inputs.daemonInferredAlive) {
      const age = formatLastCycleAge(inputs.daemonLastCycleAt);
      const agePrefix = age === null ? '' : `Last cycle ${age} · `;
      if (isDevProfile) {
        return {
          level: 'ok',
          headline: 'Dev daemon active — running locally.',
          hint: `${agePrefix}Stop with Ctrl-C in the daemon terminal.`,
        };
      }
      return {
        level: 'ok',
        headline: 'Account configured. Background service is running (not registered with OS).',
        hint: `${agePrefix}Run \`proxai-gateway start\` to register with launchd/systemd for auto-restart.`,
      };
    }
    if (isDevProfile) {
      return {
        level: 'warning',
        headline: 'Account configured. Dev daemon is not running.',
        hint: 'Start it with `bun run dev` or `dist/<platform>/proxai-gateway run`.',
      };
    }
    return {
      level: 'warning',
      headline: 'Account configured. Background service is not running.',
      hint: 'Run `proxai-gateway start` to start the background service.',
    };
  }
  return {
    level: 'ok',
    headline: isDevProfile
      ? 'Account configured. Dev daemon is running.'
      : 'Account configured. Background service is running.',
    hint: null,
  };
}

function formatPressurePercent(pending: number | null, threshold: number | null): string {
  if (pending === null || threshold === null || threshold === 0) return '';
  const pct = Math.min(100, Math.round((pending / threshold) * 100));
  return ` (${pct.toString()}%)`;
}

function formatLastCycleAge(iso: string | null): string | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs.toString()}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60).toString()}m ago`;
  return `${Math.round(secs / 3600).toString()}h ago`;
}
