---
name: "TypeScript Safety and Casting"
description: "TypeScript rules for unknown boundary shapes, compatible type bridging, Prisma JSON fields, and test mocks."
activation: "contextual"
scenarios: ["Typing inputs from dynamic boundaries like HTTP payloads", "Writing double-assertions or using Prisma.InputJsonValue", "Mocking function calls in unit and integration tests"]
globs: ["src/**/*.ts", "**/*.ts"]
---

# TypeScript rules


- Use `unknown` + type guards (`typeof`, `in`, `Array.isArray`, zod) for unknown boundary shapes.
- For bridging two compatible types TS can't infer, use a single `as unknown as TargetType` cast with a comment explaining why.
- For JSON flowing to Prisma writes, use `Prisma.InputJsonValue`; for reads use `Prisma.JsonValue`.
- For Express uploads, type as `Express.Multer.File`.
- For test mocks, use `vi.fn() as unknown as TheRealSignature` or `MockedFunction<typeof fn>`.
- Delete object properties via `delete (obj as { prop?: unknown }).prop`.
