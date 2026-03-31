---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.mts"
  - "**/*.cts"
---

Use strict TypeScript. Prefer `satisfies` over `as` for type narrowing. Use `unknown` over `any`. Prefer discriminated unions over optional fields for state modeling. Use `const` assertions for literal types.
