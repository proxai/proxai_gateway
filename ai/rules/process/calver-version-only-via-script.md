# Version Bumping Rule

**Never hand-edit the version field in `package.json` for a release.
Always use `bun run release` (which invokes
`scripts/release/cli.ts`). Same-day retries use the `-N` suffix
computed by the script; do not advance the date manually.**

The version in the committed `package.json` is treated as a stale
snapshot. The authoritative version for a release is the git tag
(`v<YYYY.M.D>[-N]`), computed by `computeNextVersion` from the latest
existing `v*` tag and today's UTC date. CI stamps that version into
`package.json` at build time via `npm version --no-git-tag-version
--allow-same-version` in both the `build` and `npm-publish` jobs
(`.github/workflows/release.yml:82-83, 195-196`).

## What this rule prohibits

- Editing `package.json` `"version"` field by hand for any reason
  related to a release.
- Running `npm version <x>` locally to "prep" a release.
- Creating a `v*` tag manually (`git tag v2026.5.10`) instead of
  running `bun run release`.
- Using `-N` suffix for anything except "the same calendar UTC day
  already has a published tag and the second attempt is happening
  now". `-N` is **not** a beta/rc/preview channel.
- Bumping the date forward to avoid the suffix. CalVer dates are
  observational, not aspirational. If today's date already has a
  tag and you need to ship again, the version is `today-1`,
  `today-2`, etc.

## What the script does

`scripts/release/cli.ts` calls `runPublish` (`publish.ts:47-84`) which:

1. Asserts working tree clean and on `main` branch synced with
   `origin/main`.
2. Runs `bun run validate` (unless `--skip-validate`).
3. Computes the next version from existing tags + today's UTC date.
4. Prints the proposed tag.
5. Prompts for confirmation (unless `-y`).
6. Creates the annotated tag and pushes it.

The push triggers `release.yml`, which is the only mechanism that
publishes binaries to GitHub Releases and `@proxai/gateway` to npm.

## Same-day retry mechanics

If a release fails after the tag was pushed (e.g. npm-publish step
errored), the path forward is:

```
git tag -d v<date>
git push --delete origin v<date>
bun run release   # auto-detects existing/deleted tag, computes -1 suffix
```

After tag deletion, the next `release` invocation sees the latest
remaining tag is from yesterday (or earlier) and proposes
`v<today>`, NOT `v<today>-1`. The `-N` suffix only kicks in when a
*non-deleted* tag for today already exists. **Delete the failed tag
remote-side too**, otherwise the suffix increments unnecessarily.

The user's global rule confirms: "Same-day CalVer retries in
proxai_gateway suffix the same date with a hyphen; never bump the
date."

## Why this is a rule

1. **Determinism**: any maintainer running `bun run release` from a
   clean main produces the same tag the workflow expects. There is no
   "what did Alice mean by version 2026.5.10-1?"
2. **CI / local convergence**: the workflow stamps `package.json` from
   the tag. If `package.json` was hand-bumped to a different value,
   that hand-bumped value is overwritten and silently discarded.
3. **No SemVer drift**: hand-editing makes it easy to type
   `"2026.5.10"` as `"2026.05.10"` (rejected by `parseVersion`) or
   `"0.1.0"` (accepted by the regex but a date in year 0 — wrong
   semantics). The script's `todayUtc()` is the only safe path.
4. **The script is the only place that hits UTC**: hand-bumping during
   a UTC midnight crossover from a local-time perspective produces
   off-by-one date mismatches between local commits and CI tagging.

## SemVer-style requests

If a request comes in saying "bump the patch version" or "do a minor
bump" for proxai_gateway, **stop and ask**. CalVer has no equivalent.
A reasonable translation is "what change in behavior are you trying
to convey?" and then either:

- Just ship today's date (the normal flow); OR
- Bump a parser version per
  `ai/rules/sources/parser-version-bump-required.md` if the change
  is a record-shape diff.

Never silently translate a SemVer request into a CalVer bump.

[source: scripts/release/cli.ts, scripts/release/publish.ts, scripts/release/versioning.ts, .github/workflows/release.yml]
