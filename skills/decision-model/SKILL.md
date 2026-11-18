---
name: decision-model
description: First-pass labeling of many free-text items through the `decision-model` MCP's Evaluate tool (relevant?, which kind?, how severe?): write them to a file, get counts, uncertain ids and a results file, and read only the shortlist. Use when you judge it pays, typically when a query, file or search returns roughly 50 or more distinct items you would otherwise read through yourself - log and error messages, emails, tickets, issue and PR comments, review findings, user messages, records, retrieved passages. Load before any Evaluate call. Not for code search hits, already aggregated output, anything code can compute, or your own decisions (diagnosis, fix, design, next step, approval) - it sees only the evidence you send.
---

# Decision model

A decision model returns fast, cheap semantic judgments (a yes probability, a choice among options, a score on ordered levels) over evidence you supply. It replaces repeated reading, not thinking: use it to shrink a collection before you analyse it, never to make the final call.

## Quick start

This is everything the usual call needs; [system-one.md](system-one.md) is only a reference for limits and edge cases. In Claude Code the tool is deferred: load it with ToolSearch `select:mcp__decision-model__Evaluate`.

1. Put the items in a file under `/tmp` with code (redirect a query, extract with `jq`, or `cp` a project file). One JSON object per line (`.jsonl`) or one text item per line; an `id` field names an item and is not sent.
2. Call Evaluate:

```json
{
  "items_file": "/tmp/triage/errors.log",
  "dedupe": "normalized",
  "context": "Yesterday's WARN and ERROR lines from a production web backend.",
  "questions": {
    "family": { "type": "choice", "instructions": "Which kind of problem does this log line report?",
                "criteria": { "payments": "Charges, invoices, webhooks from the payment provider", "auth": "Login, tokens, permissions",
                              "data": "Writes, exports or reads that lose or corrupt data", "performance": "Slow or timed-out work",
                              "transient": "A retry that recovered, a client that went away" } },
    "in_family": { "type": "noul", "instructions": "Does this log line report a problem with payments, auth, data, performance, or a transient failure?" },
    "needs_fix": { "type": "noul", "instructions": "Does this line indicate a defect that needs a code or configuration change?" },
    "severity": { "type": "score", "instructions": "How much harm does the problem in this line cause users?",
                  "criteria": ["None", "Minor annoyance", "A feature fails for some users", "Money or data lost, or a core flow broken"] }
  }
}
```

   - Write the criteria for the task at hand: they are your policy (what counts as severe, what needs a reply), and the labels will follow them exactly.
   - `choice`: a map label → description, one line each (2-255 labels; never `{"options": [...]}`). A "none of the above" label often works poorly: when items may fit no label, add a companion `noul` ("Does this line report a problem in any of these areas?") and trust the choice only where it says yes. The first option is slightly favoured: put the likeliest one first, or reorder to check.
   - `noul`: one yes/no proposition, phrased so that a high value means yes; two conditions are two Nouls. Read ≥ 0.7 as yes, ≤ 0.3 as no and the band in between as yours to check (TypeSafe's starting points; tune them on your data, per model).
   - `score`: 2-10 ordered levels describing situations, not degrees ("A feature fails for some users", not "3"), lowest first, one dimension per score.
   - Questions are about one item, short and complete (question ids are not sent), and must not mention the item by name or id: the server points each copy at its item (`` About `items.item_3` only: …``). Precise English works best, even over Italian evidence.
   - For log lines use `"dedupe": "normalized"` as above: lines that differ only in timestamps, ids and numbers are judged once (a standalone `0` and id prefixes are kept; `results_file` shows up to 3 `variants` per group). When a number decides the answer, such as an HTTP status or a size against a limit, keep the default `exact` or group with your own key.
3. Read the reply: per-question `counts`, `uncertain_ids` (the first 50; `uncertain_total` beyond), inline `results` up to 20 distinct items, and `results_file`, JSONL with one line per group: `ids`, `item`, full `answers`. Take the shortlist with code, e.g. `jq -c 'select(.answers.needs_fix.noul >= 0.7)' FILE` or `select(.answers.family.choice == "payments")`.

The server groups duplicates, sends about 10 distinct items per request with each question asked per item, and runs requests in parallel. Measured: 298 support messages in 1.6 s and 129k input tokens (one item per request: 5 s, 200k, same accuracy); 400 log lines with `normalized` in 1.2 s and 7k tokens. At most 500 distinct items and about 50 s per call: reduce with code first (filter by level, drop known noise) or split across calls.

## When to call it

You decide. It pays when a query, file or search gives you more distinct free-text items than you want to read through to judge one by one (roughly 50+): labels let you read only the shortlist. Not for code search hits (you judge those by reading code), output that is already aggregated, anything code can compute, or your own decisions: asking it to pick among options you wrote only echoes your choice back at high confidence. Below that size, or for a one-off check, it needs a concrete triage benefit or an explicit request. Examples, not exhaustive:

- **Emails and support messages:** independently flag kind, spam, phishing indicators, urgency, or a request for a reply. A link judgment needs the actual targets; a familiar-sender judgment needs contact evidence.
- **Large log collections:** classify error families and score severity on defined levels to shortlist incidents. You diagnose the causes.
- **Retrieved passages or documents:** classify topic or type, filter relevance, or flag whether a passage supports a supplied claim. You verify the shortlist.

## The pattern

retrieve/filter → decision model labels/scores → code aggregates/routes → you investigate/verify.

- **One item, several dimensions:** ask a separate question per dimension in the same call (an email can be marketing, urgent and phishing at once).
- **Combine in code:** weights, thresholds and routing rules are deterministic code you write for the task. Never ask the model to collapse everything into "what should I do?".
- **Labels decide what you read, not what you conclude:** read the shortlist and the uncertain ids in full, spot-check a few items of each other label with code, and stop there. Re-reading the whole collection after labelling pays twice. Do not drop a shortlisted item on a prior you have not checked against its text: in a measured run on 298 support messages the urgency label caught 50 of 51 urgent ones, and every miss in the final answer came from the agent's own narrowing afterwards.
- **Reuse** evaluations whose evidence and criteria have not changed.

## Other details

- **One evidence, several questions:** pass `state` (text or JSON you already hold) instead of `items_file`; name the exact item in each question, since question ids are not visible to the model. `items` takes an inline array when you already hold the items (e.g. in a Codex script).
- **Failures:** items not reached in time come back `skipped` in `results_file`: pass them again. If no item succeeds, the call is an error that says how many failed, how many were not sent and why it stopped. A missing key, credits, a model or ZDR problem is the user's config: tell them the fix the error names (`node src/config.mjs`, `setup-key.py`) instead of working around it. The user picks provider and model (default Jev through Vercel AI Gateway, zero data retention); you cannot choose them per call.
- **Data:** what you send leaves the machine for the provider. Evidence that looks like a credential is refused before sending: redact it with code. The model cannot browse, read paths, inspect images or recover missing facts.

## Never ask it to

Endorse your summary, choose an overall architecture or fix, do maths, counting or date comparisons, certify runtime behaviour or completion, infer unstated preferences, or authorise actions. Its probabilities are model judgments, not proof.
