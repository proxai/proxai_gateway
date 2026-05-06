export interface RedactionRule {
  id: string;
  description: string;
  pattern: RegExp;
  replacement: string;
}

export interface RedactionResult {
  redacted: string;
  matchCount: number;
  ruleHits: Record<string, number>;
}
