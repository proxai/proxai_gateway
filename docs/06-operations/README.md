[← Previous: 05 — Backend](../05-backend/README.md) · [Top Index](../README.md) · [Next: 07 — Platform & Deployment →](../07-platform-and-deployment/README.md)

# Operations (06)

*Last Updated: 2026-05-27*

How to run, configure, and observe a running gateway. The docs cover the persistent per-profile `config.toml`, the per-platform daemon and service-unit lifecycle (one prod and one dev daemon, run side by side), the CLI surface plus its observability outputs (`status`, `logs`, `doctor`, `tail`, the structured log file), the maintainer debug flags, and the dev-mode / profile isolation model.

## Docs in this section

1. [6.1 Configuration](./6.1-configuration.md) — the per-profile `config.toml` structure, every section's fields and defaults, and runtime overrides.
2. [6.2 Daemon & Service Unit](./6.2-daemon-and-service-unit.md) — the prod and dev launchd / systemd / Scheduled Task descriptors and the `start` / `stop` / `restart` command mapping per platform.
3. [6.3 CLI & Observability](./6.3-cli-and-observability.md) — every command and alias, the god-mode visibility model, the `status` sections, the `logs` and `doctor` commands, `tail` filters, log paths, exit codes, and structured event names.
4. [6.4 Maintainer Debug Flags](./6.4-maintainer-debug-flags.md) — env-var-controlled toggles for gateway maintainers; not surfaced in `config.toml` or CLI `--help`.
5. [6.5 Dev Mode & Profiles](./6.5-dev-mode-and-profiles.md) — the prod/dev profile isolation model, the boot-scoped dev-mode toggle, the two simultaneous daemons, and uninstall semantics.

Platform-specific lifecycle details (install, upgrade, uninstall, cross-platform differences) live in [Platform & Deployment](../07-platform-and-deployment/README.md).

[← Previous: 05 — Backend](../05-backend/README.md) · [Top Index](../README.md) · [Next: 07 — Platform & Deployment →](../07-platform-and-deployment/README.md)
