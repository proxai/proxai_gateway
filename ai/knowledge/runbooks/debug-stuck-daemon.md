# Debug a Stuck Daemon

1. Run `proxai-gateway status` and check the Sentinels section. If `AUTH_FAILED` is shown: re-run `proxai-gateway setup new` with a valid key. If `BUFFER_FULL` is shown: wait for drain to catch up or temporarily lower `buffer_soft_pause_bytes` in `config.toml`. If `SESSION_STOPPED` is shown: run `proxai-gateway start` (or reboot — the sentinel self-clears on the next boot).
2. Check the Health section for binary age. If ≥30 days the daemon logs a warning; if ≥60 days it logs `stale_binary.stale` and the next heartbeat's auto-upgrade replaces the binary.
3. Run `proxai-gateway tail --level warn --since 2h` to see recent problems. Look for `upload.rate_limited`, `upload.retriable`, `upload.fatal`, or `auth.invalid`.
4. For persistent retriable failures: check `http_status` and `http_body` in the log event. `http_status: null` = network problem. 429 with a long `retry_after_ms` = server rate limit.
5. For `upload.fatal`: examine `kind` and `error`. `ValidationError` means the DTO was rejected (shouldn't happen on well-formed input); `OversizedDecompressedSliceError` means a single row exceeded 10 MiB — check `quarantined_records` via `status` for a count.
6. For consecutive retriable break (3 in a row): the drain loop stopped for that cycle; it retries on the next 30-second tick. Look for `drain.cycle.skipped` or `drain.complete` with `attempted > 0, accepted = 0`.
7. If `AUTH_FAILED` keeps reappearing: the ingestion key may be revoked. Verify at proxai.co and run `setup new` with the new key.
8. Check `buffer.soft_pause` events — if they're frequent, the uploader is too slow for the capture rate. Increase `upload_max_bytes_per_minute` in `config.toml`.
9. To inspect raw DB state: `proxai-gateway inspect` (dry-run scan across all sources, generates a markdown report in `/tmp/proxai-gateway/reports/`).
10. Check the `proxai-gateway doctor` output for finding `A16` (tripped circuit breaker warning).
11. The watchdog uses an attempt ledger (`RESCUE_LEDGER` located in the config directory) to track health. If 3 consecutive rescue failures occur, the circuit breaker trips and halts auto-recovery. Resolve the underlying root cause (such as invalid keys via `proxai-gateway setup new`) and reset the circuit breaker by manually starting the daemon via `proxai-gateway start`.
12. Inspect the structured logs for any `*.loop.crashed` or `*.cycle.timeout` messages to diagnose crashed loop states or cycle timeout conditions.
