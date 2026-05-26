# Fix a Coverage Gate Failure

1. Run `bun run test:cov` and look at the coverage report for uncovered lines/functions.
2. Do NOT run `bun test --parallel --coverage` — `--parallel` and `--coverage` do not compose cleanly in Bun 1.3.x. The coverage gate uses `bun test --coverage` (single-process).
3. Identify the file. Find the matching test file under `<module>/tests/`.
4. For uncovered branches: add a unit test that triggers the specific condition. For sqlite-touching tests: use dependency injection; never execute real SQL in unit tests.
5. For process-global module mocks (`mock.module(...)`): pre-import the real module before mocking and restore in `afterEach`. `mock.restore()` does not undo module mocks.
6. If the file is under `src/sources/<agent>/parsers/<agent>/tests/`, note that the bulk audit misses this path — run `bun run test:cov` on the specific file path.
7. For tests that spawn subprocesses or run concurrent intervals: pass an explicit timeout of `30_000` as the third arg to `test(name, fn, timeout)`.
8. For Windows-specific path assertions that fail on CI: use `node:path.sep` / `node:path.join` rather than literal `/`.
9. Run `bun run typecheck` after adding tests to ensure no `any` was introduced.
10. Run `bun run check` (full lint+format+typecheck) before pushing.
