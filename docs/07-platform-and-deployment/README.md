[← Previous: 06 — Operations](../06-operations/README.md) · [Top Index](../README.md)

# Platform & Deployment (07)

What differs across platforms, and how the gateway is built, released, installed, and tested. This is the section to consult when working on anything that touches platform-specific code, the build pipeline, the install scripts, or the CI workflows.

## Docs in this section

1. [7.1 Cross-Platform Differences](./7.1-cross-platform-differences.md) — service units, paths, service managers, spawn quirks, filesystem locking quirks, test-runner pitfalls, install-flow variations.
2. [7.2 Install, Upgrade & Uninstall](./7.2-install-upgrade-uninstall.md) — six install sources, auto-upgrade branches, the Windows `.new` caveat, and uninstall vs. `uninstall --reset`.
3. [7.3 Build & Release](./7.3-build-and-release.md) — `scripts/build.ts`, the release CLI, the npm package preparation, CalVer rules, and the release-artifact layout.
4. [7.4 CI/CD Pipeline](./7.4-ci-cd-pipeline.md) — the five `.github/workflows/` files, PR gates, the husky pre-commit hook, branch-protection assumptions, release-publishing automation.

This is the terminal section. For runtime behaviour from the user's perspective once the binary is installed, see [Operations](../06-operations/README.md).

[← Previous: 06 — Operations](../06-operations/README.md) · [Top Index](../README.md)
