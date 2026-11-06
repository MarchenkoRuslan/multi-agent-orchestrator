---
name: test-analysis
description: Use when estimating static test coverage, identifying untested branches, or recommending assertions and regression tests.
---

# Test Completeness

Map each changed behavior to existing test setup, execution, and assertions.
Check boundaries, empty and invalid inputs, asynchronous rejection, retries, cancellation, concurrency,
authorization denials, and state transitions. Presence of a test file alone is not coverage.
Suggest concrete test cases with inputs and expected outcomes; include assertions on outputs and side effects.
Prioritize data integrity, payment, authentication and user-visible regressions.
Clearly label percentages as static estimates and explain the evidence and limitations.
Do not execute untrusted tests or claim measured branch coverage without a genuine coverage artifact.

This skill is guidance only: after applying it, continue your remaining steps and return findings
in the exact output format required by your agent instructions (for example a JSON array).