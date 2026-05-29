---
name: "Cross-Platform Compatibility"
description: "Rules and conventions for building and testing platform-independent code across macOS, Linux, and Windows for both arm64 and x64 architectures."
activation: "global"
scenarios: ["Writing file operations", "Handling system paths", "Designing process interactions", "Writing test assertions"]
---

# Cross-Platform Compatibility Rules

## 1. Path Separation and Construction

- Never use hardcoded forward slashes (`/`) or backslashes (`\`) to build, compare, or assert filesystem paths.
- Always use `join`, `resolve`, or `sep` from `node:path` for all dynamic path constructions and platform-agnostic assertions.
- Example of correct path building:
  ```typescript
  import { join } from 'node:path';
  const path = join('Library', 'Application Support', 'Claude');
  ```

## 2. Glob Pattern Construction

- Glob patterns (used by `Bun.Glob`, `minimatch`, or `picomatch`) internally require forward slashes (`/`) on all platforms, including Windows. 
- Never use `join()` or backslashes (`\`) to define glob patterns. Keep glob patterns literal with `/` separators.
- Example of correct glob pattern:
  ```typescript
  const pattern = '*/*/local_*/audit.jsonl';
  ```

## 3. Dynamic Test Assertions

- Never use hardcoded string assertions containing `/` or `\` when asserting generated paths in unit tests (e.g., `expect(path).toContain('/foo/bar')`).
- Dynamically build the expected string using `join()` to match the platform-specific separator.
- Example of correct path assertion in tests:
  ```typescript
  import { join } from 'node:path';
  const expected = join('Library', 'Application Support', 'Claude');
  expect(path).toContain(expected);
  ```

## 4. OS Utilities & Environment Values

- Use Node.js standard library abstractions like `homedir()` from `node:os` or `tmpdir()` to fetch system locations. Do not manually parse `process.env.HOME`, `process.env.USERPROFILE`, or `process.env.TMPDIR`.
- Suffix executable commands dynamically on Windows (e.g., appending `.exe` on `win32` platform architectures).
