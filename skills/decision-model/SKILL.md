---
name: decision-model
description: When and how to use a decision model (the `decision-model` MCP's Evaluate tool) for first-pass semantic classification, filtering, scoring and triage of supplied text or record collections, and how to combine its judgments in code. Load before any Evaluate call. Not for routine planning, architecture choices, debugging conclusions, or completion approval.
---

# Decision model

A decision model returns fast, cheap semantic judgments (a yes probability, a choice among options, a score on ordered levels) over evidence you supply. It replaces repeated reading, not thinking: use it to shrink a collection before you analyse it, never to make the final call.

## Format and configuration

Every provider speaks one question format, System One: read [system-one.md](system-one.md) before the first call. The user picks the provider and model (by default Jev through Vercel AI Gateway with zero data retention; also TypeSafe direct, OpenRouter, local Ollama); the result's `model` says which one answered. You cannot choose the model per call. Zero data retention and upstream routing are the user's config too: if a call fails for a missing key, a model, or a provider that cannot enforce ZDR, tell the user the fix the error names (`node src/config.mjs`, `setup-key.py`) instead of retrying or working around it.

## When it pays

Consider it when a collection needs the same semantic judgment many times and the labels could reduce your work. The examples are not exhaustive:

- **Emails:** independently flag marketing, spam, phishing indicators, urgency, or a request for a reply. A link judgment needs the actual targets; a familiar-sender judgment needs contact evidence.
- **Large log collections:** classify error families and score severity on defined levels to shortlist incidents. You diagnose the causes.
- **Retrieved passages or documents:** classify topic or type, filter relevance, or flag whether a passage supports a supplied claim. You verify the shortlist.

A one-off check needs a concrete triage benefit or an explicit request. Skip explicit answers, anything code can compute, and routine checkpoints.

## The pattern

retrieve/filter → decision model labels/scores → code aggregates/routes → you investigate/verify.

- **One item, several dimensions:** an email can be marketing, urgent and potentially phishing at once. Ask a separate question per dimension and batch independent questions about the same evidence in one call; the same goes for logs, documents, commits or other records.
- **Combine in code:** weights, thresholds and routing rules are deterministic code you write for the task. Never ask the model to collapse everything into "what should I do?".
- **Uncertainty means inspection:** an uncertain or borderline result goes to you, not to a threshold.
- **Reuse** evaluations whose evidence and criteria have not changed.

## Asking well

- **Supply the evidence:** the original text or JSON that matters. The model cannot browse, read paths, inspect images or recover missing facts.
- **One simple judgment per question**, with explicit criteria.
- **Self-contained questions:** name the exact item in the question text; question ids are not visible to the model.
- **Viable alternatives:** distinct options, plus an explicit "unknown"/"insufficient evidence" one where it may apply.
- **Data:** what you send leaves the machine for the provider. Respect data restrictions and never include credentials.

## Never ask it to

Endorse your summary, choose an overall architecture or fix, do maths, counting or date comparisons, certify runtime behaviour or completion, infer unstated preferences, or authorise actions. Its probabilities are model judgments, not proof.
