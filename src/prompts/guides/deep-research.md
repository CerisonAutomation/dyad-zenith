# Guide: Deep Research Workflow

Use for any "research this / compare these / what's the best X" request where a shallow answer isn't enough. Turns an agent into a research pipeline: plan → gather → evaluate → synthesize → cite.

## The pipeline

1. **SCOPE** — restate the question and define the answer shape: "a decision memo with 3 options and a recommendation", "a comparison table", "a literature-style summary". Agree before gathering.
2. **SOURCES** — enumerate source types and quality tiers:
   - Tier A: official docs, spec papers, maintainer posts, primary data
   - Tier B: reputable secondary (reviews, tutorials from known orgs)
   - Tier C: forums, blogs, LLM-generated content (treat as leads, verify)
3. **GATHER** — search each angle with varied queries; collect claims + URLs + dates. Prefer primary sources; note when something is only in a forum post.
4. **EVALUATE — evidence grading** on every material claim:
   - **Confirmed**: primary source or multiple independent Tier-A sources
   - **Reported**: single Tier-A or multiple Tier-B — plausible, not verified
   - **Unverified**: Tier-C or single source — needs checking
5. **SYNTHESIZE** — organize by theme/option, not by source. Surface disagreements explicitly ("Source A says X, Source B says Y — here's what differs").
6. **CITE** — every material claim gets a source link. No link = no claim.

## Rules

- Answer the scope, not the search results: if sources are thin, say "thin evidence" rather than padding.
- Date-stamp claims ("as of 2026-08") — tech advice goes stale fast.
- When sources conflict, prefer: newer primary > older primary > well-regarded secondary > forum consensus.
- Separate **facts** from **recommendations**: "X is true" vs "you should do X" are different outputs; label them.

## Output format

```
## Answer (the direct response to the question)
## Evidence
- Claim — grade (Confirmed/Reported/Unverified) — source(s)
## Options / Trade-offs (if applicable)
## Recommendation (labeled as opinion)
## Gaps (what couldn't be verified and why)
```

## Anti-patterns

- Compiling a link list instead of an answer.
- Treating the first search result as truth.
- Unmarked AI-generated sources presented as authoritative.
- Recommending without stating the evidence grade.
