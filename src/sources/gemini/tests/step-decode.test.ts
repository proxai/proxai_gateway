import { expect, test } from 'bun:test';

import {
  decodeStep,
  decodeStepRow,
  decodeTrajectoryMetadataBlobRow,
  decodeTrajectoryMetaRow,
} from 'sources/gemini/step-decode.ts';
import {
  bytesField,
  concatBytes,
  msgField,
  strField,
  varintField,
} from 'sources/gemini/tests/proto-encode.ts';

function stepRef(parts: readonly Uint8Array[]): Uint8Array {
  return msgField(20, parts);
}

function timestamp(seconds: number, nanos: number): Uint8Array {
  return msgField(1, [varintField(1, seconds), varintField(2, nanos)]);
}

test('decodes a user message step (step_type 14)', () => {
  const payload = concatBytes([
    varintField(1, 14),
    msgField(5, [
      timestamp(1781035381, 966036000),
      varintField(3, 4),
      stepRef([strField(1, 'traj-123'), varintField(2, 0), strField(4, 'cascade-abc')]),
      strField(12, 'turn-uuid-1'),
    ]),
    msgField(19, [strField(2, 'fix the search bug')]),
  ]);

  const step = decodeStep(14, payload);
  expect(step.role).toBe('user');
  expect(step.text).toBe('fix the search bug');
  expect(step.toolName).toBeNull();
  expect(step.ids.cascadeId).toBe('cascade-abc');
  expect(step.ids.trajectoryId).toBe('traj-123');
  expect(step.ids.turnGroup).toBe('turn-uuid-1');
  const expectedIso = new Date(1781035381 * 1000 + Math.floor(966036000 / 1_000_000)).toISOString();
  expect(step.isoTimestamp).toBe(expectedIso);
  expect(step.model).toBeNull();
  expect(step.inputTokens).toBeNull();
});

test('decodes a run_command tool step (step_type 21)', () => {
  const args = '{"CommandLine":"bun test","toolSummary":"Run tests"}';
  const payload = concatBytes([
    varintField(1, 21),
    msgField(5, [
      varintField(3, 2),
      msgField(4, [strField(1, 'dktqtm8l'), strField(2, 'run_command'), strField(3, args)]),
      stepRef([strField(4, 'cascade-abc'), varintField(2, 13)]),
    ]),
  ]);

  const step = decodeStep(21, payload);
  expect(step.role).toBe('tool');
  expect(step.toolName).toBe('run_command');
  expect(step.toolArgsJson).toBe(args);
  expect(step.text).toBeNull();
});

test('decodes a system [Message] step (step_type 101)', () => {
  const text = '[Message] timestamp=2026-06-13T00:37:58Z sender=cascade/task-1 content=done';
  const payload = concatBytes([
    varintField(1, 101),
    msgField(5, [varintField(3, 5), timestamp(1781035381, 0)]),
    msgField(114, [strField(1, text)]),
  ]);

  const step = decodeStep(101, payload);
  expect(step.role).toBe('system');
  expect(step.text).toBe(text);
});

test('decodes an assistant envelope step with thinking text and wrapped tool (step_type 15)', () => {
  const payload = concatBytes([
    varintField(1, 15),
    msgField(5, [varintField(3, 2)]),
    msgField(20, [
      strField(3, '**Thinking** about the code'),
      msgField(7, [strField(2, 'view_file'), strField(3, '{"AbsolutePath":"/x"}')]),
    ]),
  ]);

  const step = decodeStep(15, payload);
  expect(step.role).toBe('assistant');
  expect(step.text).toBe('**Thinking** about the code');
  expect(step.toolName).toBe('view_file');
});

test('decodeStepRow maps a decoded step into the wire-contract row shape', () => {
  const payload = concatBytes([
    varintField(1, 21),
    msgField(5, [
      varintField(3, 2),
      msgField(4, [strField(2, 'run_command'), strField(3, '{}')]),
      stepRef([strField(4, 'cascade-abc')]),
    ]),
  ]);

  const row = decodeStepRow(7, 21, 3, payload);
  expect(row).toMatchObject({
    idx: 7,
    step_type: 21,
    status: 3,
    role: 'tool',
    tool_name: 'run_command',
    conversation_id: 'cascade-abc',
  });
});

test('decodes an assistant final-text step (step_type 23)', () => {
  const payload = concatBytes([
    varintField(1, 23),
    msgField(5, [varintField(3, 5)]),
    msgField(30, [strField(4, 'All done.')]),
  ]);
  const step = decodeStep(23, payload);
  expect(step.role).toBe('assistant');
  expect(step.text).toBe('All done.');
});

test('decodes a nested tool-result text step (step_type 132)', () => {
  const payload = concatBytes([
    varintField(1, 132),
    msgField(140, [msgField(2, [strField(1, 'nested result text')])]),
  ]);
  const step = decodeStep(132, payload);
  expect(step.role).toBe('tool');
  expect(step.text).toBe('nested result text');
});

test('decodes a system summary step (step_type 90)', () => {
  const payload = concatBytes([
    varintField(1, 90),
    msgField(103, [strField(1, 'conversation summary text')]),
  ]);
  const step = decodeStep(90, payload);
  expect(step.role).toBe('system');
  expect(step.text).toBe('conversation summary text');
});

test('decodes a system memory step (step_type 98)', () => {
  const payload = concatBytes([
    varintField(1, 98),
    msgField(111, [strField(1, 'stored memory note')]),
  ]);
  const step = decodeStep(98, payload);
  expect(step.role).toBe('system');
  expect(step.text).toBe('stored memory note');
});

test('decodes a deeply nested tool result step (step_type 31)', () => {
  const payload = concatBytes([
    varintField(1, 31),
    msgField(40, [msgField(2, [msgField(6, [msgField(3, [strField(2, 'tool output body')])])])]),
  ]);
  const step = decodeStep(31, payload);
  expect(step.role).toBe('tool');
  expect(step.text).toBe('tool output body');
});

test('decodes a tool step with fallback text path (step_type 25)', () => {
  const fromSecondary = concatBytes([
    varintField(1, 25),
    msgField(34, [strField(14, 'secondary tool text')]),
  ]);
  const stepSecondary = decodeStep(25, fromSecondary);
  expect(stepSecondary.role).toBe('tool');
  expect(stepSecondary.text).toBe('secondary tool text');

  const fromPrimary = concatBytes([
    varintField(1, 25),
    msgField(34, [strField(11, 'primary tool text')]),
  ]);
  const stepPrimary = decodeStep(25, fromPrimary);
  expect(stepPrimary.text).toBe('primary tool text');
});

test('extracts a string session id from the kv envelope', () => {
  const payload = concatBytes([
    varintField(1, 14),
    msgField(5, [msgField(9, [msgField(8, [varintField(1, 1), strField(2, 'session-xyz')])])]),
  ]);
  const step = decodeStep(14, payload);
  expect(step.ids.sessionId).toBe('session-xyz');
});

test('falls back to a numeric session id when the kv value is a varint', () => {
  const payload = concatBytes([
    varintField(1, 14),
    msgField(5, [msgField(9, [msgField(8, [varintField(1, 1), varintField(2, 42)])])]),
  ]);
  const step = decodeStep(14, payload);
  expect(step.ids.sessionId).toBe('42');
});

test('yields a null session id when the kv envelope value field is absent', () => {
  const payload = concatBytes([
    varintField(1, 14),
    msgField(5, [msgField(9, [msgField(8, [varintField(1, 1)])])]),
  ]);
  const step = decodeStep(14, payload);
  expect(step.ids.sessionId).toBeNull();
});

test('yields a null session id when the kv value is neither a string nor a varint', () => {
  const payload = concatBytes([
    varintField(1, 14),
    msgField(5, [msgField(9, [msgField(8, [varintField(1, 1), bytesField(2, new Uint8Array())])])]),
  ]);
  const step = decodeStep(14, payload);
  expect(step.ids.sessionId).toBeNull();
});

test('decodeStep is total over arbitrary bytes', () => {
  expect(() => decodeStep(14, Uint8Array.from([0xff, 0x00, 0x80, 0x12]))).not.toThrow();
  const step = decodeStep(99, Uint8Array.from([0xff, 0x00, 0x80, 0x12]));
  expect(step.role).toBeNull();
  expect(step.text).toBeNull();
});

test('decodeTrajectoryMetaRow passes columns through to the row object', () => {
  const row = decodeTrajectoryMetaRow({
    idx: 0,
    trajectoryId: 'traj-1',
    cascadeId: 'cascade-1',
    trajectoryType: 4,
    source: 17,
  });
  expect(row).toEqual({
    idx: 0,
    trajectory_id: 'traj-1',
    cascade_id: 'cascade-1',
    trajectory_type: 4,
    source: 17,
  });
});

test('decodeTrajectoryMetadataBlobRow extracts workspace path and git remote', () => {
  const blob = msgField(1, [
    strField(1, 'file:///Users/me/repo'),
    strField(2, 'file:///Users/me/repo'),
    msgField(3, [strField(1, 'org/repo'), strField(2, 'git@github.com:org/repo.git')]),
  ]);

  const row = decodeTrajectoryMetadataBlobRow(1, blob);
  expect(row.workspace_path).toBe('file:///Users/me/repo');
  expect(row.git_remote).toBe('git@github.com:org/repo.git');
});

test('decodeTrajectoryMetadataBlobRow yields null fields when absent', () => {
  const row = decodeTrajectoryMetadataBlobRow(1, new Uint8Array());
  expect(row.workspace_path).toBeNull();
  expect(row.git_remote).toBeNull();
});

test('decodes token usage, caching, and model from step_payload 5.9 envelope', () => {
  const payload = concatBytes([
    varintField(1, 15),
    msgField(5, [
      varintField(3, 2),
      msgField(9, [
        varintField(1, 1132),
        varintField(2, 5000),
        varintField(3, 300),
        varintField(5, 20000),
        varintField(10, 80),
      ]),
    ]),
  ]);

  const step = decodeStep(15, payload);
  expect(step.model).toBe('1132');
  expect(step.inputTokens).toBe(25000);
  expect(step.outputTokens).toBe(300);
  expect(step.cacheReadInputTokens).toBe(20000);
  expect(step.cacheCreationInputTokens).toBe(80);

  const row = decodeStepRow(42, 15, 3, payload);
  expect(row.model).toBe('1132');
  expect(row.input_tokens).toBe(25000);
  expect(row.output_tokens).toBe(300);
  expect(row.cache_read_input_tokens).toBe(20000);
  expect(row.cache_creation_input_tokens).toBe(80);
});
