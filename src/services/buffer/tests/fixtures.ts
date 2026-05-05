import { generateUuidV7 } from 'core/utils';
import type { NewBatch } from 'services/buffer';

export function newBatch(overrides: Partial<NewBatch> = {}): NewBatch {
  return {
    captureId: generateUuidV7(),
    sourceApp: 'claude-code',
    sourceKind: 'jsonl_append',
    sourcePath: '/Users/test/.claude/session.jsonl',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: 12345,
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: 1024,
    watermarkTable: null,
    agentSchemaVersion: '2.1.122',
    gatewayVersion: '@proxai/gateway 0.1.0',
    capturedAtUtc: '2026-04-29T10:42:00.123Z',
    bodyFormat: 'jsonl',
    bodyCompression: 'zstd',
    body: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    ...overrides,
  };
}
