# Root Cause: Gemini Token Discrepancy & Context Bloat

This document analyzes the root cause of the massive discrepancy in input token counts between Claude Code (~3M input tokens) and Gemini / Antigravity CLI (~74M input tokens) for the same user.

## 🔍 The Symptom

During prompt statistics analysis, the user observed that:

- Claude Code used **3.7 million net input tokens** across ~1,200 prompts.
- Gemini / Antigravity CLI used **74 million net input tokens** across only ~600 prompts.
- The median prompt size for Gemini was disproportionately high, indicating that massive context was being sent on every turn.

---

## 💡 The Root Cause: Missing Rules Triggers in Antigravity

The difference was caused by how the `ai/mapper` distributed workspace-specific rules to the active CLI tools.

### 1. Claude Code (.claude/rules/)

Claude Code uses a native paths-scoping mechanism. The mapper correctly generated rules with YAML frontmatter containing file path patterns:

```yaml
---
paths:
  - 'src/**/*.ts'
---
```

Claude Code only loaded a rule file into its active context when the developer was working on a matching file path. Rules unrelated to the active file were kept out of the context window.

### 2. Cursor (.cursor/rules/)

Cursor uses `.mdc` rule files with `alwaysApply: false` and `globs: "..."` settings, meaning Cursor only auto-attached rules when relevant to the active files.

### 3. Antigravity CLI (.agents/rules/)

Antigravity CLI (the Gemini-based agent host) auto-loads rule files from the `.agents/rules/` directory at startup.
It supports trigger configurations in its YAML frontmatter:

- `trigger: glob` / `globs: [...]` (loads only on matching files)
- `trigger: always_on` (loads unconditionally)
- `trigger: model_decision` (loads dynamically based on description)

However, the mapper previously emitted rules for Antigravity **without any YAML frontmatter** (writing only the raw Markdown body).

**The consequence:**

- Without trigger headers, Antigravity CLI had to treat all **52+ rule files** in the project as active (`always_on`).
- It loaded the contents of all 52+ rules (tens of thousands of tokens) into the prompt context **on every single interaction**.
- In a long chat session, this rule payload accumulated with the conversation history, causing a massive token bloat that ballooned the input token usage to **74 million tokens**.

---

## 🛠️ The Fix

We updated the rules mapper (`ai/mapper/emitters/rules.ts`) across all ProxAI repositories to write proper trigger frontmatter for Antigravity rules:

- **Contextual rules:**
  ```yaml
  ---
  trigger: glob
  globs:
    - 'src/**/*.ts'
  description: 'Rule description...'
  ---
  ```
- **Global rules:**
  ```yaml
  ---
  trigger: always_on
  description: 'Rule description...'
  ---
  ```
- **Lazy-load rules:**
  ```yaml
  ---
  trigger: model_decision
  description: 'Rule description...'
  ---
  ```

This aligns Antigravity's rule loading behavior with Claude Code and Cursor, ensuring that only relevant rules enter the active prompt context, preventing the 74M token bloat.
