# Gemini `antigravity/3.0.0` — `.db` decode + gen→turn join (canonical reference)

**Status:** empirically confirmed 2026-07-02 on frozen copies of 4 real conversation
`.db`s (`_nest`/`_ops` dogfood), 21 generations total. This is the spec the
`gemini/v3` nest parser implements (Task 3 of the recovery plan).

> Scope: **forward token recovery only.** The updated Antigravity writes
> `~/.gemini/antigravity/conversations/<uuid>.db` (SQLite, WAL) with **plaintext
> protobuf** — unlike the old encrypted `.pb`. The gateway captures this `.db`
> (replacing the tokenless `transcript.jsonl` capture); this doc covers the decode.

---

## Tables used

| table | columns used | role |
|---|---|---|
| `steps` | `idx` (PK, int), `step_type` (int), `step_payload` (BLOB) | ordered conversation steps; `step_type` segments turns |
| `gen_metadata` | `idx` (PK, int), `data` (BLOB) | one row per model generation; `data` is a protobuf carrying token usage |

Unused: `parent_references` (**empty** in all 4 DBs — not a join source),
`executor_metadata` / `trajectory_meta` / `trajectory_metadata_blob` /
`battle_mode_infos` (static config / unrelated).

### `steps.step_type` values seen
`14` = user/opening turn · `15` = assistant generation (carries the gen's
`request_id` in its payload) · tool/system others: `8,9,17,23,90,98,101,127,132`.
**Not every `type=15` step has a generation** — b53cc390 has 5 type-15 steps but
only 4 gens (step idx 1 is gen-less). This is why positional/ordinal matching is
unsafe (see Join).

---

## `gen_metadata.data` protobuf field paths (dotted, per `proto-scan.ts`)

| path | meaning | → ACR column |
|---|---|---|
| `1.4.2` | promptTokenCount (**fresh** input, disjoint from cached) | `inputTokens` |
| `1.4.5` | cachedContentTokenCount (cache read) | `cacheReadInputTokens` |
| `1.4.3` | candidatesTokenCount (**full** output — already includes thoughts) | `outputTokens` |
| `1.4.9` | thoughtsTokenCount | — (do NOT add; already in `1.4.3`) |
| `1.4.10` | visible output (= `1.4.3 − 1.4.9`) | — (informational) |
| `1.4.11` | **request_id** (string) | — (**the join key**) |
| — | (Gemini has no cache-creation counter) | `cacheCreationInputTokens = null` |

**Do NOT use:** `1.4.1` / `1.3` (constant `1036`, a config id — not a token total).
`1.20` is a repeated string-keyed metadata bag (`{key,value}` string pairs;
`last_step_index` is one entry whose *value is a string* and whose order varies per
DB) — **not** a usable scalar cross-check.

### Token mapping (F3-safe) — final
```
inputTokens              = prompt    (1.4.2)          // NOT prompt − cached
cacheReadInputTokens     = cached    (1.4.5)          // null → 0 when summing
outputTokens             = candidates(1.4.3)          // NOT candidates + thoughts
cacheCreationInputTokens = null
```
Empirical proof (all 21 gens): `1.4.3 == 1.4.10 + 1.4.9` (candidates already
includes thoughts → summing them double-counts by 23–79%); `cached > prompt` in
18/18 gens where both are present (they are **disjoint** — `prompt − cached` would
clamp to 0 and destroy the signal).

---

## The join: `gen → step → turn`

### Step 1 — gen → step (the ONLY reliable link)
Each `gen_metadata.data`'s `request_id (1.4.11)` appears **verbatim as a byte
substring in exactly one `steps.step_payload`**, and that step is **always
`step_type=15`**. Confirmed **21/21 gens, 0 orphans, 0 multi-matches** across all 4
DBs. `request_id`s are long high-entropy strings, so a raw-byte substring search is
unambiguous.

> **Do NOT fall back to ordinal (Nth gen ↔ Nth type-15 step).** b53cc390 has a
> gen-less type-15 step (idx 1), so ordinal shifts every attribution by one. The
> `request_id` join handled it correctly (gens → steps 3,6,8,10). If a gen ever
> matches 0 steps, emit `agent_gateway_parser_gemini_gen_unjoined_total` and drop
> that gen from attribution — do **not** guess positionally.

### Step 2 — turn segmentation
Walk `steps` in `idx` order: a `step_type=14` opens a new user turn; every
following step attaches to it until the next `14`. (Turn count seen: 1–2 per DB.)

### Step 3 — attribute + sum (one ACR per user turn)
Each gen → its type-15 step → the turn containing that step. Sum a turn's gens
(null cached → 0). Per-turn totals reconciled **exactly** to the raw `gen_metadata`
sums of the same frozen copy, all 4 DBs. A single user turn may own many gens (274af707
= 8 gens under 1 turn).

### Edge cases
- **`cached = null`**: cold-cache first turn *or* an error/429 generation. Treat as
  0, **never skip the gen** — it still carries real `prompt`/`candidates` usage and
  must be counted (3 such gens in the fixtures, all legitimate first-turns).

---

## Evidence (frozen copies, 2026-07-02)

| DB (uuid[:8]) | steps | gens | turns | type-15 steps | raw prompt / cached / candidates | recon | join |
|---|---|---|---|---|---|---|---|
| 274af707 | 21 | 8 | 1 | 8 | 47073 / 129943 / 2827 | ✅ | 8/8 |
| 31394d66 | 17 | 5 | 2 | 5 | 49131 / 122752 / 3307 | ✅ | 5/5 |
| b53cc390 | 11 | 4 | 1 | **5** (1 gen-less) | 27488 / 48759 / 1193 | ✅ | 4/4 |
| bd4eff9a | 14 | 4 | 2 | 4 | 21894 / 65028 / 1638 | ✅ | 4/4 |

Aggregate: join = exactly-one-type-15 **21/21** (0 orphan, 0 multi); C1 (candidates
== visible+thoughts) **21/21**; C2 (cached > prompt) **18/18**; reconciliation **4/4**.

Reader: `proto-scan.ts` recovered verbatim from gateway `f0d4f53^` (`scanProto` →
`FieldTree`; `pNum`/`pStr`/`getPath` dotted accessors). `bun:sqlite` cannot open a
live WAL DB — the gateway captures via its snapshot machinery; offline decode opens
a copy `{readwrite:true}`.
