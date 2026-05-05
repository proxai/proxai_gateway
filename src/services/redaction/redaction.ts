import { ALL_RULES, STAGE_1_RULES, STAGE_2_RULES } from 'services/redaction/redaction.constants.ts';
import type { RedactionResult, RedactionRule } from 'services/redaction/redaction.types.ts';

export function applyRedaction(input: string, rules: readonly RedactionRule[]): RedactionResult {
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

export function applyStage1(input: string): RedactionResult {
  return applyRedaction(input, STAGE_1_RULES);
}

export function applyStage2(input: string): RedactionResult {
  return applyRedaction(input, STAGE_2_RULES);
}

export function applyAllRedaction(input: string): RedactionResult {
  return applyRedaction(input, ALL_RULES);
}
