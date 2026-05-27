# Diagram Engineering, Agentic Review Loops, & Document Validation

This guide documents the technical design rationale behind our documentation quality pipeline, detailing the layout engine specifics, the multi-agent orchestration pattern, and the validation script architecture.

---

## 1. Flowchart Geometry & Dagre Layout Engine Mechanics

Mermaid’s flowchart renderer uses the **Dagre layout engine** to compute node positioning and edge routing under the hood. Understanding its mechanics is essential for generating clean diagrams.

### A. The Subgraph Distance Problem
When `subgraph ... end` blocks are declared, Dagre treats each subgraph as an isolated bounding container. 
- **Layout Spacing**: The engine enforces rigid margins and padding around the container border.
- **Visual Displacement**: Nodes in separate subgraphs, even if closely related or connected, are forced into distinct spatial rows or columns. In vertical Top-Down (`flowchart TD`) diagrams, this introduces massive empty vertical gaps and pushes logically adjacent nodes far apart.
- **The Solution**: Avoid subgraphs entirely in complex cheatsheets. Declaring a flat, unified graph allows Dagre to group connected nodes directly adjacent to one another, achieving an extremely dense, readable, and compact layout.

### B. Element Sizing & Uniformity
Mermaid lacks a native `min-width` or `min-height` property for diagram nodes. By default, node size scales dynamically to fit the length of the label text.
- **Visual Inconsistency**: A short label (e.g., `Start`) produces a tiny node, while a nearby process block produces a massive node, creating visual fatigue and inconsistent alignment.
- **Padding-Based Sizing**: Standardizing node sizing is achieved by declaring native CSS `padding` variables directly inside our custom `classDef` definitions (e.g., `padding:10px 25px;`). This forces all nodes in a semantic category to expand to a balanced visual size, while naturally scaling to accommodate longer strings when necessary.

---

## 2. Multi-Agent Correction & Review Loops

To eliminate blunders, layout overlaps, and design issues, we utilize a specialized **Correction-and-Review loop** using parallel autonomous subagents.

### A. The Subagent Roles
Instead of forcing a single model to redesign and review the entire documentation suite, the workload is distributed into highly focused, single-purpose personas:
- **`DiagramArtist` (The Builder)**: Spawns to focus on a single diagram file. It refactors the layout, flattens subgraphs, implements classDef padding, and shortens transitions.
- **`AuditReviewer` (The Auditor)**: Spawns independently to review the `DiagramArtist`'s output. It audits files against strict guidelines, ensures code correctness, and runs the verification suite.

### B. The Maturity Loop
1. **Parallel Execution**: One `DiagramArtist` is spawned per diagram, preventing context contamination.
2. **Strict Verification**: Once the builder finishes, an independent `AuditReviewer` audits the generated file against the checklist.
3. **Iterative Refinement**: If any issues are found (overlapping nodes, missing styles, syntax errors), the reviewer sends feedback to the builder to repeat the work until it is verified.

---

## 3. Robustness Testing with `validate-docs.ts`

To guarantee that documentation never breaks the build or visual presentation, we use the custom verification suite [validate-docs.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_gateway/scripts/tests/validate-docs.ts).

### A. Key Validation Audits
The validator runs a series of strict regex and balance checks:
- **Timestamp Validation**: Verifies that every non-architecture document contains a valid `Last Updated` timestamp right beneath its H1 header.
- **Relative Link Resolution**: Validates that all relative markdown links (`[text](./path.md#anchor)`) exist and resolve to valid files.
- **Anchor Existence**: Parses target markdown files and verifies that target header anchors actually exist in the referenced document.
- **Mermaid Syntax Parsing Guard**: Scans all ` ```mermaid ` code blocks for unclosed fences, nested code tags, mismatched braces in init blocks, unclosed double quotes, and mismatched shape brackets.

### B. State Diagram Special Handling
In Mermaid `stateDiagram-v2` syntax, opening and closing braces (`{` and `}`) are used over multiple lines to declare nested/composite state scopes. 
- **The Issue**: Line-by-line shape matching would mistake these block declarations for unbalanced flowchart "diamond shape" brackets.
- **The Solution**: The validator reads the diagram type. If it starts with `stateDiagram` or `stateDiagram-v2`, it automatically bypasses the flowchart-specific custom shape bracket checks, preventing false-positive test failures.
