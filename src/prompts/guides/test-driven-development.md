# Guide: Test-Driven Development (TDD)

Write the failing test first, watch it fail for the right reason, then implement the minimum to make it pass. This produces testable designs and catches regressions the moment they appear.

## The cycle (red → green → refactor)

1. **RED** — write one failing test that pins the desired behavior (including the edge case you care about). Run it: it must fail for the expected reason (not a compile error, not an unrelated failure).
2. **GREEN** — write the minimum implementation to make it pass. No extra features, no premature abstraction.
3. **REFACTOR** — clean up the code you just wrote, keeping tests green. Remove duplication, name things well, tighten types.

## What to test first

- The acceptance criteria of the feature (behavior, not internals).
- One edge case per test — a test should fail for exactly one reason.
- Boundaries: empty input, max length, first/last page, expired tokens, missing records, concurrent writes.

## What NOT to test

- Implementation details (private functions, exact SQL strings, internal state) — they make refactoring painful.
- Code you don't own (libraries, the framework).
- Tests that duplicate the implementation line-for-line (they only pass because they mirror the bug).

## Guidelines

- Name tests by behavior: `should reject booking when date is in the past`, not `testBooking1`.
- If a bug is found, write the failing test for the bug FIRST, then fix. That test stays as the regression guard.
- Keep tests fast and deterministic: no network, no wall-clock time, no shared mutable state.
- When the schema or contract changes, update the tests in the same commit — never leave the suite red.

## Definition of done

- `run tests` → all green.
- Coverage on the new behavior, including its edge cases.
- The test suite was green BEFORE the change and green AFTER (no pre-existing breakage hidden by the change).
