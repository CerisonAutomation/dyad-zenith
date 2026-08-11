# Dyad Zenith — Canonical Architecture

Dyad Zenith deliberately has **one user-facing agent**.

## Runtime contract

- **Agent:** Dyad `local-agent`
- **Default model policy:** `Zenith Auto` (`auto/auto`)
- **Primary free route:** Kilo `kilo-auto/free` when a Kilo key is configured
- **Other configured routes:** OpenRouter, Google, OpenAI, Anthropic
- **Recovery policy:** `auto/free`
- **Tool plane:** Dyad's curated native engineering tools
- **Extension plane:** MCP only for capabilities not already native
- **Repository intelligence:** optional deterministic `tools/repo-intel` CLI/MCP

"Zenith" is not another agent, model, process, or hidden orchestration loop. It is the policy that selects the best configured model route while keeping Dyad's existing agent, permissions, app state, blueprint workflow, and verification controls authoritative.

## Why the architecture is intentionally small

The previous experimental build exposed multiple meta-reasoning tools and several MCP servers that duplicated reasoning already performed by the model. Those were removed from the default registry. Model-visible tools now focus on observable work: files, code search, Git, execution, tests, type checks, builds, architecture, debugging, browser/E2E verification, integrations, and explicit MCP discovery.

Repo-Intel is deterministic by design in this distribution. Its separate LLM brain and duplicate read/edit/bash tool framework are not bundled into the runtime architecture. Dyad is the brain; Repo-Intel supplies evidence when invoked.

## Trust boundaries

Provider API keys are provider credentials. They never imply a Dyad Pro entitlement. A Dyad credential is read only from the dedicated `auto` provider setting. Source code contains no bundled provider credentials.

The local MCP catalog is curated. It includes only optional retrieval/memory/browser/GitHub/documentation integrations; duplicate thinking/prompt-optimization MCPs are intentionally excluded.

## Release gates

Run:

```bash
bun run verify:zenith
bun run ts
bun run test
bun run build
```

For deterministic repository analysis:

```bash
bun run repo:intel -- summary .
bun run repo:intel:verify
bun run repo:intel:mcp
```

`verify:zenith` is a dependency-free architecture/security policy check. It does not replace type checking, tests, packaging, or E2E verification.
