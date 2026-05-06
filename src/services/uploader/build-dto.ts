import type { StoredBatch } from 'services/buffer';
import type { RawRecordDTO, Watermark } from 'services/contract';

export function buildRawRecordDTO(batch: StoredBatch, hostId: string): RawRecordDTO {
  const body = Buffer.from(batch.body).toString('base64');

  return {
    capture_id: batch.captureId,
    host_id: hostId,
    source_app: batch.sourceApp,
    source_kind: batch.sourceKind,
    source_path: batch.sourcePath,
    source_path_hash: batch.sourcePathHash,
    source_inode: batch.sourceInode,
    watermark: buildWatermark(batch),
    agent_schema_version: batch.agentSchemaVersion,
    gateway_version: batch.gatewayVersion,
    captured_at_utc: batch.capturedAtUtc,
    body_format: batch.bodyFormat,
    body_compression: batch.bodyCompression,
    body,
  };
}

function buildWatermark(batch: StoredBatch): Watermark {
  if (batch.watermarkKind === 'byte_range') {
    return {
      kind: 'byte_range',
      start: batch.watermarkStart,
      end: batch.watermarkEnd,
      table: null,
    };
  }
  return {
    kind: 'rowid_range',
    start: batch.watermarkStart,
    end: batch.watermarkEnd,
    table: batch.watermarkTable,
  };
}
