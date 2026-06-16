# claude-code File Format

Claude Code writes one JSONL file per session under
`~/.claude/projects/<project-slug>/<session-id>.jsonl`. Each line is a complete
JSON object representing one event in the session: a user turn, an assistant
turn, a tool call, a tool result, or a meta marker.

## Line types observed

The parser only keeps lines where `type ∈ {user, assistant}` and content has a
non-empty text part. Common other types it sees but drops:

| `type`            | Purpose                                           | Parser behavior |
| ----------------- | ------------------------------------------------- | --------------- |
| `user`            | User message turn                                 | Kept if real text |
| `assistant`       | Model response turn                               | Kept if real text |
| (anything else)   | Session meta / tool plumbing / summary records    | Dropped         |

## Required text-lookup order

Claude has rewritten the schema multiple times; the parser tolerates all variants
by looking up content in this priority:

1. `parsed.message.content`
2. `parsed.content`
3. `parsed.message.text`
4. `parsed.text`

The first non-null hit wins. If none, the line is dropped.

## Content shape variants

`actualContent` can be:

- A plain string.
- A single object: `{ type: 'text', text: string, ... }` or
  `{ type: 'tool_use', ... }` or `{ type: 'tool_result', ... }`.
- An array of those objects.

The parser's "has text" check walks every shape:

```ts
// Array variant
content.some(item =>
  item?.type === 'text' &&
  typeof item.text === 'string' &&
  item.text.trim().length > 0
);
// Object variant
content.type === 'text' &&
  typeof content.text === 'string' &&
  content.text.trim().length > 0;
// String variant
typeof content === 'string' && content.trim().length > 0;
```

## Drop rules (collect.ts:142)

A line is dropped (returns `false` from `isDialogueRecord`) when any of:

- `parsed.isMeta === true` — session meta marker (project root, branch, etc.).
- No usable content per the lookup above.
- For `user` lines:
  - First text starts (after `trimStart`) with one of the synthetic prefixes:
    `<bash-input>`, `<bash-stdout>`, `<bash-stderr>`,
    `<local-command-stdout>`, `<local-command-stderr>`,
    `<command-name>`, `<command-message>`, `<command-args>`,
    `<system-reminder>`, `<local-command-caveat>`.
  - Or content contains a `tool_result` item — that's a tool response, not a
    user turn.
- For `assistant` lines:
  - `parsed.message.model === '<synthetic>'` — system-injected reminder, not a
    real model reply.
  - `parsed.isApiErrorMessage === true` — error placeholder.
  - Content contains a `tool_use` item — that's a tool call, not a textual reply.

The two extremes (`<system-reminder>` on user side, `<synthetic>` model on
assistant side) cover the IDE-injected scaffolding that Claude Code surfaces in
the JSONL but that should never be billed as dialogue.

## Version field

Found at either `parsed.version` (top-level) or `parsed.message.version`
(nested). Schema is not pinned; the parser scans every kept line until it finds
one. Falls back to the literal `'unknown'`.

## Encoding and line discipline

- UTF-8.
- Each record ends in `\n`. The parser splits on `\n` and treats trailing
  partial lines (no terminating newline) as not-yet-complete — `readJsonlRange`
  caps the slice at the last complete newline, so a partial trailing record is
  held until the next poll.
- Per-line JSON.parse failures are silently ignored (the line is dropped, the
  byte offset still advances).

## Subagent files

When the sub-agent flag is on, Claude Code's subagent transcripts live in
`*/<session>/subagents/<agent-id>.jsonl`. Format is the same JSONL; the parser
applies identical filtering. Off by default.

## On-disk path identity

The full path `~/.claude/projects/<project>/<session>.jsonl` is hashed
(sha256) as `sourcePathHash`. Sessions are never renamed mid-life, so path-hash
is stable. Inode is captured as a fallback cursor key in case a future tooling
change rewrites the file in place.

[source: src/sources/claude-code/collect.ts:83-203; src/sources/claude-code/collect.ts:421-446; src/sources/claude-code/claude-code.constants.ts:8-12]
