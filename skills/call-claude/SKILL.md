---
name: call-claude
description: How to call Claude (opus, fable, sonnet, haiku, through headless Claude Code `claude -p`) from outside T3 Code and outside Claude Code itself (e.g. Codex CLI or Antigravity) - the exact launcher commands for implementation, investigation, review, judgment calls and copy, OS-enforced read-only and workspace-write sandboxes, account profiles, background runs, and what never to use. Which tasks go to which Claude model is set by the global rules. Load it before ANY Claude call via `claude -p`, from any skill, agent, or workflow.
argument-hint: "[opus|fable|sonnet|haiku] <task, or 'review'>"
---

# Call Claude

Every rule for calling Claude from another CLI lives here. Under T3 Code, use T3's delegation instead (Claude provider, effort option `effort`). Inside Claude Code, use its own Agent tool.

All calls go through the local launcher, which applies the defaults and the sandbox:

```bash
C="$HOME/.agents/skills/call-claude/claude.sh"
```

Setup, once per machine: install Claude Code and sign in by running `claude` once in a terminal. Calls run on that account's subscription.

## What the launcher does

- **Model**: `opus`. `--model` takes another alias (`fable`, `sonnet`, `haiku`), which Claude Code resolves to the latest version, or a full `claude-*` id.
- **Effort**: `high`. Pass `--effort <low|medium|high|xhigh|max>` only if the user asks for another level.
- **Profile**: the current `CLAUDE_CONFIG_DIR` (default `~/.claude`). `--profile <dir>` runs on another Claude account (e.g. `~/.claude-work`).
- **Sandbox**, enforced by macOS `sandbox-exec`, not by the agent's own rules:
  - default **read-only**: no writes anywhere except Claude Code's own state (`~/.claude*`, its caches, `/private/tmp/claude-*`) and the user temp/cache dirs;
  - `--write` **workspace-write**: also the working dir (`--cwd`, default the current one), its git common dir (so commits from a worktree work) and every `--add-dir`.
  Inside the sandbox permission prompts are off (`bypassPermissions`): headless mode cannot prompt, so the OS profile is the boundary.
- **Clean session**: it drops the variables a parent Claude Code session exports, so the call is a fresh top-level session with the profile's own CLAUDE.md, skills and MCP servers.
- **Refuses**: a missing or empty `--prompt-file`, an unknown option, a malformed model name.
- **Prints** one line on stderr before starting, e.g. `claude launcher: opus effort=high sandbox=read-only profile=... cwd=...`, then the response, then one JSON line `{"ok", "status", "model", "session_id", "duration_s", "usage"}`; `model` is the resolved id. Exit 1 when the turn failed, came back empty or had permission denials.
- `--dry-run` prints the model, sandbox and writable paths without starting Claude.

## How to call

Call the launcher from your shell tool as a background run when the host supports it (you are notified when it exits, no polling). Write the prompt to a file in your scratchpad or temp dir. Do not call raw `claude -p`: without the sandbox it either cannot act (headless permission prompts are denied) or, with `--dangerously-skip-permissions`, can write anywhere.

**Investigation, questions, review, judgment calls** (read-only):

```bash
"$C" --prompt-file <tmp>/prompt.md --cwd <repo>                      # opus
"$C" --model fable --prompt-file <tmp>/prompt.md --cwd <repo>        # advisor
```

For a review, put the scope in the prompt (`git diff main...HEAD`, the files, the product constraints). For a judgment call, give the options, the constraints and what you already ruled out, and ask for a recommendation. Verify every finding against the code before applying it.

**Implementation, copy** (workspace-write):

```bash
"$C" --write --prompt-file <tmp>/prompt.md --cwd <repo or worktree>
```

A self-contained prompt: the owned paths, the exact verify commands, what is out of scope. One task per disjoint file area. Then verify yourself (diff, typecheck, tests, build): the self-report is optimistic.

`--resume <session_id>` continues an earlier turn (the id is in the JSON line).

## Sandbox limits

Network is open. Writes outside the writable paths fail with `operation not permitted`: package installs and tools that write to `~/.npm`, `~/Library/pnpm` or other home caches. Install dependencies yourself before the call, or pass the cache with `--add-dir` together with `--write`.

## Visibility and troubleshooting

When a subagent or workflow stage delegates to Claude, prefix its user-visible name with the resolved model id from the JSON line ("claude-opus-5-5: refactor auth"). Never use a remembered id.

`status: "error_during_execution"` or an auth error: the profile is not signed in; tell the user to run `claude` once in a terminal (with `CLAUDE_CONFIG_DIR=<profile>` for another account).
