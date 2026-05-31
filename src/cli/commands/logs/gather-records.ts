import type { Database } from 'bun:sqlite';

import { extractConversation } from 'services/prompt-extract';
import type {
  CaptureLookupRaw,
  FailedBatchData,
  LogsQueryOptions,
  PendingBatchData,
} from 'services/buffer/logs-queries.ts';
import {
  queryByCaptureId,
  queryFailed,
  queryPending,
  queryQuarantined,
  queryUploaded,
} from 'services/buffer/logs-queries.ts';

import { parseSinceDuration } from 'cli/commands/tail/filter.ts';
import type {
  CaptureLookup,
  FailedRecord,
  LogsCommandOptions,
  LogsFrame,
  PendingRecord,
} from 'cli/commands/logs/logs.types.ts';

const DEFAULT_LIMIT = 50;

function parseSinceToIso(since: string): string | undefined {
  const ms = parseSinceDuration(since);
  if (ms === null) return undefined;
  return new Date(Date.now() - ms).toISOString();
}

function buildQueryOpts(options: LogsCommandOptions): LogsQueryOptions {
  const limit = options.lines ?? DEFAULT_LIMIT;
  const opts: LogsQueryOptions = { limit };
  if (options.source !== undefined) opts.sourceApp = options.source;
  const sinceIso = options.since !== undefined ? parseSinceToIso(options.since) : undefined;
  if (sinceIso !== undefined) opts.sinceIso = sinceIso;
  return opts;
}

function toFailedRecord(data: FailedBatchData): FailedRecord {
  const conv = extractConversation({
    sourceApp: data.sourceApp,
    bodyFormat: data.bodyFormat,
    body: data.body,
  });
  return {
    captureId: data.captureId,
    sourceApp: data.sourceApp,
    capturedAtUtc: data.capturedAtUtc,
    sourcePath: data.sourcePath,
    sourcePathHash: data.sourcePathHash,
    attempts: data.attempts,
    lastError: data.lastError,
    userPrompt: conv.userPrompt,
    assistantResponse: conv.assistantResponse,
    watermarkKind: data.watermarkKind,
    watermarkStart: data.watermarkStart,
    watermarkEnd: data.watermarkEnd,
    watermarkTable: data.watermarkTable,
    agentSchemaVersion: data.agentSchemaVersion,
    gatewayVersion: data.gatewayVersion,
    sourceInode: data.sourceInode,
    sizeBytes: data.sizeBytes,
  };
}

function toPendingRecord(data: PendingBatchData): PendingRecord {
  const conv = extractConversation({
    sourceApp: data.sourceApp,
    bodyFormat: data.bodyFormat,
    body: data.body,
  });
  return {
    captureId: data.captureId,
    sourceApp: data.sourceApp,
    capturedAtUtc: data.capturedAtUtc,
    sourcePath: data.sourcePath,
    sourcePathHash: data.sourcePathHash,
    attempts: data.attempts,
    userPrompt: conv.userPrompt,
    assistantResponse: conv.assistantResponse,
    watermarkKind: data.watermarkKind,
    watermarkStart: data.watermarkStart,
    watermarkEnd: data.watermarkEnd,
    watermarkTable: data.watermarkTable,
    agentSchemaVersion: data.agentSchemaVersion,
    gatewayVersion: data.gatewayVersion,
    sourceInode: data.sourceInode,
    sizeBytes: data.sizeBytes,
  };
}

function toDetail(raw: CaptureLookupRaw): CaptureLookup {
  if (raw.kind === 'uploaded') return { kind: 'uploaded', record: raw.record };
  if (raw.kind === 'failed') return { kind: 'failed', record: toFailedRecord(raw.record) };
  return { kind: 'pending', record: toPendingRecord(raw.record) };
}

function emptyLists(): Pick<LogsFrame, 'uploaded' | 'failed' | 'quarantined' | 'pending'> {
  return { uploaded: [], failed: [], quarantined: [], pending: [] };
}

export function gatherLogsFrame(db: Database, options: LogsCommandOptions): LogsFrame {
  if (options.id !== undefined) {
    const raw = queryByCaptureId(db, options.id);
    return { ...emptyLists(), detail: raw !== null ? toDetail(raw) : null, idQuery: options.id };
  }

  const queryOpts = buildQueryOpts(options);

  if (options.failed === true) {
    return {
      ...emptyLists(),
      failed: queryFailed(db, queryOpts).map(toFailedRecord),
      quarantined: queryQuarantined(db, queryOpts),
      detail: null,
      idQuery: null,
    };
  }

  if (options.pending === true) {
    return {
      ...emptyLists(),
      pending: queryPending(db, queryOpts).map(toPendingRecord),
      detail: null,
      idQuery: null,
    };
  }

  return {
    ...emptyLists(),
    uploaded: queryUploaded(db, queryOpts),
    detail: null,
    idQuery: null,
  };
}
