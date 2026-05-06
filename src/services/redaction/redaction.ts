import { ALL_RULES } from 'services/redaction/redaction.constants.ts';
import type { RedactionResult, RedactionRule } from 'services/redaction/redaction.types.ts';

export function applyRedaction(
  input: string,
  rules: readonly RedactionRule[] = ALL_RULES,
): RedactionResult {
  let working = input;
  let matchCount = 0;
  const ruleHits: Record<string, number> = {};

  for (const rule of rules) {
    const matches = working.match(rule.pattern);
    const count = matches?.length ?? 0;
    if (count > 0) {
      working = working.replace(rule.pattern, rule.replacement);
      matchCount += count;
      ruleHits[rule.id] = count;
    }
  }

  return { redacted: working, matchCount, ruleHits };
}
