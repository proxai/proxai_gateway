import { expect, test } from 'bun:test';

import { parseBool, resolveSubAgentCapture } from 'services/config/sub-agent-flags';

test('parseBool returns false for undefined', () => {
  expect(parseBool(undefined)).toBe(false);
});

test('parseBool returns false for empty string', () => {
  expect(parseBool('')).toBe(false);
});

test('parseBool accepts "1" / "true" / "yes" as truthy', () => {
  expect(parseBool('1')).toBe(true);
  expect(parseBool('true')).toBe(true);
  expect(parseBool('yes')).toBe(true);
});

test('parseBool is case-insensitive', () => {
  expect(parseBool('TRUE')).toBe(true);
  expect(parseBool('True')).toBe(true);
  expect(parseBool('YES')).toBe(true);
  expect(parseBool('Yes')).toBe(true);
});

test('parseBool trims whitespace', () => {
  expect(parseBool('  1  ')).toBe(true);
  expect(parseBool('\ttrue\n')).toBe(true);
});

test('parseBool rejects "0" / "false" / "no" / arbitrary strings', () => {
  expect(parseBool('0')).toBe(false);
  expect(parseBool('false')).toBe(false);
  expect(parseBool('no')).toBe(false);
  expect(parseBool('maybe')).toBe(false);
  expect(parseBool('off')).toBe(false);
  expect(parseBool('enabled')).toBe(false);
});

test('resolveSubAgentCapture returns false when no env vars set', () => {
  expect(resolveSubAgentCapture('claude-code', {})).toBe(false);
  expect(resolveSubAgentCapture('codex', {})).toBe(false);
  expect(resolveSubAgentCapture('cursor', {})).toBe(false);
  expect(resolveSubAgentCapture('claude-desktop', {})).toBe(false);
});

test('global flag overrides all per-source flags', () => {
  const env = { PROXAI_GATEWAY_CAPTURE_SUB_AGENTS: '1' };
  expect(resolveSubAgentCapture('claude-code', env)).toBe(true);
  expect(resolveSubAgentCapture('codex', env)).toBe(true);
  expect(resolveSubAgentCapture('cursor', env)).toBe(true);
  expect(resolveSubAgentCapture('claude-desktop', env)).toBe(true);
});

test('per-source flag enables only that source', () => {
  const env = { PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CLAUDE_CODE: 'true' };
  expect(resolveSubAgentCapture('claude-code', env)).toBe(true);
  expect(resolveSubAgentCapture('codex', env)).toBe(false);
  expect(resolveSubAgentCapture('cursor', env)).toBe(false);
  expect(resolveSubAgentCapture('claude-desktop', env)).toBe(false);
});

test('codex per-source flag is independent', () => {
  const env = { PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CODEX: 'yes' };
  expect(resolveSubAgentCapture('claude-code', env)).toBe(false);
  expect(resolveSubAgentCapture('codex', env)).toBe(true);
  expect(resolveSubAgentCapture('cursor', env)).toBe(false);
  expect(resolveSubAgentCapture('claude-desktop', env)).toBe(false);
});

test('cursor per-source flag is independent', () => {
  const env = { PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CURSOR: '1' };
  expect(resolveSubAgentCapture('claude-code', env)).toBe(false);
  expect(resolveSubAgentCapture('codex', env)).toBe(false);
  expect(resolveSubAgentCapture('cursor', env)).toBe(true);
  expect(resolveSubAgentCapture('claude-desktop', env)).toBe(false);
});

test('claude-desktop per-source flag is independent', () => {
  const env = { PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CLAUDE_DESKTOP: 'true' };
  expect(resolveSubAgentCapture('claude-code', env)).toBe(false);
  expect(resolveSubAgentCapture('codex', env)).toBe(false);
  expect(resolveSubAgentCapture('cursor', env)).toBe(false);
  expect(resolveSubAgentCapture('claude-desktop', env)).toBe(true);
});

test('global truthy + per-source falsy: global wins (true)', () => {
  const env = {
    PROXAI_GATEWAY_CAPTURE_SUB_AGENTS: '1',
    PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CLAUDE_CODE: '0',
  };
  expect(resolveSubAgentCapture('claude-code', env)).toBe(true);
});

test('global falsy + per-source truthy: source wins (true)', () => {
  const env = {
    PROXAI_GATEWAY_CAPTURE_SUB_AGENTS: '0',
    PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CURSOR: '1',
  };
  expect(resolveSubAgentCapture('cursor', env)).toBe(true);
  expect(resolveSubAgentCapture('codex', env)).toBe(false);
});

test('both falsy: result false', () => {
  const env = {
    PROXAI_GATEWAY_CAPTURE_SUB_AGENTS: 'false',
    PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CODEX: '0',
  };
  expect(resolveSubAgentCapture('codex', env)).toBe(false);
});

test('garbage values resolve to false', () => {
  const env = {
    PROXAI_GATEWAY_CAPTURE_SUB_AGENTS: 'maybe',
    PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CURSOR: 'sometimes',
  };
  expect(resolveSubAgentCapture('cursor', env)).toBe(false);
});

test('uses process.env when env arg omitted (smoke)', () => {
  const original = process.env.PROXAI_GATEWAY_CAPTURE_SUB_AGENTS;
  delete process.env.PROXAI_GATEWAY_CAPTURE_SUB_AGENTS;
  try {
    expect(resolveSubAgentCapture('claude-code')).toBe(false);
  } finally {
    if (original !== undefined) process.env.PROXAI_GATEWAY_CAPTURE_SUB_AGENTS = original;
  }
});
