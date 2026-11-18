---
name: poteto-guardrails
description: Poteto's guidelines for shipping agent-written code fast without losing quality ("turn slop into gold") - invest in the agents' environment so you can trust them: a pristine codebase, deterministic checks instead of prose rules, verification artifacts, and only then automation. Use when asked to improve a codebase for agents, after correcting an agent's mistake, or when the user mentions Poteto, guardrails, slop or a software factory.
---

# Poteto guardrails

The job of an engineer working with agents is to keep or raise code quality while massively increasing throughput. That comes from **trust**: not blind trust, but an environment where you can trust agents to do the right thing by default.

## The trust pyramid (spend effort top-down)

1. **The codebase itself**: good API design, architecture, refactoring.
2. **Deterministic checks**: lint rules, types, compilers, tests.
3. **Verification**: runtime and formal, to find bugs and check the agent understood the intent.
4. **Prose** (rules, skills, AGENTS.md): last, only for what needs judgement.

Layers 1 and 2 constrain agents so the right thing happens by default.

## Guidelines

- **The codebase is the biggest input.** Agents copy what they see: workarounds, anti-patterns, deprecated code and tech debt look like the established pattern and spread like weeds. Keep it pristine so they copy the good stuff.
- **Every correction becomes a deterministic check**, not a new line in AGENTS.md. Code is reproducible and trustworthy; prose is not. Write lint rules whose error messages tell the agent to fix the root cause, not patch around it.
- **Ban what needs nuance.** APIs that are easy to misuse (e.g. `useEffect`, imperative timers used as quick fixes) are banned in product code and allowed only inside a few framework-level helpers. The problem disappears categorically and never needs review again.
- **Context through directory structure.** Make boundaries literal directories (e.g. `main/` vs `renderer/`) and forbid wrong-direction imports with a dependency-graph check and lint rules.
- **Ban ~99% of comments.** They go stale, nobody reads them, they are not enforceable, and they give agents a place to justify not doing the right thing. Replace them with lint rules and clearer code.
- **Review artifacts, not diffs.** Let agents verify their own work and hand back screenshots, videos, diagrams and state charts.
  - **Runtime verification**: give agents a way to run the app and use real debugging tools (e.g. Chrome DevTools protocol), packaged as skills with custom CLIs (cheaper in tokens, testable).
  - **Feature map**: a sitemap of user-facing features in shared vocabulary, so "the thing in the left sidebar" is unambiguous.
  - **Formal verification and property-based testing**: model-check major user flows (e.g. TLA+), prove tricky algorithms (e.g. Lean), property-test UIs. Not a silver bullet: another layer.
- **Spend tokens on verification.** Most token usage should go to verifying, not generating. Agents make testing that used to be too expensive affordable.
- **Foundations before the factory.** Automating a loop that produces slop produces more slop. Fix the codebase, the static checks and the verification first; then build the outer loop (agents that fuzz the app, open fix PRs and merge them).

## When you correct an agent

1. Ask which check would have made the mistake impossible: a better API or architecture, a type, a lint rule, a test.
2. Add it with a message that names the fix.
3. Clean up the existing occurrences of the pattern.
4. Only if no code can check it, write it down as prose.
