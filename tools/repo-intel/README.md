# Dyad Repo Intel

A small deterministic CLI/MCP companion built into the Dyad source tree. It has no model, no autonomous repair loop, no separate package manager, and no duplicate read/edit/bash tool framework.

```bash
bun run repo:intel -- summary .
bun run repo:intel -- scan .
bun run repo:intel -- graph .
bun run repo:intel -- search "pattern" .
bun run repo:intel:verify
bun run repo:intel:mcp
```

`repo_verify` is fail-closed. It only returns `VERIFIED` after the mandatory Dyad release gates execute successfully. Set `REPO_INTEL_ALLOW_EXEC=1` to permit execution.
