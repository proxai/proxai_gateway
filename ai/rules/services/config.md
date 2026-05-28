---
name: "Configuration Management"
description: "Rule for config defaults, in-memory longevity, auto-upgrade signals, nest endpoints overrides, and cross-field configuration validation."
activation: "contextual"
scenarios: ["Adding new settings to config.toml", "Modifying daemon environment variables or endpoint overrides", "Implementing config validations or coercions"]
globs: ["src/**/*.ts", "**/*.ts"]
---

# Config Rules


- Default values live in `config.constants.ts`, not in the TOML file. `validateAndCoerce` fills them when fields are absent.
- Daemon-loop intervals (`CAPTURE_INTERVAL_MS`, `DRAIN_INTERVAL_MS`, `HEARTBEAT_INTERVAL_MS`) are not in `config.toml` and must not be added there.
- `PROXAI_GATEWAY_NEST_ENDPOINT` overrides the resolved nest base URL at module load. After `setup` writes `[backend]` to `config.toml`, the env var has no effect on a running daemon. To change the endpoint for a running install, edit `[backend]` or re-run `setup --force`.
- `install_source` drives the auto-upgrade branch (brew → sentinel; others → in-place replace) and the `uninstall` sweep. Never infer it from env vars at runtime; read it from `config.toml`.
- Config is loaded once at daemon start and kept in-memory for the process lifetime. Do not add live config-reload logic.
- The cross-field validation `buffer_soft_resume_bytes < buffer_soft_pause_bytes` is enforced at load time. A degenerate hysteresis config must be rejected with an explicit error.
