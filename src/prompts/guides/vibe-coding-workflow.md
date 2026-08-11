# Guide: Vibe Coding Done Right (AI-First Workflow)

Vibe coding = directing an AI agent to build in natural language at high speed. Done sloppy it produces unverifiable code and infinite loops; done right it's the fastest way to ship. This guide is the "done right" version.

## The workflow (never skip a gate)

1. **BRIEF** — one paragraph: what, who it's for, what success looks like. Write it before opening the editor.
2. **SPEC** — for anything non-trivial, a half-page spec (see spec-driven-development guide): goal, scope in/out, contracts, acceptance criteria.
3. **STACK-CONSCIOUS** — tell the agent the stack and conventions up front (framework, language, package manager, lint rules, existing patterns). Agents that guess stacks create messes.
4. **SMALL LOOPS** — one feature per request. "Add X" → agent edits → **you verify** (or the agent runs checks) → next. Never batch 10 changes into one prompt and walk away.
5. **VERIFY AT EACH GATE** — typecheck, lint, tests, or a manual check. No verification = the loop is broken. If the agent can't verify, it must say so.
6. **COMMIT OFTEN** — every green gate = a commit. Trunk-based; you can always revert to a known-good point.

## The 5 rules that prevent death spirals

1. **Never let it loop on the same error 3×.** After 3 failed attempts at one thing, stop and change approach: read the actual error, check docs, or ask a human. Looping wastes more time than thinking.
2. **Environment fixes are real fixes.** "Just rerun" is not a fix. If deps, env vars, or the dev server are broken, fix the root cause (missing .env, stale lockfile, port conflict) — see rebuild/restart tool guidance.
3. **Read before you write.** The agent should read the file/API before editing it. Stale assumptions cause most failed edits.
4. **Prefer additive changes.** New code paths over rewrites. Preserve working behavior; upgrade under the hood.
5. **The agent reports, you decide.** For architecture, scope, or anything destructive, the agent proposes options and you pick. Never let it silently change contracts or delete things.

## Signals the workflow is off the rails

- The agent asks to "rebuild" repeatedly for the same cause → stop, find the actual blocker.
- Errors repeat verbatim → the fix isn't landing; read the real error, check the file state.
- You can't tell what changed → demand a diff summary at every gate.

## Output discipline

End each loop with: **what changed (file list), how it was verified, what's next**. If the agent can't produce that, the loop isn't complete.
