import type { ServerWatermark } from 'services/http/http.types.ts';

export function parseWatermarkRegression(
  text: string,
): { currentServerWatermarkEnd: number; sourcePathHash: string } | null {
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;
  if (r['error'] !== 'watermark_regression') return null;
  const watermark = r['current_server_watermark_end'];
  const hash = r['source_path_hash'];
  if (typeof watermark !== 'number' || !Number.isFinite(watermark)) return null;
  if (typeof hash !== 'string' || hash.length === 0) return null;
  return { currentServerWatermarkEnd: watermark, sourcePathHash: hash };
}

export function parseServerWatermark(item: unknown): ServerWatermark | null {
  if (item === null || typeof item !== 'object') return null;
  const r = item as Record<string, unknown>;
  const sourceApp = typeof r['source_app'] === 'string' ? r['source_app'] : null;
  const sourcePathHash = typeof r['source_path_hash'] === 'string' ? r['source_path_hash'] : null;
  const watermarkKindRaw = typeof r['watermark_kind'] === 'string' ? r['watermark_kind'] : null;
  const watermarkEnd = typeof r['watermark_end'] === 'number' ? r['watermark_end'] : null;
  const watermarkTableRaw = r['watermark_table'];
  const watermarkTable =
    watermarkTableRaw === null || watermarkTableRaw === undefined
      ? null
      : typeof watermarkTableRaw === 'string'
        ? watermarkTableRaw
        : null;
  const lastDeliveredAt =
    typeof r['last_delivered_at'] === 'string' ? r['last_delivered_at'] : null;

  if (
    sourceApp === null ||
    sourcePathHash === null ||
    watermarkKindRaw === null ||
    watermarkEnd === null ||
    lastDeliveredAt === null
  ) {
    return null;
  }
  if (watermarkKindRaw !== 'byte_range' && watermarkKindRaw !== 'rowid_range') {
    return null;
  }
  return {
    sourceApp,
    sourcePathHash,
    watermarkKind: watermarkKindRaw,
    watermarkEnd,
    watermarkTable,
    lastDeliveredAt,
  };
}
