// Shared shapes for the coverage-flow reporter. No logic here.

export type TestStatus = 'pass' | 'fail' | 'skip';

export interface TestCase {
  name: string;
  file: string;
  line: number;
  durationMs: number;
  status: TestStatus;
}

export interface CoverageRow {
  file: string;
  funcs: number;
  lines: number;
  uncovered: string;
}

// Raw output of one `bun test` invocation, before parsing.
export interface RawRun {
  junitXml: string;
  consoleText: string;
  wallClockMs: number;
  summarySeen: boolean;
  exitCode: number | null;
}

// One run, parsed into structured data.
export interface ParsedRun {
  tests: TestCase[];
  coverageByFile: Map<string, CoverageRow>;
  coverageAll: CoverageRow | null;
  coverageTotal: number;
  gaps: CoverageRow[];
  // key: `<file> <testName>` -> bun's verbose failure block
  failureDetails: Map<string, string>;
}

// Verdict for a coverage-gap source file after the gap re-check flow.
export interface GapVerdict {
  file: string;
  recovered: boolean; // reached 100/100 in some re-run (the gap was flaky)
  funcs: number; // coverage from the authoritative main run
  lines: number;
}

export interface RetryOutcome {
  ran: boolean; // false when the main run had no coverage gaps to recheck
  retries: number;
  converged: boolean; // stabilized before MAX_RETRIES
  gaps: GapVerdict[];
}
