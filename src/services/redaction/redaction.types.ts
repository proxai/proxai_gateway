export type RedactionStage = 1 | 2;

export interface RedactionRule {
  id: string;
  description: string;
  pattern: RegExp;
  replacement: string;
  stage: RedactionStage;
}

export interface RedactionResult {
  redacted: string;
  matchCount: number;
  ruleHits: Record<string, number>;
}
