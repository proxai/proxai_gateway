# TypeScript rules

- Use `unknown` + type guards (`typeof`, `in`, `Array.isArray`, zod) for unknown boundary shapes.
- For bridging two compatible types TS can't infer, use a single `as unknown as TargetType` cast with a comment explaining why.
- For JSON flowing to Prisma writes, use `Prisma.InputJsonValue`; for reads use `Prisma.JsonValue`.
- For Express uploads, type as `Express.Multer.File`.
- For test mocks, use `vi.fn() as unknown as TheRealSignature` or `MockedFunction<typeof fn>`.
- Delete object properties via `delete (obj as { prop?: unknown }).prop`.
