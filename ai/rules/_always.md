# proxai_gateway — Always-applied rules

- TypeScript `any` is prohibited in source and tests; no `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable`, `oxlint-disable`, or `v8 ignore` suppressions.
- Replace `any` with `unknown` + type guard for unknown boundary shapes.
- Use bun (`bun.lock` present); never npm/yarn/pnpm.
- Versioning is **pure CalVer** (`YYYY.M.D`); never SemVer; same-day retries suffix with hyphen (e.g. `2026.5.8-1`).
- Conventional Commits required; subjects ≤70 chars in imperative mood; no AI/Co-Authored-By trailers.
- Be decisive in technical communication; do not lecture or narrate verification steps.
- For non-trivial fixes with design choices, write a 2-3-option plan and wait for explicit go before coding.
- Brainstorm specs and implementation plans live in `.tmp/`; the repo's `docs/` folder is the canonical product documentation tree imported from `~/repos/proxai/docs/proxai-gateway/` and may be added to.
- Zero inline or block code comments (`//`, `/* */`) in any `src/` file; write self-documenting code instead. Comments are permitted only in the root `README.md`, CLI help text, and terminal output formatting variables.
- For common tasks use the canonical package.json scripts: `bun run check` (lint + format + typecheck), `bun run test:cov` (all tests with coverage), `bun run format` (format only), `bun run typecheck` (typecheck only), `bun run diagrams:export` (regenerate state-machine diagrams). The `bun:sqlite` import restriction is enforced by oxlint via `no-restricted-imports`. Never assume raw flags.
- Temporary files, logs, and scratch outputs go in `.tmp/` at repo root; never commit `.tmp/` or `scratch/` contents.
