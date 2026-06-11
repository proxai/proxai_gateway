import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerInput, WorkerOutput } from 'services/polling/poll-worker.types.ts';

const mockSelf = {
  onmessage: null as ((event: MessageEvent<WorkerInput>) => void) | null,
  postMessage: (_message: WorkerOutput) => {},
};

(globalThis as { self?: unknown }).self = mockSelf;

const importPath = 'services/polling/poll-worker.ts';
const { handleInspect } = await import(importPath);

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

test('handleInspect: codex telemetry record filtering', async () => {
  const rolloutDir = join(dir, 'sessions', '2026', '05', '21');
  await mkdir(rolloutDir, { recursive: true });
  const logPath = join(rolloutDir, 'rollout-session.jsonl');
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: { cli_version: '0.1.0', base_instructions: { text: 'secret' } },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hi' }],
      },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }),
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
  expect(result.recordCount).toBe(5);
  expect(result.telemetryRecordCount).toBe(4);
  expect(result.telemetryRawBytes).toBeGreaterThan(0);
});
