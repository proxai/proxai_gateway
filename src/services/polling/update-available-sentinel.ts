import { sentinelHandle } from 'core/io/fs';
import { nowIsoUtc } from 'core/utils';

export interface UpdateAvailableSentinelPayload {
  latestVersion: string;
  currentVersion: string;
  detectedAt: string;
  assetUrl?: string;
}

export interface UpdateAvailableSentinelInput {
  latest_version: string;
  current_version: string;
  detected_at?: string;
  asset_url?: string;
}

export async function isUpdateAvailable(sentinelPath: string): Promise<boolean> {
  return sentinelHandle(sentinelPath).exists();
}

export async function writeUpdateAvailableSentinel(
  sentinelPath: string,
  input: UpdateAvailableSentinelInput,
  now: () => string = nowIsoUtc,
): Promise<void> {
  const payload: Record<string, string> = {
    latest_version: input.latest_version,
    current_version: input.current_version,
    detected_at: input.detected_at ?? now(),
  };
  if (input.asset_url !== undefined) payload['asset_url'] = input.asset_url;
  await sentinelHandle(sentinelPath).write(JSON.stringify(payload));
}

export async function readUpdateAvailableSentinel(
  sentinelPath: string,
): Promise<UpdateAvailableSentinelPayload | null> {
  const text = await sentinelHandle(sentinelPath).read();
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const latestVersion =
      typeof parsed['latest_version'] === 'string' ? parsed['latest_version'] : '';
    const currentVersion =
      typeof parsed['current_version'] === 'string' ? parsed['current_version'] : '';
    const detectedAt = typeof parsed['detected_at'] === 'string' ? parsed['detected_at'] : '';
    if (latestVersion.length === 0 || currentVersion.length === 0) return null;
    const result: UpdateAvailableSentinelPayload = {
      latestVersion,
      currentVersion,
      detectedAt,
    };
    if (typeof parsed['asset_url'] === 'string') {
      result.assetUrl = parsed['asset_url'];
    }
    return result;
  } catch {
    return null;
  }
}

export async function clearUpdateAvailableSentinel(sentinelPath: string): Promise<void> {
  await sentinelHandle(sentinelPath).remove();
}
