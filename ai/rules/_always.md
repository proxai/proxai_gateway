# proxai_gateway — Always-applied rules

- TypeScript `any` is prohibited in source and tests; no `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable`, `oxlint-disable`, or `v8 ignore` suppressions.
- The non-null assertion operator (`x!`) is prohibited; the lint rule `typescript/no-non-null-assertion` enforces it. Use `requireDefined(x)` from `core/utils` for runtime narrowing of `T | null | undefined`, or refactor the surrounding code so the optionality is impossible.
- Object-literal type assertions (`{ ... } as Type`) are prohibited; the lint rule `typescript/consistent-type-assertions` with `objectLiteralTypeAssertions: 'never'` enforces it. Use a variable annotation (`const x: Type = { ... }`) or `satisfies Type` instead.
- The `as unknown as Target` bridge cast is a code smell; eliminate it by defining narrower interfaces that the value actually satisfies, by adding a type guard that narrows `unknown` properly, or by re-shaping the production API to accept the test mock's true type. When an external type's shape genuinely requires bridging, isolate the cast in one helper function whose signature accepts `unknown` and returns the narrowed type, so the rest of the codebase stays free of the pattern.
- Replace `any` and `unknown` casts with proper narrowing: type guards (`function isX(v: unknown): v is X`), discriminated unions, the `satisfies` operator, `instanceof` checks, and `in` checks. Prefer these "advanced type handlers" over bypassing the type system.
- Prefer `import type` for purely type-only imports so they don't add to the runtime bundle and so the rule for restricted runtime imports (e.g. `bun:sqlite`) does not fire on type-level references.
- Helpers in `core/utils/assert.ts`: `requireDefined`, `requireString`, `requireNumber`, `requireRecord`, `isErrnoException`, `errnoCode`, `isRecord`. Use these instead of inline `!`, ad-hoc `typeof` checks, or `as` casts when narrowing `unknown` from external sources (HTTP bodies, `JSON.parse` output, Node error catches).
- Use bun (`bun.lock` present); never npm/yarn/pnpm.
- Versioning is **pure CalVer** (`YYYY.M.D`); never SemVer; same-day retries suffix with hyphen (e.g. `2026.5.8-1`).
- Conventional Commits required; subjects ≤70 chars in imperative mood; no AI/Co-Authored-By trailers.
- Be decisive in technical communication; do not lecture or narrate verification steps.
- For non-trivial fixes with design choices, write a 2-3-option plan and wait for explicit go before coding.
- Brainstorm specs and implementation plans live in `.tmp/`; the repo's `docs/` folder is the canonical product documentation tree imported from `~/repos/proxai/docs/proxai-gateway/` and may be added to.
- Zero inline or block code comments (`//`, `/* */`) in any `src/` file; write self-documenting code instead. Comments are permitted only in the root `README.md`, CLI help text, and terminal output formatting variables.
- For common tasks use the canonical package.json scripts: `bun run check` (lint + format + typecheck), `bun run test:cov` (all tests with coverage), `bun run format` (format only), `bun run typecheck` (typecheck only), `bun run diagrams:export` (regenerate state-machine diagrams). The `bun:sqlite` import restriction is enforced by oxlint via `no-restricted-imports`. Never assume raw flags.
- Temporary files, logs, and scratch outputs go in `.tmp/` at repo root; never commit `.tmp/` or `scratch/` contents.
