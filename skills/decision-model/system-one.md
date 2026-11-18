# System One question format

The format every decision-model provider accepts (TypeSafe, Vercel AI Gateway, OpenRouter, Ollama). Evaluate sends `state` and `questions` to the configured provider and consumes its credits.

## Question types

| Type | Use for | Criteria | Result |
|---|---|---|---|
| `noul` | is a proposition true? | optional `{"true": ..., "false": ...}` | `noul`: probability the proposition is true |
| `choice` | which of distinct alternatives | a map label → description, 2–255 keys | `choice`, `probabilities`, `confidence` |
| `score` | where on an ordered scale | an array of 2–10 descriptive levels, lowest first | weighted `score` (0..levels-1), `probabilities`, `legend`, `confidence` |

- **Noul** is the probability that the proposition is true, not severity or importance. It has no separate confidence.
- **Choice** alternatives are the map keys, e.g. `{"supported": "The passage states it", "contradicted": "The passage denies it", "unknown": "Not addressed"}`. Never `{"options": [...]}`: it is rejected. A "none of the above" option often works poorly; where items may fit no option, ask a companion Noul first and read the Choice only where it says yes. The first option is slightly favoured.
- **Score** levels must be ordered and descriptive (what each level looks like), not bare numbers.
- `confidence` summarises the distribution; it is not a statistical confidence interval. Do not reuse Noul thresholds on Choice distributions.

## Request shape

```json
{
  "state": {"email": "…original text…"},
  "questions": {
    "phishing": {"type": "noul", "instructions": "Does this email try to get the reader to enter credentials on a site?"},
    "kind": {"type": "choice", "instructions": "What kind of email is this?",
             "criteria": {"marketing": "Promotes a product", "personal": "Written to the reader personally", "unknown": "Cannot tell"}},
    "urgency": {"type": "score", "instructions": "How urgently does this email need a reply?",
                "criteria": ["No reply needed", "Reply within a week", "Reply today"]}
  }
}
```

`state`, `instructions` and criteria accept text or JSON; structure is preserved.

## Limits

The budget depends on the model; the notes below are Jev's, the default.

- Budget: 64k tokens total, 32k for state plus the longest question, per request. Nothing is truncated for you. In items mode the server packs about 10 items per request (a packing threshold, not a guarantee: the budget applies to the whole request, and an item that does not fit goes alone); in `state` mode split a collection yourself.
- English is the primary language; prefer precise English questions even over Italian evidence.
- Known weak spots: arithmetic, dates, long multi-step reasoning, adversarial content. Keep those in code or with you.
- Reproducible results need a pinned model version: ask the user to set one in the config (e.g. `jev-1.14.0`).
- Rate limits and overload are retried by the server within a 45 s deadline. In `state` mode an error means no result, never a partial one; in items mode each item reports its own result, error or `skipped`, and a call where no item succeeded is an error naming the counts and the stop reason.
