import { describe, expect, test } from 'bun:test';
import { parseFrontmatter } from '../frontmatter';

describe('parseFrontmatter', () => {
  test('returns empty frontmatter when no fence', () => {
    const out = parseFrontmatter('# Heading\n\nBody.');
    expect(out.data).toEqual({});
    expect(out.body).toBe('# Heading\n\nBody.');
  });

  test('parses simple string keys', () => {
    const src = `---
description: A rule
scope: src/foo
---
# Body`;
    const out = parseFrontmatter(src);
    expect(out.data).toEqual({ description: 'A rule', scope: 'src/foo' });
    expect(out.body).toBe('# Body');
  });

  test('parses quoted strings', () => {
    const src = `---
description: "A rule with: colon"
---
body`;
    expect(parseFrontmatter(src).data).toEqual({
      description: 'A rule with: colon',
    });
  });

  test('parses booleans and numbers', () => {
    const src = `---
always: true
priority: 10
---
body`;
    expect(parseFrontmatter(src).data).toEqual({ always: true, priority: 10 });
  });

  test('parses inline string arrays', () => {
    const src = `---
globs: ["**/*.ts", "**/*.tsx"]
tools: ["Read", "Bash"]
---
body`;
    expect(parseFrontmatter(src).data).toEqual({
      globs: ['**/*.ts', '**/*.tsx'],
      tools: ['Read', 'Bash'],
    });
  });

  test('throws on malformed frontmatter (unterminated fence)', () => {
    const src = `---
key: value
# no closing fence`;
    expect(() => parseFrontmatter(src)).toThrow(/unterminated/i);
  });

  test('appends a continuation line to the active key', () => {
    const src = `---
key: value
  continued text
---
body`;
    expect(parseFrontmatter(src).data).toEqual({ key: 'value continued text' });
  });

  test('throws when a non-key line appears with no active key', () => {
    const src = `---
plain text no colon
---
`;
    expect(() => parseFrontmatter(src)).toThrow(/Malformed frontmatter/);
  });

  test('throws on an inline array that is invalid JSON both ways', () => {
    const src = `---
arr: [foo, bar]
---`;
    expect(() => parseFrontmatter(src)).toThrow(/Invalid inline array/);
  });

  test('throws when an inline array contains non-string entries', () => {
    const src = `---
arr: [1, 2]
---`;
    expect(() => parseFrontmatter(src)).toThrow(/must contain only strings/);
  });
});
