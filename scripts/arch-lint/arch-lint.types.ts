export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly excerpt: string;
}

export interface RuleCheck {
  readonly rule: string;
  readonly applies: (filepath: string) => boolean;
  readonly match: (line: string) => boolean;
}
