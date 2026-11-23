---
name: council
description: Independent opinions from several models (default opus, sol, astra) on anything, each with a 1-10 score, what to change and why, and what works. `council N` loops fix-and-review until every member scores at least N. Use for /council, /council N, or when asked for other models' opinions.
argument-hint: "[N] [with <model>, ...] <what to judge>"
---

# Council

Members: **opus, sol, astra** by default (astra is the user's explicit choice for this skill). The user can name others. Members are read-only: they never edit files.

Two modes:
- `council`: one round of opinions. Nothing is applied without the user's call.
- `council N` (e.g. `council 9`): the invocation is the user's call to apply. Rounds and fixes alternate until every member scores at least N/10 (see Loop).

## Before a round

When the subject is code: address open PR comments, fix known issues, run typecheck and tests, and give the council the updated version. Do not hold known fixes until the reviews come back. Skip fixes to code the user wants to discard.

## Running members

- T3 Code: call `orchestrator_capabilities` once to resolve model ids and option names, then one `delegate_task` per member, all in parallel, with `role: "review"`, `interactionMode: "plan"` (this is what makes the child read-only; a narrow `runtimeMode` only pauses for approval) and effort `high` for every member (Claude option `effort`, Codex option `reasoningEffort`, Antigravity option `thought_level`). Sol also runs on the Fast tier (`serviceTier: "priority"`).
- Standalone CLI (outside T3 Code): each member runs through its family's launcher directly, never wrapped in another agent, read-only, effort `high` (every launcher's default): opus through `call-claude` (in Claude Code itself, the Agent tool with `model: opus`, `effort: high`), sol and astra through `call-codex`, neon, when named, through `call-antigravity`.
- Report a member that is unavailable or fails. Never replace it unasked.

## Round

For the UI of a running app, use `ui-review`: its captures and brief replace steps 1-2; everything else here applies.

1. Put everything to judge in files (anything that lives only in the chat goes to the scratchpad), so every member reads the same bytes.
2. Give every member the same brief and nothing else: no opinion of yours, no criteria, no other answers.

```
Give me your opinion on <subject>.
Context: <what it is, who it is for, what it must achieve, facts only>.
<Code only: Constraints enforced elsewhere: <product constraints, e.g. one subscription per account>. A scenario that breaks one of these is out of scope.>
<Only if the user gave one: Focus on <focus>.>
<council N, from round 2: Already decided, do not raise again: <point - dropped - reason>.>
Material: <absolute paths>. Read all of it; open images with your image tool, and say so on the first line if you cannot see them.
Be thorough in the analysis and direct in the judgment.
Answer in <user's language>, exactly in this format:
Score: <1-10>/10
What's wrong: for each point, what you would change and why, most important first.
What works: what you would keep as it is, and why.
Do not modify any file.
```

3. Run all members in parallel and wait for all of them.

## Synthesis

In the user's language:
1. Scores: member, model id, score; median and spread. Name strong outliers and why. A member that gives no score is `no score`: never invent or infer one, and leave it out of the median.
2. Agreement: themes raised by two or more members (theme, who, change, why).
3. Disagreements and lone points that matter.
4. What works.
5. Your verdict: verify each factual claim against the material before endorsing it, mark the main points confirmed / disputed / taste, and say what you would change first.

## Loop (`council N` only)

1. After the synthesis, triage every point: **fix** (valid: reached by a user path you can name, even if not yet observed) or **drop** (not a defect, unreachable, or outside the subject; never reported). Apply the fixes, then verify them yourself (typecheck, tests, build).
2. Each new round uses new delegates, never a follow-up message to the old ones: same brief on the updated material, plus the "Already decided" line. No earlier scores, no list of what you fixed, no opinion of yours.
3. Keep the scope. Fixes stay inside the subject as given; a point that asks for a new feature or a redesign is asked to the user in this turn, with your recommendation, not implemented unasked.
4. After every round, update the report (see Report) and, if a PR is open, the score table in its description (edit it, do not post a comment).
5. Stop when every member scores at least N; `no score` counts as below N. Also stop and ask the user when two rounds in a row raise no member's score, or when the same-spot rule in the global rules fires. This stop rule replaces the global review budget.
6. Final reply: the score table, what was fixed, rounds and agents used, files touched, and the report path.

## Report (`council N` only)

Keep one HTML report per run at `<scratchpad>/council/<subject-slug>/report.html`, with its images in the same folder. It lives for the run only. Dropped points are not in the report: keep them in `dropped.md` in the same folder, only to build the "Already decided" line. Update it after every round; in T3 show it with `html_preview` then `html_render`, elsewhere give its path.

Contents:
1. Subject, target N, members with model id.
2. Scores: one row per round, one column per member, with the change from the previous round; `no score` stays as such.
3. Per round:
   - Changes made: what changed, why, and who identified it (the member names, or `orchestrator` for what you found yourself, before a round or while verifying).
4. Close: rounds, agents, files touched, points fixed.
