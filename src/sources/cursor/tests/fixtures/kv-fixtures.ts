import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { statFile } from 'core/io/fs';
import { sha256Hex } from 'core/utils';
import type { DiscoveredCursorFile } from 'sources/cursor/cursor.types.ts';

export interface SyntheticKvRow {
  key: string;
  value: string | null;
}

export interface FixtureScenario {
  name: string;
  rows: SyntheticKvRow[];
  expectedAgentSchemaVersion: string;
}

export const TYPICAL_SESSION_FIXTURE: FixtureScenario = {
  name: 'typical-session',
  rows: [
    {
      key: 'composerData:00000000-0000-0000-0000-000000000001',
      value: JSON.stringify({
        _v: 13,
        composerId: '00000000-0000-0000-0000-000000000001',
        text: 'fixture text',
        status: 'completed',
        capabilities: [],
      }),
    },
    {
      key: 'bubbleId:00000000-0000-0000-0000-000000000001:b-001',
      value: JSON.stringify({
        _v: 7,
        type: 1,
        text: 'fixture user prompt',
        bubbleId: 'b-001',
      }),
    },
    {
      key: 'bubbleId:00000000-0000-0000-0000-000000000001:b-002',
      value: JSON.stringify({
        _v: 7,
        type: 2,
        text: 'fixture assistant reply',
        bubbleId: 'b-002',
      }),
    },
    {
      key: 'bubbleId:00000000-0000-0000-0000-000000000001:b-003',
      value: JSON.stringify({
        _v: 7,
        type: 1,
        text: 'fixture follow-up',
        bubbleId: 'b-003',
      }),
    },
  ],
  expectedAgentSchemaVersion: '13:7',
};

export const MIXED_VERSIONS_FIXTURE: FixtureScenario = {
  name: 'mixed-versions',
  rows: [
    {
      key: 'composerData:00000000-0000-0000-0000-0000000000aa',
      value: JSON.stringify({ _v: 10, composerId: 'aa' }),
    },
    {
      key: 'composerData:00000000-0000-0000-0000-0000000000bb',
      value: JSON.stringify({ _v: 14, composerId: 'bb' }),
    },
    {
      key: 'composerData:00000000-0000-0000-0000-0000000000cc',
      value: JSON.stringify({ _v: 15, composerId: 'cc' }),
    },
    {
      key: 'bubbleId:00000000-0000-0000-0000-0000000000aa:b-1',
      value: JSON.stringify({ _v: 3, type: 1 }),
    },
    {
      key: 'bubbleId:00000000-0000-0000-0000-0000000000bb:b-2',
      value: JSON.stringify({ _v: 5, type: 2 }),
    },
  ],
  expectedAgentSchemaVersion: '10:3',
};

export const COMPOSER_ONLY_FIXTURE: FixtureScenario = {
  name: 'composer-only',
  rows: [
    {
      key: 'composerData:00000000-0000-0000-0000-0000000000d0',
      value: JSON.stringify({ _v: 13, composerId: 'd0' }),
    },
    {
      key: 'composerData:00000000-0000-0000-0000-0000000000d1',
      value: JSON.stringify({ _v: 13, composerId: 'd1' }),
    },
  ],
  expectedAgentSchemaVersion: '13:unknown',
};

export const NO_RELEVANT_PREFIXES_FIXTURE: FixtureScenario = {
  name: 'no-relevant-prefixes',
  rows: [
    { key: 'agentKv:blob:abc', value: '{}' },
    { key: 'checkpointId:42', value: '{}' },
    { key: 'inlineDiff:xyz', value: '{}' },
  ],
  expectedAgentSchemaVersion: 'unknown',
};

export const NULL_AND_MISSING_V_FIXTURE: FixtureScenario = {
  name: 'null-and-missing-v',
  rows: [
    {
      key: 'composerData:00000000-0000-0000-0000-0000000000e0',
      value: null,
    },
    {
      key: 'composerData:00000000-0000-0000-0000-0000000000e1',
      value: JSON.stringify({ _v: 14, composerId: 'e1' }),
    },
    {
      key: 'bubbleId:00000000-0000-0000-0000-0000000000e0:b-z',
      value: JSON.stringify({ checkpointId: 'placeholder' }),
    },
    {
      key: 'bubbleId:00000000-0000-0000-0000-0000000000e1:b-y',
      value: JSON.stringify({ _v: 3, type: 1 }),
    },
  ],
  expectedAgentSchemaVersion: '14:3',
};

export const REDACTION_FIXTURE: FixtureScenario = {
  name: 'redaction',
  rows: [
    {
      key: 'composerData:00000000-0000-0000-0000-0000000000f0',
      value: JSON.stringify({ _v: 13, composerId: 'f0' }),
    },
    {
      key: 'bubbleId:00000000-0000-0000-0000-0000000000f0:b-secret',
      value: JSON.stringify({
        _v: 7,
        type: 1,
        text: 'set OPENAI_API_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt and run',
      }),
    },
  ],
  expectedAgentSchemaVersion: '13:7',
};

export const MIXED_KEY_PREFIXES_FIXTURE: FixtureScenario = {
  name: 'mixed-key-prefixes',
  rows: [
    {
      key: 'composerData:00000000-0000-0000-0000-000000000111',
      value: JSON.stringify({ _v: 13, composerId: '111' }),
    },
    { key: 'auth:tokens', value: JSON.stringify({ token: 'abc' }) },
    { key: 'randomKey', value: JSON.stringify({ junk: true }) },
    { key: 'agentKv:blob:zz', value: JSON.stringify({ junk: true }) },
    { key: 'checkpointId:42', value: JSON.stringify({}) },
    {
      key: 'bubbleId:00000000-0000-0000-0000-000000000111:b-1',
      value: JSON.stringify({ _v: 7, type: 2 }),
    },
  ],
  expectedAgentSchemaVersion: '13:7',
};

export async function writeFixtureDb(
  dir: string,
  scenario: FixtureScenario,
): Promise<DiscoveredCursorFile> {
  const path = join(dir, `${scenario.name}.vscdb`);
  const db = new Database(path, { create: true });
  try {
    db.run('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    const insert = db.query<unknown, [string, string | null]>(
      'INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)',
    );
    for (const row of scenario.rows) {
      insert.run(row.key, row.value);
    }
  } finally {
    db.close();
  }
  const stat = await statFile(path);
  if (!stat.exists) throw new Error(`fixture file missing: ${path}`);
  return {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };
}
