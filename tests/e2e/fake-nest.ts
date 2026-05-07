/**
 * Fake nest server for e2e tests.
 *
 * Single-file, single-process Bun.serve instance that emulates the four
 * gateway-facing endpoints with enough fidelity to drive the capture-buffer-
 * upload pipeline:
 *
 *   GET  /ingestion/verify-key       — toggleable success/failure per api key
 *   POST /v1/host-ids/register       — first-machine-wins host_id bind per key
 *   GET  /v1/watermarks?host_id      — returns seeded server watermarks
 *   POST /v1/raw_records             — basic shape validation + per-(host_id,
 *                                       source_path_hash) monotonicity, dedupe
 *                                       by capture_id, 400 watermark_regression
 *
 * Tests drive the server with the small control surface exposed below.
 */
// (Bun.serve returns a `Server` whose generic type narrows by config; we
// rely on inference rather than annotating the variable directly.)

export interface ServerWatermarkRow {
  source_app: 'claude-code' | 'cursor' | 'codex';
  source_path_hash: string;
  watermark_kind: 'byte_range' | 'rowid_range';
  watermark_end: number;
  watermark_table: string | null;
  last_delivered_at: string;
}

export interface ReceivedRawRecord {
  captureId: string;
  hostId: string;
  sourceApp: string;
  sourcePathHash: string;
  watermarkStart: number;
  watermarkEnd: number;
  watermarkKind: 'byte_range' | 'rowid_range';
  watermarkTable: string | null;
  body: string;
  bodyFormat: string;
  agentSchemaVersion: string;
  apiKey: string | null;
  idempotent: boolean;
}

export interface ReceivedSummary {
  records: ReceivedRawRecord[];
  verifyKeyCalls: { apiKey: string | null }[];
  watermarkFetches: { hostId: string; apiKey: string | null }[];
  registerHostIdCalls: { apiKey: string | null; hostId: string }[];
}

export interface KeyEntry {
  valid: boolean;
  userId: string;
  keyName: string;
}

export interface FakeNestHandle {
  url: string;
  port: number;
  setKeyValid(apiKey: string, valid: boolean, opts?: { userId?: string; keyName?: string }): void;
  seedWatermarks(hostId: string, watermarks: ServerWatermarkRow[]): void;
  received(): ReceivedSummary;
  reset(): void;
  stop(): Promise<void>;
}

interface InternalState {
  keys: Map<string, KeyEntry>;
  // hostId -> watermarks
  hostWatermarks: Map<string, ServerWatermarkRow[]>;
  // capture_id -> receipt (idempotency table)
  capturesById: Map<string, ReceivedRawRecord>;
  // Latest watermark_end per (host_id, source_path_hash)
  latestWatermark: Map<string, number>;
  // apiKey -> bound host_id (first-machine-wins). Mirrors the backend's
  // `apiKey.metadata.allowedHostIds` allow-list at one entry per key.
  registeredHostId: Map<string, string>;
  records: ReceivedRawRecord[];
  verifyKeyCalls: { apiKey: string | null }[];
  watermarkFetches: { hostId: string; apiKey: string | null }[];
  registerHostIdCalls: { apiKey: string | null; hostId: string }[];
}

function newState(): InternalState {
  return {
    keys: new Map(),
    hostWatermarks: new Map(),
    capturesById: new Map(),
    latestWatermark: new Map(),
    registeredHostId: new Map(),
    records: [],
    verifyKeyCalls: [],
    watermarkFetches: [],
    registerHostIdCalls: [],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function watermarkKey(hostId: string, sourcePathHash: string, table: string | null): string {
  return `${hostId}::${sourcePathHash}::${table ?? ''}`;
}

function lookupAuthKey(req: Request): string | null {
  return req.headers.get('x-api-key');
}

interface RawRecordBody {
  capture_id?: unknown;
  host_id?: unknown;
  source_app?: unknown;
  source_path_hash?: unknown;
  watermark?: unknown;
  body?: unknown;
  body_format?: unknown;
  agent_schema_version?: unknown;
}

interface ParsedWatermark {
  kind: 'byte_range' | 'rowid_range';
  start: number;
  end: number;
  table: string | null;
}

function parseWatermark(value: unknown): ParsedWatermark | null {
  if (value === null || typeof value !== 'object') return null;
  const w = value as Record<string, unknown>;
  const kind = w['kind'];
  const start = w['start'];
  const end = w['end'];
  const table = w['table'];
  if (kind !== 'byte_range' && kind !== 'rowid_range') return null;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  return {
    kind,
    start,
    end,
    table: typeof table === 'string' ? table : null,
  };
}

async function handleRawRecord(req: Request, state: InternalState): Promise<Response> {
  const apiKey = lookupAuthKey(req);
  // Treat any unknown / invalid key as 403 (auth halt). Keys explicitly marked
  // invalid take the same path. Missing key -> 401 to exercise transient auth.
  if (apiKey === null || apiKey.length === 0) {
    return new Response('', { status: 401 });
  }
  const entry = state.keys.get(apiKey);
  if (entry === undefined || !entry.valid) {
    return new Response('', { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return jsonResponse({ error: 'invalid_body' }, 400);
  }
  const body = raw as RawRecordBody;
  const captureId = typeof body.capture_id === 'string' ? body.capture_id : null;
  const hostId = typeof body.host_id === 'string' ? body.host_id : null;
  const sourceApp = typeof body.source_app === 'string' ? body.source_app : null;
  const sourcePathHash = typeof body.source_path_hash === 'string' ? body.source_path_hash : null;
  const watermark = parseWatermark(body.watermark);
  const bodyText = typeof body.body === 'string' ? body.body : null;
  const bodyFormat = typeof body.body_format === 'string' ? body.body_format : '';
  const agentSchemaVersion =
    typeof body.agent_schema_version === 'string' ? body.agent_schema_version : '';

  if (
    captureId === null ||
    hostId === null ||
    sourceApp === null ||
    sourcePathHash === null ||
    watermark === null ||
    bodyText === null
  ) {
    return jsonResponse({ error: 'missing_required_fields' }, 400);
  }

  // Idempotency by capture_id.
  const existing = state.capturesById.get(captureId);
  if (existing !== undefined) {
    return jsonResponse({
      capture_id: captureId,
      accepted: true,
      idempotent: true,
    });
  }

  // Monotonicity per (host_id, source_path_hash, watermark_table). The server
  // expects watermark.start >= last_processed_watermark_end.
  const key = watermarkKey(hostId, sourcePathHash, watermark.table);
  const last = state.latestWatermark.get(key) ?? 0;
  if (watermark.start < last) {
    return jsonResponse(
      {
        error: 'watermark_regression',
        current_server_watermark_end: last,
        source_path_hash: sourcePathHash,
      },
      400,
    );
  }

  const record: ReceivedRawRecord = {
    captureId,
    hostId,
    sourceApp,
    sourcePathHash,
    watermarkStart: watermark.start,
    watermarkEnd: watermark.end,
    watermarkKind: watermark.kind,
    watermarkTable: watermark.table,
    body: bodyText,
    bodyFormat,
    agentSchemaVersion,
    apiKey,
    idempotent: false,
  };
  state.capturesById.set(captureId, record);
  state.records.push(record);
  state.latestWatermark.set(key, watermark.end);

  // Mirror into watermarks endpoint state so /v1/watermarks reflects
  // post-upload server state if the test wants to inspect it later.
  const list = state.hostWatermarks.get(hostId) ?? [];
  const idx = list.findIndex(
    (w) => w.source_path_hash === sourcePathHash && (w.watermark_table ?? null) === watermark.table,
  );
  const next: ServerWatermarkRow = {
    source_app: sourceApp as ServerWatermarkRow['source_app'],
    source_path_hash: sourcePathHash,
    watermark_kind: watermark.kind,
    watermark_end: watermark.end,
    watermark_table: watermark.table,
    last_delivered_at: new Date().toISOString(),
  };
  if (idx === -1) list.push(next);
  else list[idx] = next;
  state.hostWatermarks.set(hostId, list);

  return jsonResponse({
    capture_id: captureId,
    accepted: true,
    idempotent: false,
  });
}

function handleVerifyKey(req: Request, state: InternalState): Response {
  const apiKey = lookupAuthKey(req);
  state.verifyKeyCalls.push({ apiKey });
  if (apiKey === null) {
    return new Response('', { status: 401 });
  }
  const entry = state.keys.get(apiKey);
  if (entry === undefined) {
    return jsonResponse({ success: false, message: 'unknown key' }, 200);
  }
  if (!entry.valid) {
    return jsonResponse({ success: false, message: 'key revoked' }, 200);
  }
  return jsonResponse({
    success: true,
    message: 'ok',
    data: { keyName: entry.keyName, userId: entry.userId },
  });
}

function handleWatermarks(req: Request, state: InternalState): Response {
  const apiKey = lookupAuthKey(req);
  const url = new URL(req.url);
  const hostId = url.searchParams.get('host_id') ?? '';
  state.watermarkFetches.push({ hostId, apiKey });
  if (apiKey === null) {
    return new Response('', { status: 401 });
  }
  const entry = state.keys.get(apiKey);
  if (entry === undefined || !entry.valid) {
    return new Response('', { status: 403 });
  }
  const watermarks = state.hostWatermarks.get(hostId) ?? [];
  return jsonResponse({
    host_id: hostId,
    user_id: entry.userId,
    watermarks,
  });
}

async function handleRegisterHostId(req: Request, state: InternalState): Promise<Response> {
  const apiKey = req.headers.get('x-api-key');
  let parsedHostId = '';
  try {
    const body = (await req.json()) as { host_id?: unknown };
    if (typeof body.host_id === 'string') parsedHostId = body.host_id;
  } catch {
    return new Response('invalid body', { status: 400 });
  }
  state.registerHostIdCalls.push({ apiKey, hostId: parsedHostId });
  if (apiKey === null) {
    return new Response('', { status: 401 });
  }
  const entry = state.keys.get(apiKey);
  if (entry === undefined || !entry.valid) {
    return new Response('', { status: 403 });
  }
  if (!/^[a-f0-9]{64}$/.test(parsedHostId)) {
    return jsonResponse({ message: 'host_id must be 64-char lowercase hex (sha256)' }, 400);
  }
  const bound = state.registeredHostId.get(apiKey);
  if (bound === undefined) {
    state.registeredHostId.set(apiKey, parsedHostId);
    return jsonResponse({
      host_id: parsedHostId,
      user_id: entry.userId,
      registered: true,
    });
  }
  if (bound === parsedHostId) {
    return jsonResponse({
      host_id: parsedHostId,
      user_id: entry.userId,
      registered: false,
    });
  }
  return new Response('', { status: 403 });
}

export async function startFakeNest(): Promise<FakeNestHandle> {
  const state = newState();
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/ingestion/verify-key') {
        return handleVerifyKey(req, state);
      }
      if (url.pathname === '/v1/host-ids/register' && req.method === 'POST') {
        return handleRegisterHostId(req, state);
      }
      if (url.pathname === '/v1/watermarks') {
        return handleWatermarks(req, state);
      }
      if (url.pathname === '/v1/raw_records' && req.method === 'POST') {
        return handleRawRecord(req, state);
      }
      return new Response('not found', { status: 404 });
    },
  });

  if (server.port === undefined) {
    throw new Error('fake-nest: Bun.serve returned no port');
  }
  const port = server.port;
  return {
    url: `http://localhost:${port.toString()}`,
    port,
    setKeyValid: (apiKey, valid, opts = {}) => {
      const existing = state.keys.get(apiKey);
      state.keys.set(apiKey, {
        valid,
        userId: opts.userId ?? existing?.userId ?? 'u_test',
        keyName: opts.keyName ?? existing?.keyName ?? 'test-key',
      });
    },
    seedWatermarks: (hostId, watermarks) => {
      state.hostWatermarks.set(hostId, [...watermarks]);
      for (const w of watermarks) {
        state.latestWatermark.set(
          watermarkKey(hostId, w.source_path_hash, w.watermark_table),
          w.watermark_end,
        );
      }
    },
    received: () => ({
      records: [...state.records],
      verifyKeyCalls: [...state.verifyKeyCalls],
      watermarkFetches: [...state.watermarkFetches],
      registerHostIdCalls: [...state.registerHostIdCalls],
    }),
    reset: () => {
      state.keys.clear();
      state.hostWatermarks.clear();
      state.capturesById.clear();
      state.latestWatermark.clear();
      state.registeredHostId.clear();
      state.records.length = 0;
      state.verifyKeyCalls.length = 0;
      state.watermarkFetches.length = 0;
      state.registerHostIdCalls.length = 0;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
