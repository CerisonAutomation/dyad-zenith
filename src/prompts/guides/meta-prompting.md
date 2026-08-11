# Guide: Meta-Prompting

Use when a task is complex, ill-specified, or needs to be decomposed — instead of answering directly, **ask the model to generate the best prompt/spec first, then execute it**. Meta-prompting treats the LLM as both prompt-generator and executor: it deconstructs a hard problem into sub-tasks with structured instructions, then orchestrates solving them.

## Why it's game-changing

- Research (DARPA's MetaGPT paper, PICCO, 2025-26 survey) shows meta-prompting beats direct prompting on reasoning-heavy tasks — the model first reasons about *how* to solve, then solves.
- It emphasizes **structure and syntax over content**: decompose → generate expert sub-prompts → dispatch → synthesize.
- It self-adapts: prompts are rewritten for the specific task, context, and constraints — no more generic one-size-fits-all.

## The loop

1. **Decompose** — "Break this task into 2-5 sub-tasks. For each, state the goal, inputs, outputs, and how to verify success."
2. **Generate expert prompts** — "For sub-task X, write a self-contained prompt that a specialist model could execute without additional context. Include: role, context, steps, constraints, output format, acceptance criteria."
3. **Execute** — run each generated prompt (sequentially or in parallel).
4. **Synthesize** — merge results, resolve conflicts, and verify against the original goal.
5. **Refine** — if output misses, rewrite the sub-prompt with the failure feedback and re-run (only that branch, not everything).

## Concrete meta-prompt

```
You are a meta-prompting engine. Given the task below:
1. Restate the goal precisely.
2. Split it into independent sub-tasks; note dependencies.
3. For each sub-task, produce an executable prompt (role, context, steps,
   constraints, output format, acceptance criteria).
4. Execute each sub-prompt and return its results labeled by sub-task.
5. Synthesize into the final answer with a verification checklist.

Task: <the actual task>
```

## Rules

- Meta-prompt ONCE per task, not per turn (avoid prompt-generation overhead).
- Generated sub-prompts must be self-contained (the executor has no other context).
- Verify each sub-task's acceptance criteria before synthesis.
- If a sub-task fails, regenerate ONLY that sub-prompt with feedback — don't redo the whole decomposition.

## Anti-patterns

- Meta-prompting trivial tasks (overhead without benefit).
- Letting generated prompts drift from the original goal — re-anchor with the goal statement.
- Skipping the verification step (the whole point is checkable sub-tasks).
