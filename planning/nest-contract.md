# Backend Integration Contract — MOVED

> **MOVED.** This document has been superseded by [`08_BACKEND_CONTRACT.md`](../08_BACKEND_CONTRACT.md) at the repo root.
>
> Why moved: docs that describe the *contract* between gateway and nest belong at the repo root for discoverability (alongside the new `docs/` system narratives). The `planning/` folder is reserved for in-progress design docs and historical algorithm references.
>
> History snapshot: prior content (v2.2) covered the same surface area — three endpoints (`GET /ingestion/verify-key`, `POST /v1/raw_records`, `GET /v1/watermarks`), the structured `400 watermark_regression` body, stable `host_id` derivation, and the hysteresis `BUFFER_FULL` / `PAUSED` / `AUTH_FAILED` sentinels. All of that content was merged into `08_BACKEND_CONTRACT.md`. Consult git history if you need the older revisions.
