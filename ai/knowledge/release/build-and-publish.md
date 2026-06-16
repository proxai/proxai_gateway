# Build and Publish

How a `v<calver>` tag becomes signed binaries on GitHub Releases plus a
published `@proxai/gateway` npm package. There is no manual build step
maintainers run for a release — the GitHub Actions workflow owns the full
matrix.

## Local build (`scripts/build.ts`)

Used both by CI and `bun run build:<target>` locally. Drives `bun build
--compile` against `src/main.ts` once per target:

- Six matrix entries (`scripts/build.ts:11-18`): `darwin-arm64`,
  `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-x64`, `windows-arm64`
- Output: `dist/<platform>-<arch>/proxai-gateway[.exe]`
- Target flag: `bun-<platform>-<arch>` (e.g. `bun-darwin-arm64`)
- Each target compiles sequentially; first non-zero exit code aborts the
  rest (`build.ts:78-79`)

Locally, only `bun run build:darwin-arm64` runs as part of `bun run
validate` (`package.json:52`). The full matrix only runs in CI.

`scripts/build.ts` supports targets like macOS x64, but it is intentionally
absent from the CI matrix in `.github/workflows/release.yml` — Apple Silicon
(`darwin-arm64`) is the only shipped macOS target. The CI matrix builds five
targets: `darwin-arm64`, `linux-arm64`, `linux-x64`, `windows-x64`, and `windows-arm64`.

## CI matrix (`.github/workflows/release.yml`)

Trigger: `push: tags: ['v*']`. Concurrency group `release-${{ github.ref
}}` with `cancel-in-progress: false` — a re-pushed tag will queue, not
abort.

Four jobs:

1. **version** — strips the `v` prefix and exports `version` / `tag` as
   outputs. Runs on `ubuntu-latest`.
2. **build** — matrix of five targets: `darwin-arm64` runs on `macos-latest` (native runner), while `linux-arm64`, `linux-x64`, `windows-x64`, and `windows-arm64` run on `ubuntu-latest` (cross-compilation). Each step: checkout, `setup-bun@v2`
   pinned to 1.3.14, `actions/setup-node@v6` with node version 24, restore the
   cache using `actions/cache@v5`, `bun install --frozen-lockfile`, `npm version --no-git-tag-version --allow-same-version` to stamp the version into `package.json`, and then `bun run build:<target>`. For macOS builds, it also runs ad-hoc codesign verification. Artifact is uploaded with `if-no-files-found: error`, retention 7 days.
3. **release** — depends on `build`. Downloads all artifacts, runs the
   asset-renaming `REMAP` (see below), generates `sha256sum > checksums.txt`,
   then uses `softprops/action-gh-release@v3` with `make_latest: 'true'`
   and `generate_release_notes: true`.
4. **npm-publish** — depends on `release`. Stamps the version into
   `package.json` *again* (separate job, fresh checkout), runs
   `bun scripts/publish-npm.ts` to stage `npm-build/`, then `npm publish
   --access public --tag latest` from inside `npm-build/`. Gated on
   `NPM_TOKEN` secret; if absent, emits a `::warning::` and skips.

## Asset remapping (windows → win32)

The build matrix uses Bun's `windows-<arch>` naming but the npm shim
expects `win32-<arch>` (matching `process.platform === 'win32'`). The
`release` job remaps before staging (`release.yml:118-141`):

```
darwin-arm64 → darwin-arm64
linux-arm64  → linux-arm64
linux-x64    → linux-x64
windows-x64  → win32-x64.exe
windows-arm64 → win32-arm64.exe
```

The auto-upgrade asset lookup (`release-fetch.ts:49-52` and
`version-check.ts:67-70`) computes
`proxai-gateway-${platform}-${arch}${ext}` where `platform` is
`NodeJS.Platform` (i.e. `win32`, not `windows`). The remap is the bridge
between Bun's target naming and Node's platform naming. **If you rename a
build target, you must also update the remap and the auto-upgrade
expectation in lockstep.**

## Release artifact structure

GitHub Release page after `npm-publish` completes:

- `proxai-gateway-darwin-arm64`
- `proxai-gateway-linux-arm64`
- `proxai-gateway-linux-x64`
- `proxai-gateway-win32-x64.exe`
- `proxai-gateway-win32-arm64.exe`
- `checksums.txt` (sha256 of each)

`make_latest: 'true'` is required — the auto-upgrade hits
`/repos/proxai/proxai_gateway/releases/latest`
(`release-fetch.ts:13`) which only returns the `latest` release.

## npm package (`scripts/publish-npm.ts`)

Stages a `npm-build/` directory with:

- `package.json` — synthesised from root (`publish-npm.ts:42-57`); name
  rewritten to `@proxai/gateway`, `bin` points to `shim.js`,
  `postinstall: 'node postinstall.js'`, `engines: { node: '>=18' }`,
  `files: ['shim.js', 'postinstall.js', 'README.md', 'LICENSE']`
- `shim.js` (from `npm/shim.js`) — the Node entry that re-execs the
  platform binary
- `postinstall.js` (from `npm/postinstall.js`) — downloads the matching
  binary from the GitHub Release on `npm install`
- `README.md`, `LICENSE`

`access: 'public'` is hard-coded in `publishConfig`. No signing or
notarization happens at any step.

## Signing / notarization

**None.** macOS binaries are unsigned and unnotarized — users must run
`xattr -d com.apple.quarantine` after download, or accept the Gatekeeper
prompt. Windows binaries are unsigned — SmartScreen will warn. This is a
known operational gap; adding it would require maintaining signing
identities in repo secrets.

[source: scripts/build.ts, scripts/publish-npm.ts, .github/workflows/release.yml, src/services/upgrade/release-fetch.ts]
