# Add a New Coding-Agent Source

1. Create `src/sources/<agent>/` with: `<agent>.constants.ts`, `<agent>.types.ts`, `discover.ts`, `collect.ts`, `index.ts`, `tests/`.
2. In `<agent>.constants.ts`, define the base dir subpath, glob pattern, and any per-source limits (mirror existing constants files).
3. In `discover.ts`, implement `discoverXxxFiles(baseDir, opts: { minimumMtime?: Date | null })` using `Bun.Glob.scan` with the pinned-depth glob. Filter by mtime. Return `DiscoveredFile[]`.
4. In `collect.ts`, implement `collectXxxFile(file, ctx)`. Follow the scaffold: read cursor from buffer, compute new slice, apply per-source filter, run `applyRedaction`, run `zstdCompressSync`, split with the appropriate splitter, insert batches, update cursor with `setCursor(...)`. Handle `consecutive_errors` in both success and catch paths.
5. Add the new `SOURCE_VARIANTS` entry in `src/services/contract/contract.constants.ts`. Determine `sourceKind`, `bodyFormat`, `watermarkKind`, `watermarkTableRequired`.
6. Add the new source to `default-sources.ts` in `src/services/polling/` (used by the capture cycle to spawn workers).
7. Add a new poll-worker handler in `poll-worker.ts` for the new source app.
8. Write tests covering: discovery (mtime filter, glob pattern), collection (watermark advance, filtering, redaction integration, VACUUM detection if sqlite, error path that bumps `consecutive_errors`), and the DTO shape.
9. Run `bun run check` and `bun run test:cov` scoped to the new source files.
10. Confirm `validateRawRecordDTO` accepts the new variant by adding a test case.
