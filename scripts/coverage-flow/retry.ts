// Retry/convergence loop for flaky COVERAGE GAPS only.
//
// Flaky test FAILURES are handled upstream by bun's native in-process `--retry`
// (see BUN_TEST_BASE_ARGS), so by the time a run reaches here any remaining
// failure is genuine. What bun cannot retry is coverage: a file can read <100%
// on one full run and 100% on the next (timing-sensitive incidental coverage,
// or an occasional bun instrumentation hiccup). Coverage is only correct in
// aggregate, so each round re-runs the FULL suite serially — never a subset,
// which would under-measure a file covered by multiple test files. A gap that
// reaches 100/100 on a re-run was flaky ("recovered"); one that persists is
// authentic. Stop when no gap remains, when the gap set is unchanged versus the
// previous round, or after MAX_RETRIES. The loop is recursive so the sequential
// `await` between rounds reads cleanly.

import { MAX_RETRIES } from './constants.ts';
import type { CoverageRow, GapVerdict, ParsedRun, RawRun, RetryOutcome } from './types.ts';

export interface RetryDeps {
  rerun: (label: string) => Promise<RawRun>;
  parse: (raw: RawRun) => ParsedRun;
}

interface GapState {
  pending: Map<string, CoverageRow>;
  recovered: Set<string>;
}

function signature(gaps: Map<string, CoverageRow>): string {
  return Array.from(gaps, ([f, r]) => `${f}:${r.funcs}:${r.lines}`)
    .toSorted()
    .join('|');
}

function applyRound(state: GapState, parsed: ParsedRun): void {
  for (const [src, oldRow] of Array.from(state.pending)) {
    const row = parsed.coverageByFile.get(src);
    if (row === undefined) continue; // not measured this round -> keep
    if (row.funcs >= 100 && row.lines >= 100) {
      state.recovered.add(src);
      state.pending.delete(src);
    } else if (row.funcs !== oldRow.funcs || row.lines !== oldRow.lines) {
      state.pending.set(src, row);
    }
  }
}

async function runRounds(
  state: GapState,
  prevSig: string | null,
  retries: number,
  deps: RetryDeps,
): Promise<{ retries: number; converged: boolean }> {
  if (state.pending.size === 0) return { retries, converged: true };
  if (retries >= MAX_RETRIES) return { retries, converged: false };
  const round = retries + 1;
  const parsed = deps.parse(
    await deps.rerun(`gap re-check ${round}/${MAX_RETRIES} (full suite, serial)`),
  );
  applyRound(state, parsed);
  const sig = signature(state.pending);
  if (prevSig !== null && sig === prevSig) return { retries: round, converged: true };
  return runRounds(state, sig, round, deps);
}

export async function runRetryFlow(main: ParsedRun, deps: RetryDeps): Promise<RetryOutcome> {
  const state: GapState = {
    pending: new Map<string, CoverageRow>(main.gaps.map((g) => [g.file, g])),
    recovered: new Set<string>(),
  };
  const originalGapFiles = Array.from(state.pending.keys());

  if (originalGapFiles.length === 0) {
    return { ran: false, retries: 0, converged: true, gaps: [] };
  }

  const { retries, converged } = await runRounds(state, null, 0, deps);
  const allCleared = state.pending.size === 0;

  const gaps: GapVerdict[] = originalGapFiles.map((file) => {
    const row = main.coverageByFile.get(file);
    return {
      file,
      recovered: state.recovered.has(file),
      funcs: row?.funcs ?? 0,
      lines: row?.lines ?? 0,
    };
  });

  return { ran: true, retries, converged: converged || allCleared, gaps };
}
