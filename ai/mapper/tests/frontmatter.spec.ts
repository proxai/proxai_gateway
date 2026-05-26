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
});
