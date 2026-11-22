# mstack

My daily setup for **Claude Code**, **Codex** and **Antigravity**: the skills I actually use (calling other models, council reviews, UI checks, fast triage, Vercel deploys), a small local `decision-model` MCP server, my global agent rules, and a helper for syncing multiple Claude accounts. One script installs and updates it.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/SignorCrypto/mstack/main/install.sh | bash
```

It clones (or updates) the repo into `~/.mstack`, links the skills into `~/.agents/skills`, the shared skills hub that Codex reads, and into every Claude Code profile; when Antigravity is installed its whole `~/.gemini/config/skills` becomes a link to the hub, so it sees everything installed there too, and registers the `decision-model` MCP server with each host's CLI (`claude`, `codex`, `agy`; Node.js 22+; skip with `--no-mcp`). Your own instruction files are untouched unless you opt in with `--personal`, and anything replaced is backed up to `~/.mstack-backup/`.

Preview changes first with `-s -- --dry-run`. Run the same command again to update.

## Skills

> Built around the author's toolchain (Claude Code, Codex CLI, Antigravity CLI, Vercel). Read a skill before relying on it. Skill scripts are referenced through `~/.agents/skills/`, which the installer always populates, so the same paths work from every host. The `call-*` launchers share an OS write sandbox in [`lib/sandbox.sh`](lib/sandbox.sh), so install from a full checkout rather than copying a single skill.

| Skill | Type | What it does |
|---|---|---|
| [`call-claude`](skills/call-claude/SKILL.md) | Models | Run Claude (opus, fable, …) from another CLI via `claude -p` in an OS sandbox |
| [`call-codex`](skills/call-codex/SKILL.md) | Models | Run Codex from another CLI (tasks, review, images) |
| [`call-antigravity`](skills/call-antigravity/SKILL.md) | Models | Run Gemini Neon (or any `agy` model) from another CLI in an OS sandbox |
| [`council`](skills/council/SKILL.md) | Review | Multi-model 1–10 opinions and fix-until-N loops |
| [`ui-review`](skills/ui-review/SKILL.md) | UI | Multi-model UI/UX review from real app captures |
| [`ui-before-after`](skills/ui-before-after/SKILL.md) | UI | Annotated before/after screenshots with measured gains |
| [`decision-model`](skills/decision-model/SKILL.md) | Workflow | Fast semantic triage over large text collections |
| [`poteto-guardrails`](skills/poteto-guardrails/SKILL.md) | Workflow | Guardrails for trusting agent-written code |
| [`vercel-wait-deploy`](skills/vercel-wait-deploy/SKILL.md) | Workflow | Wait for a commit's Vercel builds without polling |

## Decision-model MCP

A local stdio MCP server with one tool, `Evaluate`, for fast, cheap semantic judgments (yes/no probability, choice, score). Defaults to Jev via Vercel AI Gateway with zero data retention; OpenRouter, TypeSafe, and Ollama are also supported.

```sh
cd ~/.mstack/mcp/decision-model
python3 setup-key.py AI_GATEWAY_API_KEY   # store key in OS keychain
node src/check-live.mjs                   # one real call to verify
```

Providers, ZDR policy, routing, and key sources: [mcp/decision-model/README.md](mcp/decision-model/README.md).

## Personal instructions (`personal/`)

[`personal/AGENTS.md`](personal/AGENTS.md) holds the author's user-level rules that tie the skills together. It is the only copy: `personal/CLAUDE.md` is a symlink to it, and `--personal` links it under each host's own name (`CLAUDE.md` per Claude profile, `~/.codex/AGENTS.md`, `~/.gemini/AGENTS.md`), so every orchestrator follows the same rules:

- **Problem-first workflow** — root-cause reasoning, extending existing code over forking variants, before/after visuals, measured optimizations
- **Model routing** — cost/intelligence/taste matrix, default roles, and how to delegate across Claude, Codex, and Gemini Neon (T3 Code's delegation, or the `call-*` skills from a standalone CLI)
- **Tool & review discipline** — when to use triage, blocking waits instead of polling, and bounded two-pass review loops

They are **not installed by default**. Read and adapt them for your own setup, or link them directly with `--personal`:

```sh
./install.sh --personal
```

## Multiple Claude Code accounts

If you use multiple Claude Code profiles via `CLAUDE_CONFIG_DIR` (e.g. `~/.claude` and `~/.claude-*`):

- **`install.sh`** auto-detects installed profiles (showing email and organization) and asks which ones to install into. Target profiles non-interactively with `CLAUDE_CONFIG_DIR=<path>` or `--claude-dir <path>` (repeatable).
- **[`sync-claude-profiles.sh`](sync-claude-profiles.sh)** syncs skills (including external ones, never touching Claude's org-scoped `synced/` dir), `CLAUDE.md`, `settings*.json`, user-scope MCP servers (via `claude mcp add-json` over stdin, flagging servers with `env`/`headers`), and user-scope plugins across profiles on demand. With `--hosts` skills meet in the hub in both directions (skills installed only in Claude reach Codex and Antigravity, skills installed only in the hub, e.g. with `npx skills`, reach Claude; same-named different skills are reported, never replaced), and `CLAUDE.md` goes to Codex and Antigravity as their `AGENTS.md`. Claude profiles keep per-skill links rather than one folder link because each keeps its own org-scoped `skills/synced/`:

```sh
./sync-claude-profiles.sh                         # interactive wizard
./sync-claude-profiles.sh --all --dry-run         # preview a full sync (includes --hosts)
./sync-claude-profiles.sh --skills --hosts        # skills into the other profiles, Codex and Antigravity
```
