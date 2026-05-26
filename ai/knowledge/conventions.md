# Conventions

- Use `proxai-ops` orchestration commands instead of raw docker/curl.
- Never assume/change DB schema fields or DTO definitions without explicit user confirmation.
- Validate large multi-message tasks by deploying a validation agent that audits every demand against current code before claiming success.
