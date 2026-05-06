# E2E Test Report

End-to-end suite for the ProxAI Gateway. The suite drives the production
capture -> buffer -> upload pipeline against a single-process fake nest
server and asserts on real network round-trips, real SQLite buffer state,
and real source-file fixtures (Claude Code JSONL + a Cursor-style SQLite KV
store).

## Coverage

- **Scenarios:** 9
- **Tests:** 9 (one per scenario; each scenario name maps 1-to-1 to a
  `bun:test` `test(...)` call)
- **Files:**
  - `tests/e2e/fake-nest.ts` — single-file Bun.serve stub for
    `GET /ingestion/verify-key`, `GET /v1/watermarks`, `POST /v1/raw_records`
  - `tests/e2e/helpers.ts` — temp env, fixture planters, programmatic
    `runSetup` + single-cycle `runOneCycle` drivers
  - `tests/e2e/e2e.test.ts` — the 9 scenarios

### Scenario list

| Tag | Scenario                                              | What it asserts                                                                                                              |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A   | Happy path                                            | 3-turn JSONL captured + delivered; nest receives 1 batch with expected watermark range; body decompresses to original bytes  |
| B   | Multi-cycle continuation                              | Append after cycle 1 -> cycle 2 emits a second batch with non-overlapping `[N, M)` byte range and identical source_path_hash |
| C   | Reinstall / watermark sync                            | Wipe buffer + config, re-run setup with same key + machine_uuid; watermark sync seeds cursor; capture resumes from server N  |
| D   | Watermark regression recovery                         | Server pre-seeded ahead of local; gateway hits 400 watermark_regression, resets cursor; next cycle resumes from new position |
| E   | Invalid ingestion key (auth halt)                     | Revoked key -> 403 -> AUTH_FAILED sentinel written; subsequent cycle short-circuits; new key clears the sentinel             |
| F   | Buffer pressure -> BUFFER_FULL                       | Pending bytes pushed past 700 MB -> sentinel written; next cycle short-circuits                                              |
| G   | Pause sentinel manual override                        | Manual PAUSED -> cycle short-circuits; resume -> capture proceeds                                                            |
| H   | Time-based prune                                      | 5 receipts >31 days old + 3 fresh -> prune deletes the 5, keeps the 3                                                        |
| I   | Vacuum detection                                      | Pre-seeded cursor with size + watermark > current SQLite reality -> vacuum detected, source rotated via `#gen=1` suffix      |

## Notable findings

No production-code bugs were caught by the e2e suite. The pipeline behaved
as the per-module unit tests suggested it would when stitched together
end-to-end. A few implementation notes worth flagging:

- The DTO validation step in `HttpClient.uploadRawRecord` enforces the
  2 MiB compressed-body cap before the network call. Scenario F therefore
  uses 380 batches of ~1.9 MiB each (instead of a few large batches) so the
  retriable network failure path leaves them all pending; bodies above the
  cap would be marked `failed` and removed from pending bytes, causing the
  pressure check to never fire.
- The watermark sync path in `runDaemon` is gated on `countCursors === 0`.
  Scenario C invokes `syncServerWatermarks` directly after wiping the
  buffer, mirroring the daemon's pre-flight; the synced cursor is keyed
  under `source_inode = NO_INODE_SENTINEL` and the source poller's
  `getCursorWithFallback` correctly inherits the synced position when it
  later observes the file with its real inode.
- Scenario I exercises real SQLite vacuum-detection plumbing
  (`detectVacuum`) via the Cursor collector, including the
  `nextGenerationSuffix` re-keying that produces `#gen=1` source paths and
  fresh `source_path_hash` values on the upload.

## How to re-run

```sh
bun test tests/e2e
```

For full repo verification (typecheck + lint + format + all tests):

```sh
bun run check && bun test
```

The fake nest server picks a free port via `Bun.serve({ port: 0 })`, so the
suite can run in parallel with other servers on the same machine.
