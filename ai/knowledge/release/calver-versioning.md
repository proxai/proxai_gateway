# CalVer Versioning

proxai_gateway uses pure **CalVer** (`YYYY.M.D`) — no SemVer, ever. This file
explains the scheme, why it was chosen for this surface, and how same-day
retries work.

## Scheme

A version is `year.month.day[-N]`:

- `year` — four-digit calendar year (e.g. `2026`)
- `month` — 1-12, **no zero-padding** (e.g. `5` not `05`)
- `day` — 1-31, **no zero-padding**
- `-N` — optional integer suffix for same-day retries (starts at `-1`)

Examples: `2026.5.10`, `2026.5.10-1`, `2026.12.1-3`.

The `Version` record (`scripts/release/versioning.ts:1-6`) is `{ year, month,
day, suffix: number | null }`. The regex `^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$`
gates parsing; padded values like `2026.05.10` are not accepted.

## Why CalVer (not SemVer) for the gateway

The gateway is a **daemon** the user installs once and forgets. There is no
library API surface that downstream code depends on — every consumer is the
running daemon itself, auto-upgrading from GitHub Releases. SemVer's
"contract change" signal is therefore noise: every release is conceptually
"the latest gateway". CalVer makes "what version is this user running?" a
date-arithmetic question rather than a changelog lookup, which is exactly
what the stale-binary warn/pause policy (`stale-binary.ts:31`) keys off.

The schema-level contracts the gateway *does* have (the `RawRecordDTO` shape,
the `SOURCE_VARIANTS` matrix, the `RedactionRule` interface) are guarded
by server-side validation and the on-device `validateRawRecordDTO`, not by
a version number on the binary.

The user's global rule confirms: SemVer everywhere **except**
proxai_gateway, which is CalVer-only.

## Same-day retries: `-N` suffix

If a release fails mid-publish (e.g. npm publish errored after the tag
was pushed), the date does not advance. `computeNextVersion`
(`scripts/release/versioning.ts:59-73`) bumps the suffix instead:

- First release of the day: `2026.5.10`
- Second attempt same UTC day: `2026.5.10-1`
- Third: `2026.5.10-2`
- New day: `2026.5.11` (suffix resets to `null`)

The decision uses `compareDates` on the latest existing tag vs `todayUtc()`.
If today is strictly later, return today with no suffix; otherwise reuse
the latest date and increment its suffix (`latest.suffix ?? 0) + 1`).

UTC is load-bearing: `todayUtc()` reads `getUTCFullYear()` / `getUTCMonth()
+ 1` / `getUTCDate()` from `new Date()`. A maintainer in UTC-8 pushing at
local midnight will still see the same date the workflow computes server-
side.

## Version comparison logic

`compareVersions` (`versioning.ts:31-37`) is `compareDates` first, then
`(a.suffix ?? 0) - (b.suffix ?? 0)`. Implication: an unsuffixed `2026.5.10`
is treated as suffix-0, so it sorts **before** `2026.5.10-1`. This is what
`pickLatestTag` relies on to find the most recent existing tag before
computing the next one.

The auto-upgrade path (`services/polling/version-check.ts:84-101`) uses a
different comparator — `compareVersionStrings` splits on `.` and parses
ints — because it operates on raw strings from the GitHub API and does not
need the same `Version` shape. Both comparators agree on the ordering of
well-formed CalVer tags; the daemon path is just looser about
non-CalVer-looking strings.

## Never hand-bump

The version in `package.json` is **stamped at build time** by the
`release.yml` workflow (`npm version "${{ needs.version.outputs.version }}"
--no-git-tag-version --allow-same-version`). The local `package.json`
value is a stale snapshot for dev convenience. Hand-bumping it has no
effect on the next published version; only the git tag (computed by
`scripts/release/cli.ts`) matters.

[source: scripts/release/versioning.ts, scripts/release/publish.ts, .github/workflows/release.yml, src/services/polling/version-check.ts]
