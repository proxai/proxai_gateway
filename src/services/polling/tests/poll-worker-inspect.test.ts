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

test('handleInspect: gemini counts every parseable line as telemetry (MODEL/SYSTEM included)', async () => {
  // Antigravity lines are USER_EXPLICIT/MODEL/SYSTEM — none are claude-code user/assistant, so the
  // claude-code arm would report telemetryRecordCount=0 on the consent surface while capture ships
  // everything. The gemini arm must count EVERY non-empty parseable line (keep-all, mirroring the
  // collector), so a MODEL/SYSTEM-only transcript still reports a non-zero telemetry count.
  const transcriptDir = join(dir, 'brain', 'conv-uuid-1', '.system_generated', 'logs');
  await mkdir(transcriptDir, { recursive: true });
  const lines = [
    JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', text: 'looking into it' }),
    JSON.stringify({ source: 'SYSTEM', type: 'CONVERSATION_HISTORY', summary: 'prior turns' }),
    'not valid json at all', // parse-guard drops it: counts toward recordCount? no — totalLines only on parse
  ];
  await writeFile(join(transcriptDir, 'transcript.jsonl'), lines.join('\n') + '\n');

  const result = await handleInspect('gemini', {
    baseDir: dir,
    captureSubAgents: false,
    priorCursors: [],
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });

  expect(result.filesProcessed).toBe(1);
  // Every non-empty parseable line is telemetry, even with zero USER_* lines.
  expect(result.telemetryRecordCount).toBe(2);
  expect(result.telemetryRawBytes).toBeGreaterThan(0);
  expect(result.telemetryCompressedBytes).toBeGreaterThan(0);
  // No USER_EXPLICIT/USER_INPUT line -> zero prompts.
  expect(result.promptCount).toBe(0);
});

test('handleInspect: gemini promptCount increments on USER_EXPLICIT/USER_INPUT lines', async () => {
  const transcriptDir = join(dir, 'brain', 'conv-uuid-2', '.system_generated', 'logs');
  await mkdir(transcriptDir, { recursive: true });
  const lines = [
    JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', text: 'fix the bug' }),
    JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', text: 'on it' }),
    // USER_EXPLICIT but NOT USER_INPUT -> telemetry, but not a prompt.
    JSON.stringify({ source: 'USER_EXPLICIT', type: 'TOOL_RESULT', text: 'output' }),
  ];
  await writeFile(join(transcriptDir, 'transcript.jsonl'), lines.join('\n') + '\n');

  const result = await handleInspect('gemini', {
    baseDir: dir,
    captureSubAgents: false,
    priorCursors: [],
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });

  expect(result.telemetryRecordCount).toBe(3);
  expect(result.promptCount).toBe(1);
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
