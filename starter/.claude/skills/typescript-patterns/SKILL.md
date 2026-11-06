---
name: typescript-patterns
description: Use when reviewing TypeScript (.ts, .tsx, .mts, .cts) for type safety, unsafe casts, async error handling, and idiomatic TypeScript patterns.
---

# TypeScript Patterns Review

Review the changed TypeScript at the pinned head. Report only issues backed by an exact line.

## Type Safety
- `any`, implicit `any`, and `as` casts that bypass validation, especially on database rows,
  `JSON.parse` output, and external input. Prefer `unknown` plus runtime validation (schema or type guard).
- Non-null assertions such as `user!.name` hiding real `null`/`undefined` cases.
- Index access without bounds checks (`rows[0]` when `rows` can be empty).
- Wide `string` parameters where a union or branded type prevents invalid states (status flags, IDs, tiers).
- Return types that lie: `Promise<T>` resolving to unchecked data cast with `as T`.

## Async and Errors
- Floating promises, missing `await`, and `catch` blocks that swallow errors or log sensitive data.
- Boolean return values hiding failure causes in critical flows (payments, auth); prefer typed results or errors.
- Partial-failure ordering: side effects committed before validation or without a transaction.

## Data Handling
- Money computed with floating point; use integer minor units or a decimal library.
- Dates parsed with `parseInt` without radix or validation; time-zone sensitive comparisons.
- String-built SQL or template literals reaching a query sink: always flag and apply the security-analysis skill.

## Idiomatic Patterns
- `readonly` and `as const` for constant tables, `satisfies` for typed configuration.
- Discriminated unions instead of loosely related optional fields.
- Exhaustive `switch` with a `never` check for union inputs.
- Keep pure helpers exported or injectable when they need tests (pricing, validation).

## Severity Guide
- critical: exploitable injection or authorization bypass reachable from input.
- high: data corruption, payment or security logic errors, unsafe casts on external data in critical paths.
- medium: unchecked casts, swallowed errors, floating-point money outside payment authorization.
- low/info: idiomatic improvements without behavior risk.

## Output
For each finding give the line, severity, category (security, bug-risk, maintainability,
best-practice, performance or style), why it matters, and a concrete TypeScript fix.
This skill is guidance only: after applying it, continue your remaining steps and return findings
in the exact output format required by your agent instructions (for example a JSON array).
