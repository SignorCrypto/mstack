# decision-model MCP

A local stdio MCP server with one tool, `Evaluate`: fast, cheap judgments (yes/no probability, choice,
score) over evidence the agent supplies, from a decision model you choose. Inference happens at the
provider; the server never reads files or web pages.

Default: Jev through Vercel AI Gateway, routed only to upstreams with zero data retention.

## Quick start

`install.sh` at the repo root installs and registers it. Then:

```sh
python3 setup-key.py AI_GATEWAY_API_KEY   # key for the default provider (OS keychain, hidden input)
node src/check-live.mjs                   # one real call (spends credits)
```

## Configure

Everything lives in `~/.config/decision-model/config.json`, shared by Claude Code and Codex and read on
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

## Reference

**Result:** per question `noul` (probability of yes), `choice` (+ distribution, confidence) or `score`
(+ distribution, confidence, legend if the provider sends it). Plus `model` (the one that answered),
`usage`, and `metadata`: `provider`, `requested_model`, `zdr_requested`, `routing`, `served_by` (the
upstream the gateway reports), `elapsed_ms`, `attempts`. How to ask well: the `decision-model` skill.

**Limits:** context depends on the model (Jev: 64k tokens, 32k for state + longest question); 2 MB per
request locally, never truncated. 45 s per call; up to three attempts on 429/529 within the deadline; no
retry on invalid requests or uncertain submissions.

**Validation:** every judgment field is checked (ids, options, ranges, distributions). A gateway's
language-model fallback, which returns an empty distribution, is rejected. Content, keys and provider
error bodies are never logged.

**By hand:** `npm ci --omit=dev --ignore-scripts`, then
`claude mcp add --scope user --transport stdio decision-model -- "$(command -v node)" "$PWD/src/server.mjs"`
(and `codex mcp add decision-model -- …` likewise).

**New provider:** if it speaks System One, add a row to `src/providers.mjs` and to the table above.

**Tests:** `npm test`.
