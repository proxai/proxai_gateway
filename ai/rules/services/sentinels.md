# Sentinel Rules

Applies to `src/core/io/fs/sentinel.ts` and `src/services/polling/*-sentinel.ts`.

- Use `writeAtomic` (write-to-temp then `rename`) for all sentinel writes. Never use `Bun.write(path, body)` directly for sentinels.
- All six sentinel files live under `configDir()`. Never write sentinel-like flags to a different directory or to the DB.
- `SESSION_STOPPED` is the only sentinel whose read is self-clearing. Its `boot_id` payload must match the current `readBootId()` value to gate; a mismatch self-clears. Do not replicate this pattern to other sentinels.
- A gate check is a single `stat`-equivalent `Bun.file(path).exists()` call. Never read + parse the body inside a hot gate loop — the gate must fire on existence alone.
- `CONSENT_ACCEPTED` is informational only and must never gate any cycle. Do not add gates on it.
- Malformed JSON bodies in any sentinel must degrade gracefully (return `null` / default). Gate observers must never throw on a corrupted body.
