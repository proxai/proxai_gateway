[← Back to 2.1 Sources](../2.1-sources.md) · [Top Index](../../README.md)

# 2.1 Sources — per-source deep-dives

*Last Updated: 2026-05-27*

This folder is the per-source companion to [2.1 Sources](../2.1-sources.md). The parent doc is the comparison overview: what a "source" is, the `(sourceApp, sourceKind, bodyFormat, watermarkKind)` taxonomy, and the cross-source quirks. Each file in here picks one agent and answers four questions about it:

1. Where does its data live on disk and what does the gateway discover?
2. What does the on-the-wire body look like, record by record, after the gateway's per-source filter and trim?
3. What does the gateway deliberately **capture**, and what does it deliberately **skip**? With reasons.
4. What does the receiver parser do with each record type?

Read the parent first; come here when you need the source's full record surface, the skipped namespaces, or the version-detection mechanics.

## Sources

| Source | Doc | Body shape | Default capture | Sub-agent escape hatch |
| --- | --- | --- | --- | --- |
| Claude Code | [claude-code.md](./claude-code.md) | `jsonl` lines per session, plus per-session sub-agent files | Parent transcripts only; each line is parsed and only genuine `user`/`assistant` dialogue text is kept | `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CLAUDE_CODE` adds the sub-agent glob back. |
| Codex | [codex.md](./codex.md) | `jsonl` rollouts + two allow-listed sqlite tables (`threads`, `thread_spawn_edges`) | Parent rollouts only (child rollouts filtered via `thread_spawn_edges` pre-fetch), filtered to `session_meta` + turn-control `event_msg` + message `response_item` records | `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CODEX` disables the child-rollout filter. |
| Cursor | [cursor.md](./cursor.md) | sqlite KV snapshot, three allow-listed prefixes | `composerData:` + `bubbleId:` + `agentKv:blob:` (user/assistant blobs); row values trimmed per prefix | `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CURSOR` is wired but has no effect — Cursor's row selection does not branch on it. |
| Claude Desktop | [claude-desktop.md](./claude-desktop.md) | `jsonl` audit lines, enriched from the matching CLI transcript | Authoritative `audit.jsonl`, filtered to genuine `user`/`assistant` dialogue (shared `isDialogueRecord`, plus `isReplay` dropped); each kept record is reshaped — CLI metadata merged, audit keys renamed, `source_platform` injected | `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CLAUDE_DESKTOP` is wired but has no effect — discovery does not branch on it. |
| Gemini (Antigravity) | [gemini.md](./gemini.md) | three allow-listed sqlite tables (`trajectory_meta`, `steps`, `trajectory_metadata_blob`) from `*.db` Cascade trajectory DBs | Both roots (CLI + IDE, one source, discriminated by `source_platform`); each `steps` row's protobuf `step_payload` is **decoded to plaintext before redaction** | n/a — sub-agent (`invoke_subagent`) work lives in separate `.db` conversations, captured in their own right. |

`PROXAI_GATEWAY_CAPTURE_SUB_AGENTS` is the global override; if truthy, all four per-source flags resolve to true. Defaults are all `false`. See [6.4 Maintainer Debug Flags](../../06-operations/6.4-maintainer-debug-flags.md).

## What "capture decisions" means

The gateway does not forward source files byte-for-byte. Every record is parsed, and a per-source filter keeps only genuine dialogue content while a per-source trim strips oversized or non-dialogue fields from the records that are kept. On top of that, every source has whole namespaces on disk that the gateway never reads at all. Reasons for skipping fall into three buckets:

- **Out of scope** — not transcript content (e.g., file-edit overlay state, UI-only checkpoint payloads, app event logs, tool-call and tool-result records).
- **Redundant** — the same content already arrives via a captured surface in a different shape (e.g., Codex's `event_msg` conversation channel duplicates the `response_item` message records that the rollout filter keeps).
- **Operational** — the namespace exists but is not used by the user on the inspected installations (e.g., Codex `agent_jobs`).

Each per-source doc spells out which bucket each skipped namespace falls into, what the kept records are filtered and trimmed down to, and what would change if a decision were revisited.

## Conventions inside this folder

- Each file links back to [2.1 Sources](../2.1-sources.md) at the top and bottom; it does not sit in the linear `1.x → 7.x` reading chain.
- Concrete identifiers (glob strings, table names, key prefixes, byte caps) are cited from the gateway's `*.constants.ts`. The constants are the source of truth — if a number here disagrees with the constant, the constant wins.
- Captured-vs-skipped tables are summary projections of code, not the code itself. The collect functions in `src/sources/<app>/collect*.ts` are authoritative.

[← Back to 2.1 Sources](../2.1-sources.md) · [Top Index](../../README.md)
