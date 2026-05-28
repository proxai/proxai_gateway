---
name: "Cross-Platform Compatibility Guidelines"
description: "Command spawning, chmod gating, path separators, file deletion, and ANSI stripping rules for cross-platform support."
activation: "contextual"
scenarios: ["Spawning subprocesses with Bun.spawn", "Deleting SQLite databases or testing directory permissions", "Writing path assertions and regexes in unit tests"]
globs: ["src/**/*.ts", "**/*.ts"]
---

# Cross-Platform Rules


- Always resolve tool names via `Bun.which(name)` before `Bun.spawn`. If `Bun.which` returns `null`, treat the tool as absent and return an error result — never let spawn fail. Canonical reference: `src/services/uninstall/sweep.ts`.
- Never use `/bin/sh` in production code or tests. Use `bun -e '<script>'` for portable subprocess tests.
- Gate every `chmodSync` / `chmod` call behind `process.platform !== 'win32'`. Use `setModeSilent` from `core/io/fs/mode.ts` or wrap in try/catch.
- For sqlite teardown in tests on Windows: use `rmRecursive` from `core/io/fs/rm-recursive.ts` (not `node:fs.rm`). Extend `afterEach` timeout to 30 s. `rmRecursive` calls `Bun.gc(true)` and retries up to 10 times.
- The Windows scheduled-task XML must be UTF-16 LE with BOM (per `schtasks /Create /XML` requirement). Use `encodeScheduledTaskXml` — never write plain UTF-8.
- In-place binary replacement is impossible on Windows (running `.exe` is locked). The `replaceBinary` function stages at `<path>.new` on Windows. Never attempt `fs.writeFile(binaryPath, ...)` on Windows without this branch.
- Path assertions in tests must use `node:path.sep` or `node:path.join`; never compare with literal `'/'` in `toContain` / `toBe`.
- Strip ANSI codes with `stripAnsi(s)` before any regex/substring assertion in CLI output tests.
- `USERDOMAIN`/`USERNAME` resolution must go through `resolveWindowsUserId(env)` in `cli/wiring/platform.ts`; pass an explicit env in tests.
- For "force write failure" tests: use a real tempdir with a regular file as the parent path; produces `ENOTDIR` portably. Do not use `/dev/null/<x>`.
- For "extreme path" tests: embed a NUL byte (`\0`) in the path string. `node:fs.stat` rejects it on every platform.
- Tests depending on hardware or host kernel diagnostics (such as `readBootId`) must mock `core/system/boot-id.ts` in CI/Docker environments, where reading host `/proc/sys/kernel/random/boot_id` or running host shells will fail.
- To force write-permission errors portably without using Unix `chmodSync` (which Windows directory structures ignore), create a directory placeholder at the target lock file path (`mkdirSync(lockPath)`). Writing to this path will throw `EISDIR` portably across all platforms.
- Relative paths and subpaths returned by filesystem loaders or recursive copy routines that are written to manifests (e.g. `.mapper-manifest.json`) or compared in spec files must always normalize backslashes (`\`) to forward slashes (`/`). This guarantees cross-platform test stability and prevents dirty git diffs when syncing on Windows.
