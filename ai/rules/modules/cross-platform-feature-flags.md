---
name: "Cross-Platform Feature Branching"
description: "Requires platform-dependent logic to branch through central wiring instead of scattered process.platform checks."
activation: "contextual"
scenarios: ["Adding operating system-dependent logic", "Handling Windows binary locking or permissions", "Mocking platform parameters in tests"]
globs: ["src/**/*.ts", "**/*.ts"]
---

# Cross-Platform Feature Branching Rule


**When adding code whose behavior differs by OS, branch via the central
platform-detection wiring (`src/cli/wiring/platform.ts` and the
`platform` parameter threaded through callers) — never via inline
`process.platform === 'win32'` checks scattered through business
logic.**

Centralizing the OS check makes the test surface small (mock the
platform parameter, not the global `process` object) and makes "what
behaviors differ on Windows?" answerable by reading one file instead of
grepping the tree.

## What "central" means here

Two patterns are sanctioned:

### Pattern A: accept `platform` as a parameter

```ts
// good
export function replaceBinary(
  binaryPath: string,
  bytes: Uint8Array,
  platform: NodeJS.Platform,
): Promise<ReplaceBinaryResult> {
  if (platform === 'win32') {
    // ...
  }
  // ...
}

// caller (top of call stack):
await replaceBinary(path, bytes, deps.platform ?? process.platform);
```

The `?? process.platform` lives at the wiring layer (top of the call
stack: `src/main.ts`, `src/cli/wiring/*`). Inner functions take
`platform` as a parameter.

Canonical reference: `replaceBinary` in
`src/services/upgrade/release-fetch.ts:99-112`.

### Pattern B: import a platform helper from `cli/wiring/platform.ts`

For code that is genuinely platform-shaped (service-manager wiring,
launchd plist path, scheduled-task XML path), use the helpers there:

```ts
import { platformServiceUnitPath, buildPlatformServiceContext } from 'cli/wiring/platform.ts';
```

Adding a new OS-shaped capability means adding a function here, not
adding a `switch (process.platform)` somewhere else.

## What this rule prohibits

- `if (process.platform === 'win32')` inside `services/` or
  `sources/` code. Those layers must receive `platform` as a parameter.
- Calling `process.platform` more than once in a hot loop (capture
  cycle, drain cycle). Snapshot it once at wiring time.
- Mocking `process.platform` in tests by assigning to it. Tests inject
  the `platform` parameter directly.

## Exceptions

Three locations are allowed to read `process.platform` directly:

1. `src/main.ts` — the top of the CLI command dispatch
   (e.g. `process.platform` is passed into
   `buildPlatformServiceContext`).
2. `src/cli/wiring/platform.ts` — the central wiring module itself
   (but only as a fallback for callers that didn't pass an explicit
   value).
3. `src/core/io/fs/rm-recursive.ts` and similar low-level utilities
   that take `{ isWindows?: boolean }` options with a
   `process.platform === 'win32'` default. The option is what callers
   override in tests.

## Why this is a rule, not just a style preference

Three concrete bugs this prevents:

1. **In-place binary replacement** (`replaceBinary`): on Windows the
   running `.exe` is locked. If a developer adds a new
   write-to-binary path elsewhere and inlines `process.platform`, the
   Windows branch is easy to forget, and the next auto-upgrade on
   Windows fails opaquely with `EBUSY`.
2. **`chmod` and `chmodSync` on Windows**: Windows ignores chmod
   silently in most cases but can throw on some paths. The
   `setModeSilent` wrapper in `core/io/fs/mode.ts` is the central
   guard. Adding a fresh `chmodSync` call without platform gating
   risks a CI failure on the Windows runner.
3. **Path separator assertions**: scattered `'/'` literals in test
   assertions fail on Windows where `path.sep === '\\'`. Test rule
   `process/tests.md` already forbids the literal, but the prevention
   is centralizing the check at the boundary.

[source: src/cli/wiring/platform.ts, src/services/upgrade/release-fetch.ts, src/core/io/fs/rm-recursive.ts, src/core/io/fs/mode.ts]
