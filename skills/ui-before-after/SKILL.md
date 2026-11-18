---
name: ui-before-after
description: Recap of a UI change as annotated before/after images - same screen, same viewport, numbered red callouts on the problems and green on the fixes, a numbered legend with the measured gain. Use whenever you change a UI and report it, or when asked for a before/after, a screenshot recap or "mandami prima e dopo".
---

# UI before/after recap

The user reads a UI change through images, not diffs. Each screen touched gets one composite: PRIMA on the left, DOPO on the right, the same numbers on both sides, and a legend under them that says what changed, why, and by how much.

## 1. Capture "before" first
- Inside `ui-review`, skip steps 1-3: the round's captures are the "before", its fresh captures the "after", at the round's viewport. Go straight to 4.
- Capture before touching any code. Once an edit lands, the "before" is gone.
- Run the real app on real (dev) data, logged in. Under T3 Code use the preview tools: `preview_open` on the dev server port, `preview_resize` freeform to the user's real screen (default **1728×1000**, a 16" MacBook), then `preview_snapshot` with `save: true`. The saved PNG is 2× retina and sharp; the inline image is downscaled, so don't use it.
- Capture every state the change touches: each tab, any open popover or dialog the change affects, and empty states. Keep one file per state, named the same in `before/` and `after/` under the scratchpad.
- Wait for the real content (`preview_wait_for` on visible text). A skeleton is not a "before".
- A temporary banner or notice stays in both shots: say it is not part of the change. Don't hide it in just one of them.

## 2. Measure while you capture
- `preview_snapshot` returns an accessibility tree with `[box=x,y,w,h]` in **CSS px**. These are the coordinates for the callouts and for the numbers in the legend: "the messages start at y=245 → 177", "707 → 807px (+14%)".
- Write down the box of every region you will mark, both before and after, from the trees. Never guess coordinates from the picture.

## 3. Capture "after" the same way
Same viewport, same agent/record, same tab, same popover open. Only the code may differ.

## 4. Compose
Write a JSON spec and run the bundled script (Pillow, macOS fonts):

```
python3 -I ~/.claude/skills/ui-before-after/scripts/annotate.py <scratchpad>/recap-spec.json
```

The spec format is at the top of `scripts/annotate.py`. Rules for the marks:
- **Red** on "before" marks problems, **green** on "after" marks fixes. The same number means the same point on both sides and in the legend.
- A label is a few words in the user's language ("Riga duplicata: nome già nella barra", "Azioni della chat qui"). The why goes in the legend, not on the image.
- A large region (a whole column or card) gets an outline only and its label beside it, never across the text.
- Place labels where they cover no content you are pointing at. Open the PNG with Read and move any label that collides.
- One legend line per number: what changed, why, and the measurement (`34px → 22px`, `+100px di conversazione`). A last line can carry the overall result without a mark.
- One composite per screen: `01-chat.png`, `02-connections.png`, … A change that only removes a field still gets its own small composite, so the removal is visible.

## 5. Report
- Embed each composite in the reply with its absolute path (`![Chat prima e dopo](/abs/path/01-chat.png)`) and give it a one-line caption with the headline gain.
- After the images, briefly: what changed, the verification (typecheck, tests), what was recorded but not done, and the proposals left for the user to decide.
- The images are the main content. Don't repeat in text what a legend already says.
