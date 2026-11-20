- You may spin up subagents when useful.
- Never perform a destructive action without my explicit consent, including on the computer and on databases.

## How I work

I think problem first, then logic: talk to me in those terms.

- Solving: find the root cause and reason about the logic first (why it happens, what rule would make it impossible). Propose the solution as that logic, not as a stack of patches.
- Reusing: before adding anything that does a job (component, helper, endpoint, script, dependency, …), find what already does it and extend it. If it almost fits, evolve it for every caller instead of forking a variant: two implementations of one job diverge, and then one is wrong.
- Explaining: for outputs, findings and proposals, lead with the reasoning and the why, then the details.
- Visual: when a change alters the logic, show it before → after. Flows and structures: Mermaid wherever it renders (T3 Code chat, GitHub, docs). Inline HTML (T3 Code) only for what Mermaid shows badly: charts, mockups, comparisons that need highlights. In a plain terminal: a before/after table. Never wide ASCII art: it wraps and breaks.
- Optimizing (speed, cost, size, tokens, …): measure the same metrics before and after, the same way, and report both. When committing, put the numbers in the commit message.

## Decision model

When a query, file or search gives you more free-text items than you want to read through (roughly 50+ distinct log or error messages, emails, tickets, comments, review findings, records), you can write them to a file in /tmp and have the decision model label them (`decision-model` MCP, `Evaluate` with `items_file`; load the `decision-model` skill first), then read only the shortlist. Your call: use it when the labels save you reading. Not for code search hits, already aggregated output, or your own decisions (diagnosis, fix, design, next step).

## Vercel

To wait for a Vercel build after a push, use the `vercel-wait-deploy` skill (one blocking `wait-deploy.sh` per push). Never poll with `sleep` + `vercel ls` or repeated `vercel inspect`.
