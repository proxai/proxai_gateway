# Rebuild & Verification Instructions

This document provides instructions on how to use the scripts in this folder to investigate database stats, check step rows, and verify token usage.

## 🏃‍♂️ How to Run the Scripts

All scripts in this folder are written in TypeScript and can be run using `bun`:

### 1. `calculate_true_averages.ts`

Computes prompt averages, medians, and cache efficiency metrics.

```bash
bun run scripts/Gemini\ stats/calculate_true_averages.ts
```

### 2. `investigate.ts`

Runs queries against the database to fetch stats for specific users or time periods.

```bash
bun run scripts/Gemini\ stats/investigate.ts
```

### 3. `query_steps.ts`

Queries raw step rows from the database to check what token fields are present and how they look.

```bash
bun run scripts/Gemini\ stats/query_steps.ts
```

### 4. `raw_proto.ts`

Parses proto fields or raw sqlite rows if needed.

```bash
bun run scripts/Gemini\ stats/raw_proto.ts
```

---

## 🔍 Verification Checklist

Before running any script on production, make sure to verify the following on local development:

- **Env Variables:** Ensure your local `.env` has a valid database URL and connection configuration.
- **Dry Runs:** Run scripts with test parameters (like a specific time-range or specific test user email) to verify that database calls complete without throwing exceptions.
- **No Schema Actions:** These scripts should only run `SELECT` queries (read-only) and must never execute `UPDATE` or `DELETE` statements on the raw tables unless explicitly guided by a migration script.
