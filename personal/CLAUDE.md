# Global agent guidance (user-level, applies to all projects)

## How I work

I think problem first, then logic: talk to me in those terms.

- Solving: find the root cause and reason about the logic first (why it happens, what rule would make it impossible). Propose the solution as that logic, not as a stack of patches.
- Reusing: before adding anything that does a job (component, helper, endpoint, script, dependency, …), find what already does it and extend it. If it almost fits, evolve it for every caller instead of forking a variant: two implementations of one job diverge, and then one is wrong.
- Explaining: for outputs, findings and proposals, lead with the reasoning and the why, then the details.
- Visual: when a change alters the logic, show it before → after as a small diagram or block flow.
- Optimizing (speed, cost, size, tokens, …): measure the same metrics before and after, the same way, and report both. When committing, put the numbers in the commit message.

## Models

Higher = better. Cost is what I actually pay (flat subscription scores high, metered usage low). Intelligence is how hard a problem you can hand the model unsupervised. Taste covers UI/UX, code quality, API design, and copy.

Two tiers. Scores compare models within the same tier only.

**Frontier** (opt-in):

| model  | family | cost | intelligence | taste |
|--------|--------|------|--------------|-------|
| astra  | Codex  | 5    | 8            | 8     |
| fable  | Claude | 2    | 9            | 9     |

Astra: good at adversarial review of concurrency, retry and money mechanisms; meticulous but may miss the point of the request, so weigh its output.

**Everyday** (default):

| model  | family | cost | intelligence | taste |
|--------|--------|------|--------------|-------|
| opus   | Claude | 7    | 9            | 9     |
| sol    | Codex  | 9    | 8            | 7     |
| sonnet | Claude | 8    | 7            | 7     |
| haiku  | Claude | 10   | 6            | 5     |

- Default roles: opus implements, sol reviews (a different family). Exploration: sol for a few agents, a Haiku fleet for many. Fable is the advisor for judgment calls (plan, architecture, stuck root cause, UI/copy direction): consult it without asking, once per decision.
- Go Frontier or swap in a smarter model (fable can also implement) only when I ask or a result fell concretely short: redo once and say so. Difficulty alone is no reason. On anything that ships: intelligence > taste > cost; user-facing work needs taste ≥ 7.
- Before reporting delegated work as done, run the checks once yourself (typecheck, tests, build; the app for visual changes).
- Calling Codex: in Claude Code, through the `call-codex` skill; under T3 Code, through T3's own delegation.

## Tools

- Raster images (photo, illustration, texture, sprite): generate them with the `call-codex` image wrapper. Layouts, SVG, icons and diagrams stay with Claude.
- Repeated semantic classification or filtering of a collection: consider the decision model (`decision-model` MCP, `Evaluate`), loading the `decision-model` skill first.
- Waiting on external state: one blocking call that exits on completion, never loops that poll output text. Vercel builds: `vercel-wait-deploy`.

## Review loops

- Classify each finding: **fix** (real and reachable: name the concrete user path), **record** (real but unreachable or trivial: list it in the report, no code), **reject** (not a defect). No user path, no fix.
- Give reviewers the product constraints with the code. A scenario that breaks a constraint we enforce elsewhere is out of scope; one that breaks a constraint we don't enforce is a finding about the missing constraint, not the handler.
- At most two review passes per change set, unless a skill sets its own stop rule (e.g. `council N`). After the second, record what is left; fix only regressions caused by the fixes, then stop.
- If the second pass finds defects in the same mechanism, stop adding guards: propose the upstream constraint that makes the scenario impossible (e.g. one subscription per account) and wait for my call.
- Ready to deploy when every open finding is "record" and tests are green, even if the reviewer still says "needs-attention" (adversarial reviewers always do). Say what was recorded.
- When the loop ends, report its cost: passes, agents, files touched, fixed vs recorded.
