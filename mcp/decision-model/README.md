# decision-model MCP

A local stdio MCP server with one tool, `Evaluate`: fast, cheap judgments (yes/no probability, choice,
score) over evidence the agent supplies, from a decision model you choose. Inference happens at the
provider. The server reads no web pages and only one kind of file: an `items_file` in a temp directory,
under the rules in [Items mode](#items-mode).

Default: Jev through Vercel AI Gateway, routed only to upstreams with zero data retention.

## Quick start

`install.sh` at the repo root installs and registers it. Then:

```sh
python3 setup-key.py AI_GATEWAY_API_KEY   # key for the default provider (OS keychain, hidden input)
node src/check-live.mjs                   # one real call (spends credits)
```

## Configure

Everything lives in `~/.config/decision-model/config.json`, shared by Claude Code, Codex, and Antigravity and read on
every call, so changes need no restart. The agent cannot override any of it.

```sh
node src/config.mjs                          # current choice, providers, where each key comes from
node src/config.mjs openrouter               # provider (with its default model)
node src/config.mjs vercel liquid/d1         # provider + model; pin versions here
node src/config.mjs --zdr on|off             # require zero data retention
node src/config.mjs --only a,b               # gateways: allowed upstreams (hard limit)
node src/config.mjs --order a,b              # gateways: preferred upstreams (still fail over)
node src/config.mjs --routing none           # clear order and only
node src/config.mjs --key NAME=/abs/cmd      # take key NAME from a command (NAME=none to stop)
```

Flags combine. Rules:

- **ZDR is a policy:** it survives a provider switch, and a provider that cannot enforce it per request
  refuses (the config command fails and the file stays as it was). When off, nothing is sent.
- **Model and routing belong to their provider:** ids and upstream names differ, so a switch drops them.

## Providers

All speak one format, System One (`state` + typed `questions`), so a provider is a row in
[`src/providers.mjs`](src/providers.mjs).

| Provider | Key | Default model | ZDR | Routing | Status |
|---|---|---|---|---|---|
| `vercel` (default) | `AI_GATEWAY_API_KEY` | `typesafe-ai/jev` | yes (paid plan or credits) | yes | verified |
| `openrouter` | `OPENROUTER_API_KEY` | `~typesafe/jev-latest` | yes | yes | unverified |
| `typesafe` | `TYPESAFE_API_KEY` | `jev-latest` | no (account-level only) | no | verified |
| `ollama` | none | none: pick one | yes (local) | no | unverified |

Unverified rows follow the provider's docs; run `node src/check-live.mjs <provider>` once with your key.
The gateways serve many decision models besides Jev (Liquid, Gemini Decisions, GPT-6 Luna Decisions,
Perplexity Decider, …). Keys: Vercel dashboard → AI Gateway → API keys,
[OpenRouter](https://openrouter.ai/settings/keys), [TypeSafe](https://console.typesafe.ai/keys).

## Keys

The server looks for a provider's key in this order:

1. **Environment** of the server process (`AI_GATEWAY_API_KEY`, …).
2. **A key command** set with `--key`: an executable (absolute path, no shell) run as `cmd NAME` that
   prints the key. This is how a secret manager plugs in. It runs on the first call, the key stays in
   memory, and a 401 (rotated key) reruns it once. A failing command is an error, not a fallback.
3. **OS keychain**, service `decision-model`, account = key name, stored with `python3 setup-key.py NAME`:
   the Keychain on macOS, the Secret Service (GNOME Keyring, KWallet; needs `secret-tool`) on Linux.
   On a machine without one, such as a headless server, use a key command or the environment.

Keys are never tool arguments, and the config refuses plain keys.

## Items mode

To label a collection through `state`, an agent has to read every item and then copy it into the call,
which costs more than reading the items itself. Items mode asks the same questions of each item and
keeps the collection out of the agent's context:

```json
{ "items_file": "/tmp/errors.log", "dedupe": "normalized", "context": "Production log lines from …",
  "questions": { "severity": { "type": "choice", "instructions": "How severe is …?", "criteria": { … } } } }
```

- **Sources:** `items_file` (`.jsonl`/`.ndjson`, a `.json` array, or any text file with one item per
  line) or `items` (an inline array). Ids are an object's `id` field as a string (not sent), else the line
  number (array position for `.json`) as a number.
- **Grouping:** `dedupe: "exact"` (default) evaluates identical items once. `"normalized"` also groups
  items that differ only in dates and times, UUIDs, hex, the id part of prefixed ids (`evt_1Q…`, prefix
  kept) and numbers; a standalone `0` (`0 rows`), id prefixes and the structure are kept. The first real
  item of a group is sent and its answer covers the group; `results_file` lists up to 3 `variants` per
  group. When another number decides the answer (HTTP status, a size against a limit), use `exact` or
  group with your own key. On 400 production-like log lines: 30 groups, 1.5 s, 14k tokens, against
  `exact` 400 requests, 9 s, 189k tokens.
- **Work:** distinct items are packed about 10 per request (packing thresholds: 50 questions and 24k
  characters of item JSON; an item that does not fit goes alone; the provider's token budget applies to
  the whole request), each question asked once per item under `items.item_N`.
  Measured on 298 support messages: 1.6 s and 129k input tokens, against 5 s and 200k with one item per
  request, at the same accuracy (96%; 98% identical labels); on 400 normalized log lines 7k tokens
  instead of 14k. A batch the provider refused without processing it (HTTP 400/413/422, not billed) goes back in the
  queue as single items; a dropped connection or a rate limit is not resent item by item, since that
  request may have been processed and billed. `usage` sums accepted responses; `metadata.requests`
  counts the requests the server started (transport retries on 429/529 inside one request are not
  counted). Requests go one at a
  time until one succeeds (at most 5, each with the retry policy below: a provider that fails every
  request gets 5, not 50), then 20 in parallel (400 requests at
  20 drew no rate limit). At most 500 distinct items and a 50 s budget from the start of the call
  (reading included), under Codex's default 60 s tool timeout; items not reached are `skipped`. An error
  whose cause is not the evidence (key, config, HTTP 401/402/403/404) is typed fatal where it is raised
  and stops the call; any other error is recorded on its item. When no item succeeds the call is an
  error that says how many failed, how many were not sent, and why it stopped. Errors name items by
  their source position (`line 12`), never by their id.
- **Result:** per-question `counts` (items, duplicates included), `uncertain_ids` (Noul between 0.3 and
  0.7, TypeSafe's suggested band; Choice/Score confidence below 0.5; first 50, `uncertain_total` beyond), inline `results` up to 20
  distinct items, and `results_file`: JSONL in the temp directory (mode 0600), one line per group with
  `ids`, `item`, full `answers` (or `error` / `skipped`). One provider config per call. Progress
  notifications are sent when the client asks for them.
- **Which files:** only an absolute path in the temp directories (`/tmp`, `$TMPDIR`) or a directory the
  user lists in `DECISION_MODEL_ALLOWED_DIRS` (path-separated) in the server environment. Not the
  project: a file there is copied or extracted to `/tmp` first, a deliberate act, so a path slipped into a
  prompt cannot point the tool at a secret. Symlinks are resolved, the checked file is the one read
  (same inode, no symlink at the last step), non-regular files and files over 10 MB are refused.
- **Credentials:** in both modes, evidence matching a credential shape (private key, AWS, GitHub, `sk-`,
  Stripe live, Slack, Vercel keys, JWTs) is refused before anything is sent, every group member included.

## Reference

**Result:** per question `noul` (probability of yes), `choice` (+ distribution, confidence) or `score`
(+ distribution, confidence, legend if the provider sends it). Plus `model` (the one that answered),
`usage`, and `metadata`: `provider`, `requested_model`, `zdr_requested`, `routing`, `served_by` (the
upstream the gateway reports), `elapsed_ms`, `attempts`. How to ask well: the `decision-model` skill.

**Limits:** context depends on the model (Jev: 64k tokens, 32k for state + longest question); 2 MB per
request locally, never truncated. 45 s per request, key lookup included (items mode: 50 s per call); up to three attempts on 429/529 within the deadline; no
retry on invalid requests or uncertain submissions.

**Validation:** every judgment field is checked (ids, options, ranges, distributions). A gateway's
language-model fallback, which returns an empty distribution, is rejected. Content, keys and provider
error bodies are never logged.

**By hand:** `npm ci --omit=dev --ignore-scripts`, then
`claude mcp add --scope user --transport stdio decision-model -- "$(command -v node)" "$PWD/src/server.mjs"`
(and `codex mcp add decision-model -- …` / `agy mcp add decision-model -- …` likewise).

**New provider:** if it speaks System One, add a row to `src/providers.mjs` and to the table above.

**Tests:** `npm test`.
