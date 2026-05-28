import { parseSinceDuration } from 'cli/commands/tail/filter.ts';
import type { LogsCommandOptions, LogsFrame } from 'cli/commands/logs/logs.types.ts';
import type { LogsQueryOptions } from 'services/buffer/logs-queries.ts';
import {
  queryFailed,
  queryPending,
  queryQuarantined,
  queryUploaded,
} from 'services/buffer/logs-queries.ts';
import type { Database } from 'bun:sqlite';

function parseSinceToIso(since: string): string | undefined {
  const ms = parseSinceDuration(since);
  if (ms === null) return undefined;
  return new Date(Date.now() - ms).toISOString();
}

function buildQueryOpts(options: LogsCommandOptions): LogsQueryOptions {
  const limit = options.lines ?? 20;
  const opts: LogsQueryOptions = { limit };
  if (options.source !== undefined) opts.sourceApp = options.source;
  const sinceIso = options.since !== undefined ? parseSinceToIso(options.since) : undefined;
  if (sinceIso !== undefined) opts.sinceIso = sinceIso;
  return opts;
}

export function gatherLogsFrame(db: Database, options: LogsCommandOptions): LogsFrame {
  const queryOpts = buildQueryOpts(options);

  if (options.error === true) {
    return {
      uploaded: [],
      failed: queryFailed(db, queryOpts),
      quarantined: queryQuarantined(db, queryOpts),
      pending: [],
    };
  }

  if (options.pending === true) {
    return {
      uploaded: [],
      failed: [],
      quarantined: [],
      pending: queryPending(db, queryOpts),
    };
  }

  return {
    uploaded: queryUploaded(db, queryOpts),
    failed: [],
    quarantined: [],
    pending: [],
  };
}
