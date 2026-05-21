import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleInspect } from 'services/polling/poll-worker.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-poll-worker-inspect-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

test('handleInspect: claude-code telemetry record filtering', async () => {
  const projectDir = join(dir, 'project-a');
  await mkdir(projectDir, { recursive: true });
  const logPath = join(projectDir, 'session.jsonl');
  const lines = [
    '{"type":"permission-mode","sessionId":"111"}',
    '{"type":"user","message":{"role":"user","content":"hello world"}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"response"}]}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"123","name":"Read"}]}}',
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"123"}]}}',
  ];
  await writeFile(logPath, lines.join('\n') + '\n');
  const result = await handleInspect('claude-code', {
    baseDir: dir,
    captureSubAgents: false,
    priorCursors: [],
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(1);
  expect(result.recordCount).toBe(5);
  expect(result.telemetryRecordCount).toBe(2);
  expect(result.telemetryRawBytes).toBeGreaterThan(0);
  expect(result.telemetryRawBytes).toBeLessThan(result.totalBytes);
});

test('handleInspect: gemini-cli telemetry record filtering', async () => {
  const projectDir = join(dir, 'gemini-cli-session', 'chats');
  await mkdir(projectDir, { recursive: true });
  const logPath = join(projectDir, 'session.jsonl');
  const lines = [
    '{"sessionId":"abc","projectHash":"hex","kind":"main"}',
    '{"id":"e1","timestamp":"2026-01-01T00:00:00Z","type":"user","content":[{"text":"hi"}]}',
    '{"id":"e2","timestamp":"2026-01-01T00:00:01Z","type":"gemini","content":[{"text":"hello"}]}',
    '{"id":"e3","timestamp":"2026-01-01T00:00:02Z","type":"tool_call","content":[{"text":"call"}]}',
  ];
  await writeFile(logPath, lines.join('\n') + '\n');
  const result = await handleInspect('gemini-cli', {
    baseDir: dir,
    captureSubAgents: false,
    priorCursors: [],
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(1);
  expect(result.recordCount).toBe(3);
  expect(result.telemetryRecordCount).toBe(2);
  expect(result.telemetryRawBytes).toBeGreaterThan(0);
  expect(result.telemetryRawBytes).toBeLessThan(result.totalBytes);
});

test('handleInspect: codex telemetry record filtering', async () => {
  const rolloutDir = join(dir, 'sessions', '2026', '05', '21');
  await mkdir(rolloutDir, { recursive: true });
  const logPath = join(rolloutDir, 'rollout-session.jsonl');
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: { cli_version: '0.1.0', instructions: 'secret' },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', text: 'hello' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'tool_call', name: 'git' } }),
    JSON.stringify({ type: 'response_item', role: 'assistant', payload: { text: 'hi' } }),
  ];
  await writeFile(logPath, lines.join('\n') + '\n');
  const result = await handleInspect('codex', {
    baseDir: dir,
    captureSubAgents: true,
    priorCursors: [],
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(1);
  expect(result.recordCount).toBe(4);
  expect(result.telemetryRecordCount).toBe(3);
  expect(result.telemetryRawBytes).toBeGreaterThan(0);
});
