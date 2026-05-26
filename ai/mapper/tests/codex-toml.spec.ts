import { describe, expect, test } from 'bun:test';
import { subagentToCodexToml } from '../translators/codex-toml';

describe('subagentToCodexToml', () => {
  test('converts a subagent with all fields', () => {
    const out = subagentToCodexToml({
      name: 'reviewer',
      description: 'Reviews code',
      tools: ['Read', 'Grep'],
      model: 'claude-opus-4-7',
      body: 'You are a code reviewer.\nDo X.\n',
    });
    expect(out).toContain('name = "reviewer"');
    expect(out).toContain('description = "Reviews code"');
    expect(out).toContain('tools = ["Read", "Grep"]');
    expect(out).toContain('model = "claude-opus-4-7"');
    expect(out).toContain('instructions = """\nYou are a code reviewer.');
  });

  test('escapes triple-quotes in body', () => {
    const out = subagentToCodexToml({
      name: 'x',
      description: 'x',
      body: 'has """ inside',
    });
    expect(out).toContain('has \\"\\"\\" inside');
  });
});
