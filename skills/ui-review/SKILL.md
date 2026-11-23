---
name: ui-review
description: UI/UX review of a running app by the council (opus, sol, astra), each with a 1-10 score, what works and what they would change. `ui-review N` loops until every member scores at least N. Use for iterative UI review of a running app.
---

Ask simple questions and let the evaluators think. Criteria lists, worst-state scores and defect-by-screen tables produced local patches and hid the structural problem; one plain question surfaced it in a single round.

This is the UI version of the `council` skill. Running the members, the synthesis and the `N` loop come from there; this skill adds the captures, the brief and how to show the work.

## Before a round
- Run the real app, desktop first (1280 wide, light and dark). Mobile only must not break: one automatic check, no evaluator time.
- Capture every state of the surface under review: empty, filled, live, failed, each kind of item. Use realistic test data and fix capture bugs before evaluators see the shots.
- One capture set per round, used three ways: evaluator input, the "before" of this round's fixes, the "after" of the previous round's. Save each state's 2× PNG with its accessibility tree (the `[box=…]` coordinates `ui-before-after` measures with), and give evaluators a 1× copy (`sips --resampleWidth 1280`): ~1,300 image tokens instead of ~4,800, layout and hierarchy stay readable. Add a 2× crop only where a pixel-level detail matters.
- Keep the surface fixed during a round: no feature work mixed into a review.

## The round
Members and how to run them: as in council. Opus reads the PNGs with its image tool.

Each gets this short brief and nothing else: no scores from earlier rounds, no criteria, no list of constraints, no hint of what you think is wrong.

```
Evaluate the UI of <surface> in <product>.
<product> is used by <who> to <what>. It is used on desktop, in <product language>.
The owner wants it <owner's own words, quoted as given, e.g. "pulita, intuitiva, un po' innovativa e davvero bella">.
The screenshots are in this folder, each with a .txt holding its visible text: <folder>
Open and look at every PNG with your image tool. If you cannot see images, say so on the first line. The data is test data.
<ui-review N, from round 2: Already decided, do not raise again: <point - dropped - reason>.>
Be thorough in the analysis and bold in the proposals.
Answer in <user's language> with:
1. A score from 1 to 10.
2. What works.
3. What you would change.
Do not modify any file.
```

Add a focus line only when the user names one ("Focus on the node sheet").

## After a round
- Synthesis as in council.
- Verify a finding in the code or the pixels before fixing it. A structural or engine change is the user's call: ask it in this turn with your recommendation, do not decide it. Drop what is not valid without mentioning it.
- The user's taste and words override every evaluator. Product terms follow the glossary even when an evaluator proposes another word.
- Fix in parallel by disjoint file area (Opus implements), then verify yourself: typecheck, tests, fresh captures. The fresh captures are the next round's set: same viewport, same data.

## Showing the work
Show every visible change with the `ui-before-after` skill, built from the round's captures: this round's set is the "before", the fresh captures are the "after" (2× PNGs and their trees, the round's viewport). Do not capture again for it. In `ui-review N`, its composites go into the council report, next to the change they show.

## Stop
- `ui-review`: two rounds by default, or as many as the user asks. `ui-review N`: council's Loop, stop rules included.
- If two rounds in a row move a theme no closer, stop and put the structural question to the user.
- Never claim a score you did not measure; the last fixes are unscored unless an evaluator saw them.
- Before shipping, the usual gate applies: code review from another model family, full tests.
