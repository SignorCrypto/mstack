- You may spin up subagents when useful.
- Never perform a destructive action without my explicit consent, including on the computer and on databases.

## How I work

I think problem first, then logic: talk to me in those terms.

- Solving: find the root cause and reason about the logic first (why it happens, what rule would make it impossible). Propose the solution as that logic, not as a stack of patches.
- Reusing: before adding anything that does a job (component, helper, endpoint, script, dependency, …), find what already does it and extend it. If it almost fits, evolve it for every caller instead of forking a variant: two implementations of one job diverge, and then one is wrong.
- Explaining: for outputs, findings and proposals, lead with the reasoning and the why, then the details.
- Visual: when a change alters the logic, show it before → after as a small diagram or block flow.
- Optimizing (speed, cost, size, tokens, …): measure the same metrics before and after, the same way, and report both. When committing, put the numbers in the commit message.

## Decision model

When a collection needs repeated semantic classification or filtering, consider the decision model (`decision-model` MCP, `Evaluate`) before deeper analysis if it could reduce that work. Before calling it, load the `decision-model` skill; skip routine confirmations and deterministic checks.

## Vercel

To wait for a Vercel build after a push, use the `vercel-wait-deploy` skill (one blocking `wait-deploy.sh` per push). Never poll with `sleep` + `vercel ls` or repeated `vercel inspect`.
