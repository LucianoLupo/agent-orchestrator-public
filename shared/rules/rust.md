---
paths:
  - "**/*.rs"
  - "**/Cargo.toml"
---

Prefer borrowing over cloning. Use `thiserror` for library errors, `anyhow` for applications. Prefer `impl Trait` over `dyn Trait` when possible. Use `#[must_use]` on functions returning values that should not be ignored.
