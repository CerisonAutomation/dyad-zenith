# Guide: Spec-Driven Development (SDD)

Use this workflow when implementing any non-trivial feature. Specifications become the source of truth; the code is written to satisfy them — not the other way around.

## Why

- Specs act as "super-prompts": they break complex problems into modular components that fit the agent's context window.
- A good spec constrains what the AI generates, so the result is traceable, audit-ready, and matches intent instead of drifting.
- Spec-by-example (BDD style) turns documentation into executable contracts.

## 1. Write the spec first (goal-oriented)

Focus on **what** and **why**, not the nitty-gritty **how** (at least initially):

- **Problem**: one paragraph — what user pain does this solve?
- **Scope**: explicitly list what is IN and what is OUT.
- **Interfaces / contracts**: function signatures, API routes, data shapes, DB schema — the parts other code depends on.
- **Behavior by example**: given/when/then scenarios covering the happy path AND edge cases.
- **Acceptance criteria**: checkboxes that can be verified objectively.
- **Open questions**: anything unresolved, listed for the user to confirm before coding.

## 2. Validate the spec before coding

- Re-read the spec and check it against the existing codebase (does it conflict with current behavior? does it reuse existing patterns?).
- Confirm the spec with the user if anything is ambiguous. It is cheaper to fix the spec than the implementation.
- Split large specs into phases; each phase must be independently shippable.

## 3. Implement against the spec

- One contract at a time. After each, re-check the spec: does the implementation still satisfy it?
- Never change behavior that the spec pins down without updating the spec first (and saying so).
- Keep the spec file updated in the repo next to the code (e.g. `specs/<feature>.md`).

## 4. Verify against the spec (non-negotiable)

- Run every acceptance criterion as a check, not a vibes-based review.
- Run the type checker, linter, and tests. If a criterion has no automated check, exercise it manually and record the result.
- For each edge-case scenario in the spec, confirm the code handles it.

## 5. Ship only what the spec covers

- No scope creep: features not in the spec are parked, not silently added.
- If the implementation revealed a spec bug, fix the spec, note the change, and re-verify.

## Anti-patterns

- Writing code before the spec exists ("vibe coding" large features).
- Writing specs that are all HOW (implementation details) and no WHY — they go stale instantly.
- Treating the spec as documentation to be written after the fact.
- Skipping acceptance-criteria verification because "the tests pass".
