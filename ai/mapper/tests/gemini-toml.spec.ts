import { describe, expect, test } from 'bun:test';
import { commandToGeminiToml } from '../translators/gemini-toml';

describe('commandToGeminiToml', () => {
  test('converts a command with description and body', () => {
    const out = commandToGeminiToml({
      name: 'audit',
      description: 'Run an audit',
      body: 'Audit the codebase per AGENTS.md.\n',
    });
    expect(out).toContain('description = "Run an audit"');
    expect(out).toContain('prompt = """');
    expect(out).toContain('Audit the codebase per AGENTS.md.');
  });
});
