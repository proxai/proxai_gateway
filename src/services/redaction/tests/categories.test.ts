import { expect, test } from 'bun:test';

import { ALL_RULES, RULE_CATEGORIES } from 'services/redaction';

test('RULE_CATEGORIES covers every rule in ALL_RULES exactly once', () => {
  const fromCategories = RULE_CATEGORIES.flatMap((c) => c.rules);
  expect(fromCategories.length).toBe(ALL_RULES.length);
  const ids = new Set(fromCategories.map((r) => r.id));
  expect(ids.size).toBe(fromCategories.length);
  const allIds = ALL_RULES.map((r) => r.id).toSorted();
  const categoryIds = [...ids].toSorted();
  expect(categoryIds).toEqual(allIds);
});

test('every category name is unique', () => {
  const names = RULE_CATEGORIES.map((c) => c.name);
  expect(new Set(names).size).toBe(names.length);
});

test('every category has at least one rule', () => {
  for (const c of RULE_CATEGORIES) {
    expect(c.rules.length).toBeGreaterThan(0);
  }
});

test('every category has a non-empty description', () => {
  for (const c of RULE_CATEGORIES) {
    expect(c.description.length).toBeGreaterThan(0);
  }
});

test('every category name uses kebab-case (lowercase, hyphens)', () => {
  for (const c of RULE_CATEGORIES) {
    expect(c.name).toMatch(/^[a-z]+(-[a-z]+)*$/);
  }
});
