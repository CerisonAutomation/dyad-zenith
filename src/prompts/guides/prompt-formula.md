# Guide: The Prompt Formula (context → role → task → constraints → examples → output → verify)

Use for any request where the model's first answer matters — coding tasks, analysis, writing, debugging. A complete prompt is not a paragraph; it's a structured brief. This is the RICE-family pattern (Role, Instructions, Constraints, Examples) extended with context and verification.

## The 7 blocks

1. **CONTEXT** — what the model needs to know to answer well. Project, stack, file paths, prior decisions, what's already been tried. *The most skipped and most valuable block.*
2. **ROLE** — who the model is being: "senior backend engineer", "security reviewer", "SQL expert". Sets expertise and tone.
3. **TASK** — the single verb-led instruction: "Refactor X to Y", "Find the bug in Z", "Write tests for A". One task per prompt when possible.
4. **CONSTRAINTS** — hard rules: "TypeScript strict, no new deps, keep the public API, don't touch tests", "max 30 lines", "must work on Node 24". If it's non-negotiable, say it explicitly.
5. **EXAMPLES** — one input→output example beats ten paragraphs. Give the expected shape: a before/after, a sample row, a sample error.
6. **OUTPUT FORMAT** — exact shape: "return a table with columns X,Y,Z", "a markdown report with sections A,B", "only the diff". Structured output is machine-checkable.
7. **VERIFY** — how to know it worked: "run tsc, run the test suite, curl the endpoint, check the bundle size".

## Template

```
CONTEXT: <what, where, stack, what's already tried>
ROLE: <who you are being>
TASK: <one verb-led instruction>
CONSTRAINTS: <hard rules, comma-separated>
EXAMPLES: <1-2 input→output pairs>
OUTPUT: <exact shape of the answer>
VERIFY: <how success is checked>
```

## Rules

- Fill all 7 blocks for important requests; for quick ones, at least context + task + constraints.
- Constraints beat adjectives ("high quality" is noise; "must pass tsc --strict and have tests" is signal).
- If the model asks a clarifying question, answer it — that's the context block fighting to be complete.
- When a prompt fails, add the missing block rather than rewording the whole thing.

## Anti-patterns

- Prompt = one sentence ("make it good") — no context, no constraints, no verification.
- Ambiguous success: no VERIFY block means any output passes.
- Copy-pasting constraints that don't apply (they dilute the real ones).
