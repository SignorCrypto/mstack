# mstack

Skills and a decision-model MCP server for Claude Code and Codex, set up by one installer.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/SignorCrypto/mstack/main/install.sh | bash
```

Add `-s -- --dry-run` after `bash` to preview the changes to your setup (it still downloads the repo). It clones the repo into `~/.mstack`, links
the skills into both clients and registers the MCP server (Node.js 22+; skip with `--no-mcp`). Your own
`CLAUDE.md` / `AGENTS.md` are never touched, and anything replaced is moved to `~/.mstack-backup/`.

**Update:** run the same command again.

## What's inside

### Skills

| Skill | What it does |
|---|---|
| `call-codex` | How to call Codex models: commands, review, image generation |
| `council` | Opinions and scores from several models, optional fix loop |
| `ui-review` | Council review of a running app's UI |
| `ui-before-after` | Annotated before/after screenshots of a UI change |
| `vercel-wait-deploy` | Block until a pushed commit's Vercel deployments finish |
| `decision-model` | When and how to use the decision model for triage |
| `poteto-guardrails` | Poteto's guidelines for trusting agent-written code |

They are written for the author's setup (Codex CLI, Vercel, model names): read one before relying on it.

### Decision model MCP

One tool, `Evaluate`: fast, cheap judgments (yes/no, choice, score) from a decision model. By default Jev
through Vercel AI Gateway with zero data retention; TypeSafe, OpenRouter and Ollama also work. To start:

```sh
cd ~/.mstack/mcp/decision-model
python3 setup-key.py AI_GATEWAY_API_KEY   # store the key (macOS Keychain / Linux Secret Service)
node src/check-live.mjs                   # one real call
```

Providers, models, ZDR, routing and key sources: [mcp/decision-model/README.md](mcp/decision-model/README.md).
