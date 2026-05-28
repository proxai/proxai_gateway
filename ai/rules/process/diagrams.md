---
name: "Mermaid Diagrams Syntax and Styling"
description: "Mermaid rendering guidelines, styling headers, node sizing rules, and class assignments for clean Markdown documentation."
activation: "global"
scenarios: ["Creating or editing system architecture diagrams", "Updating flowcharts or cheatsheets in the codebase documentation", "Applying CSS class definitions and themes to documentation visuals"]
---

# Rules for Mermaid Diagrams & Markdown Documentation


These rules are mandatory for all AI-generated or developer-updated architecture diagrams, cheatsheets, and markdown documentation within the repository.

## 1. Syntax & Rendering Constraints
- **Double-Quote Arrow Labels**: Any arrow label containing parentheses `()`, braces `{}`, or brackets `[]` **must** be wrapped in double quotes (e.g. `-->|"Yes (within 4 h)"|` instead of `-->|Yes (within 4 h)|`). Unquoted special characters cause lexer token collisions and crash the Mermaid parser.
- **Top-Down Flowchart Type**: All high-level system diagrams and cheatsheets **must** use `flowchart TD` (or `flowchart vertical`) to guarantee clean, readable vertical layouts. Do not use horizontal layouts (`flowchart LR`) for complex, multi-layered operations.
- **Flat Single-Graph Structures**: Do not use `subgraph ... end` blocks for complex systems. Subgraphs force the Dagre layout engine to segregate nodes into rigid bounding boxes, creating massive vertical gaps and separating connected nodes. Group all flows under a single, flat chart.
- **Short Connection Arrows**: Keep transition lines tight by using standard short arrows (`-->`) instead of extended arrows (`--->` or `---->`) to prevent unnecessary node distancing.

## 2. One-Liner Styling Block
- **Minified Init Header**: Every Mermaid block **must** begin with a flat, minified JSON configuration block on a single line at the very top of the diagram body:
  ```mermaid
  %%{init: {"theme": "dark", "themeVariables": {"primaryColor": "#0a201b", "primaryTextColor": "#ccfbf1", "primaryBorderColor": "#14b8a6", "lineColor": "#14b8a6", "fontFamily": "Inter, sans-serif"}, "flowchart": {"nodeSpacing": 35, "rankSpacing": 40}}}%%
  ```
- **Spacing Parameters**: The flowchart initialization **must** contain `"flowchart": {"nodeSpacing": 35, "rankSpacing": 40}` to enforce compact node clustering.

## 3. Uniform Sizing and Padding Rules
- **Explicit ClassDef Styling**: Standardize node sizing across all semantic categories using explicit, native class definitions declaring precise `padding` variables:
  - `classDef startNode fill:#0a201b,stroke:#10b981,stroke-width:2px,color:#b3f5e6,padding:10px 25px;` (Entry, Exit, or Success)
  - `classDef stopNode fill:#241212,stroke:#ef4444,stroke-width:2px,color:#fca5a5,padding:10px 25px;` (Errors, Halts, or Skips)
  - `classDef decNode fill:#241c0e,stroke:#f59e0b,stroke-width:2px,color:#fde68a,padding:10px 20px;` (Decisions and Conditions)
  - `classDef processNode fill:#0d1b2d,stroke:#3b82f6,stroke-width:2px,color:#bfdbfe,padding:10px 20px;` (Core Operations)
  - `classDef actionNode fill:#1e112c,stroke:#a855f7,stroke-width:2px,color:#e9d5ff,padding:10px 20px;` (State Changes, DB Writes, and Commands)
  - `classDef default fill:#0a201b,stroke:#14b8a6,stroke-width:2px,color:#ccfbf1,padding:10px 20px;` (Fallback and Relational Tables)
- **Individual Class Assignment**: Assign styling to each node individually at the bottom of the diagram using the single-statement syntax:
  ```mermaid
  class NodeName classType;
  ```
  Do not use batch class assignment statements, as they are not parsed reliably across all Markdown engines.
