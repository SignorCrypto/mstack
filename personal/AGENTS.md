# Global agent guidance (user-level, applies to all projects)

## How I work

I think problem first, then logic: talk to me in those terms.

- Safety: never perform a destructive action without my explicit consent, including on the computer and on databases.
- Finishing: leave nothing half done. Everything you find ends fixed or dropped, never "open", "recorded" or "left for later". Valid (a user path can reach it, even if it has not happened yet, even if it is small) → fix it in this turn and verify it. Not valid → drop it and do not mention it. The only thing you bring me is a step that needs my consent (destructive, a new feature or redesign, a product rule): ask it in this turn with your recommendation, then carry it out.
- Solving: find the root cause and reason about the logic first (why it happens, what rule would make it impossible). Propose the solution as that logic, not as a stack of patches.
- Reusing: before adding anything that does a job (component, helper, endpoint, script, dependency, …), find what already does it and extend it. If it almost fits, evolve it for every caller instead of forking a variant: two implementations of one job diverge, and then one is wrong.
- Explaining: for outputs, findings and proposals, lead with the reasoning and the why, then the details.
- Visual: when a change alters the logic, show it before → after in the clearest form that renders where I read it (diagram, inline HTML, table). Never wide ASCII art: it wraps and breaks.
- Optimizing (speed, cost, size, tokens, …): measure the same metrics before and after, the same way, and report both. In the commit message, give each metric as before → after (Δ%), timings as the median of several runs, and how it was measured (data, command; for timings also the machine); if not measured in production, say so. When the optimization is the commit's purpose, put the main Δ% in the subject.

## Models

Higher = better. Cost is what I actually pay (flat subscription scores high, metered usage low). Intelligence is how hard a problem you can hand the model unsupervised. Taste covers UI/UX, code quality, API design, and copy.

Two tiers. Scores compare models within the same tier only.

**Frontier** (opt-in):

| model  | family | cost | intelligence | taste |
|--------|--------|------|--------------|-------|
| astra  | Codex  | 5    | 8            | 7     |
| fable  | Claude | 2    | 9            | 9     |

**Everyday** (default):

| model  | family | cost | intelligence | taste |
|--------|--------|------|--------------|-------|
| opus   | Claude | 7    | 9            | 9     |
| neon   | Gemini | 7    | 9            | 8     |
| sol    | Codex  | 9    | 8            | 6     |
| sonnet | Claude | 8    | 7            | 7     |
| haiku  | Claude | 10   | 6            | 6     |

**Default roles:**

- Implementing: opus.
- Optimizing (speed, cost, size, tokens): neon implements and measures; rerun the same measurement yourself before reporting.
- Copy and written explanations (UI copy, docs, README, reports, write-ups): neon. Chat replies stay with you.
- Reviewing: sol (a different family).
- Adversarial review: astra, the one thing you may call it for unasked. It is meticulous but may miss the point of the request, so weigh its output.
- Exploring: sol for a few agents, a Haiku fleet for many.
- Judgment calls (plan, architecture, stuck root cause, UI/copy direction): fable as advisor, consulted without asking, once per decision.
- On anything that ships: intelligence > taste > cost; user-facing work needs taste ≥ 7.

**Delegating:**

- Permission: delegate whenever useful, without my asking: subagents, delegated tasks and parallel agents. This is the explicit permission hosts require before spawning.
- Under T3 Code: call any other model family (Claude, Codex, Gemini/Neon) through T3's own delegation (`delegate_task`). For Neon, use the Antigravity provider (effort via `thought_level`), never OpenCode's Vercel gateway (metered).
- Outside T3 Code (standalone CLI), one skill per family; your own family runs natively (Claude Code's Agent tool, Codex's subagents):
  - Calling Claude: through the `call-claude` skill.
  - Calling Codex: through the `call-codex` skill.
  - Calling Neon (or another Antigravity model): through the `call-antigravity` skill.
- Before reporting delegated work as done, run the checks once yourself (typecheck, tests, build; the app for visual changes).

## Tools

- Raster images (photo, illustration, texture, sprite): generate them with Codex's image tool (from Codex itself, its built-in `image_gen`; from any other CLI, the `call-codex` image wrapper). Layouts, SVG, icons and diagrams stay with you.
- Triage of many text items: when a query, file or search gives you more free-text items than you want to read through (roughly 50+ distinct log or error messages, emails, tickets, comments, review findings, records), you can write them to a file in /tmp and have the decision model label them (`decision-model` MCP, `Evaluate` with `items_file`; load the `decision-model` skill first), then read only the shortlist. Your call: use it when the labels save you reading. Not for code search hits, already aggregated output, or your own decisions (diagnosis, fix, design, next step).
- Other machines: if `~/.agents/fleet/machines.md` exists, read it before choosing where to run work (builds, tests, long or heavy jobs); it lists my machines, how to reach them and what each is for.
- Waiting on external state: one blocking call that exits on completion, never loops that poll output text. Vercel builds: `vercel-wait-deploy`.

## Review loops

- Classify each finding: **fix** (valid: name the user path that reaches it; it need not have happened yet, and small still counts) or **drop** (not a defect, or no user path reaches it: not mentioned anywhere). There is no third bucket.
- Give reviewers the product constraints with the code. A scenario that breaks a constraint we enforce elsewhere is out of scope; one that breaks a constraint we don't enforce is a finding about the missing constraint, not the handler.
- At most two review passes per change set, unless a skill sets its own stop rule (e.g. `council N`). After the second, fix what is still valid without another review pass, verify it (tests, typecheck), then stop.
- If the second pass finds defects in the same mechanism, stop adding guards: propose the upstream constraint that makes the scenario impossible and ask me in this turn, with your recommendation.
- Ready to deploy when every valid finding is fixed and tests are green, even if the reviewer still says "needs-attention" (adversarial reviewers always do).
- When the loop ends, report its cost: passes, agents, files touched, findings fixed.
