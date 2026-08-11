# Consolidation Decisions

## What "Zenith" means now

Zenith is deliberately a **policy**, not another service or agent.

```text
User
  -> Dyad Agent
      -> Zenith Auto model routing
          -> configured model provider
      -> Dyad native tools
      -> optional deterministic Repo-Intel evidence
      -> curated MCP integrations
```

This avoids agent-vs-agent arbitration, duplicate memories, duplicate file editors, multiple shell executors, contradictory repair loops and model-visible meta-reasoning noise.

## Default

- Agent: Dyad local-agent
- Default chat mode: local-agent
- Model: auto/auto (Zenith Auto)
- Free-first candidate: Kilo kilo-auto/free when configured
- Recovery: auto/free

Kilo remains useful as a provider route and external developer client; it does not replace Dyad's runtime agent.

## Why 50 tools remain

The removed tools were predominantly meta-orchestration. The retained surface is concrete: source inspection/editing, Git, dependencies, SQL, type/test/build execution, logs, browser/E2E, integrations, plans/blueprints, architecture/review/debug evidence and explicit MCP discovery. Further tool-count reduction should be driven by measured selection conflicts, not arbitrary compression.
