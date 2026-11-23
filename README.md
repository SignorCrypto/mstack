# mstack

My daily setup for **Claude Code**, **Codex** and **Antigravity**: the skills I actually use (calling other models, council reviews, UI checks, fast triage, Vercel deploys), a small local `decision-model` MCP server, my global agent rules, and a helper for syncing multiple Claude accounts. One script installs and updates it.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/SignorCrypto/mstack/main/install.sh | bash
```

It clones (or updates) the repo into `~/.mstack`, links the skills into `~/.agents/skills`, the shared skills hub that Codex reads, and into every Claude Code profile; when Antigravity is installed its whole `~/.gemini/config/skills` becomes a link to the hub, so it sees everything installed there too, and registers the `decision-model` MCP server with each host's CLI (`claude`, `codex`, `agy`; Node.js 22+; skip with `--no-mcp`). Then every Claude profile and the hub get the union of their skills, so a skill installed anywhere later (by hand, `npx skills`) reaches every host on the next run: rerunning the installer is how you keep everything aligned. Your own instruction files are untouched unless you opt in with `--rules <file>` or `--personal`, and anything replaced is backed up to `~/.mstack-backup/`.

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
| [`agent-guardrails`](skills/agent-guardrails/SKILL.md) | Workflow | Guardrails for trusting agent-written code (inspired by Poteto) |
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

[`personal/AGENTS.md`](personal/AGENTS.md) holds the author's user-level rules that tie the skills together. It is the only copy: `personal/CLAUDE.md` is a symlink to it, and `--personal` links it under each host's own name (`CLAUDE.md` per Claude profile, `AGENTS.md` per Codex profile, `~/.gemini/AGENTS.md`), so every orchestrator follows the same rules. To share your own rules file the same way instead, use `--rules <file>` (e.g. `--rules ~/.claude/CLAUDE.md`):

- **Problem-first workflow** — root-cause reasoning, extending existing code over forking variants, before/after visuals, measured optimizations
- **Model routing** — cost/intelligence/taste matrix, default roles, and how to delegate across Claude, Codex, and Gemini Neon (T3 Code's delegation, or the `call-*` skills from a standalone CLI)
- **Tool & review discipline** — when to use triage, blocking waits instead of polling, and bounded two-pass review loops

They are **not installed by default**. Read and adapt them for your own setup, or link them directly with `--personal`:

```sh
./install.sh --personal
```

## Multiple accounts (profiles)

Claude Code (`CLAUDE_CONFIG_DIR`) and Codex (`CODEX_HOME`) can each have several installations. Antigravity has one `~/.gemini` per user.

- **Detection**: `install.sh` finds `~/.claude`, `~/.claude-*`, `~/.config/claude*`, `~/.codex` and `~/.codex-*`, shows each Claude profile's email and organization, and asks which to install into when there are several. Non-interactively: the env var, or `--claude-dir <path>` / `--codex-dir <path>` (repeatable). Every selected profile gets the skills, the decision-model MCP server and, with `--rules`/`--personal`, the rules.
- **What links cannot share**, opt-in and copied from the first selected Claude profile to the others:
  - `--align-profiles`: `settings*.json` (as links to the first profile's) and user-scope plugins with their marketplaces;
  - `--align-mcp`: user-scope MCP servers, via `claude mcp add-json` over stdin, never by editing `.claude.json` (it also holds each account's sign-in). Servers with `env`/`headers` may hold secrets: on a terminal you pick which to copy, otherwise they are skipped unless `--include-secrets`.
- Claude profiles keep per-skill links rather than one folder link because each keeps its own org-scoped `skills/synced/`; Codex's own `$CODEX_HOME/skills` is left to Codex (every Codex profile reads the hub).
- The `call-claude` and `call-codex` launchers take `--profile <dir>` to run on another account.

```sh
./install.sh --dry-run                               # preview, including the detected profiles
./install.sh --claude-dir ~/.claude --claude-dir ~/.claude-work --align-profiles --align-mcp
```
