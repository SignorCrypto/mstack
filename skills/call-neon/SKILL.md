---
name: call-neon
description: How to call Neon (Google's Gemini Neon, through the Antigravity CLI `agy`) from Claude Code - the exact launcher commands for investigation, review, optimization and copy, OS-enforced read-only and workspace-write sandboxes, background runs, and what never to use. Which tasks go to Neon is CLAUDE.md's call. Load it before ANY Neon call from Claude Code, from any skill, agent, or workflow.
argument-hint: "<task, or 'review'>"
---

# Call Neon

Every rule for calling Neon from Claude Code lives here. Under T3 Code, use T3's delegation instead (Antigravity provider, effort option `thought_level`).

All calls go through the local launcher, which applies the defaults and the sandbox:

```bash
N="$HOME/.claude/skills/call-neon/neon.sh"
```

Setup, once per machine: `curl -fsSL https://antigravity.google/cli/install.sh | bash` (installs `~/.local/bin/agy`; read the script first), then sign in by running `agy` once in a terminal. `agy models` lists the catalog when signed in.

## What the launcher does

- **Model**: the newest `gemini-*-neon` in `agy models`, resolved live. `--model` takes another family (`argon`, `hydrogen`) or an exact base id (`gemini-4-neon`); an unknown name or unreadable catalog is an error, never a guess.
- **Effort**: `high`. Pass `--effort <low|medium|high|xhigh|max>` only if the user asks for another level.
- **Sandbox**, enforced by macOS `sandbox-exec`, not by the agent's own rules (those only cover its file tool, and shell redirection bypasses them):
  - default **read-only**: no writes anywhere except agy's state (`~/.gemini`, `~/.cache/antigravity`) and the user temp/cache dirs;
  - `--write` **workspace-write**: also the working dir (`--cwd`, default the current one), its git common dir (so commits from a worktree work) and every `--add-dir`.
  Inside the sandbox every tool call is auto-approved: headless agy cannot prompt, and one denied call ends the turn with no output.
- **Refuses**: a missing or empty `--prompt-file` (it never reads stdin), an unknown option or model.
- **Prints** one line on stderr before starting, e.g. `neon launcher: gemini-4-neon effort=high sandbox=read-only cwd=...`, then the response, then one JSON line `{"ok", "status", "conversation_id", "duration_s", "usage"}`. Exit 1 when the turn failed, came back empty or had denied actions.
- `--dry-run` prints the resolved model, sandbox and writable paths without starting agy.

## How to call

Call the launcher from Bash, with `run_in_background: true` (you are notified when it exits, no polling). Write the prompt to a file in the scratchpad. Do not call raw `agy -p`: it skips the sandbox, and in headless mode its permission rules either deny a call (empty result) or, with `--dangerously-skip-permissions`, allow everything. `--sandbox` does not restrict the filesystem.

**Investigation, questions, review** (read-only):

```bash
"$N" --prompt-file <scratchpad>/prompt.md --cwd <repo>
```

For a review, put the scope in the prompt (`git diff main...HEAD`, the files, the product constraints): there is no built-in review command. Verify every finding against the code before applying it.

**Optimization, copy, implementation** (workspace-write):

```bash
"$N" --write --prompt-file <scratchpad>/prompt.md --cwd <repo or worktree>
```

A self-contained prompt: the owned paths, the exact verify commands, and for optimizations the metrics to measure before and after, the same way. One task per disjoint file area. Then verify yourself (diff, typecheck, tests, build; rerun the measurements): the self-report is optimistic.

`--resume <conversation_id>` continues an earlier turn (the id is in the JSON line).

## Sandbox limits

Network is open. Writes outside the writable paths fail with `operation not permitted`: package installs and tools that write to `~/.npm`, `~/Library/pnpm` or other home caches. Install dependencies yourself before the call, or pass the cache with `--add-dir` together with `--write`.

## Visibility and troubleshooting

When a subagent or Workflow stage delegates to Neon, prefix its user-visible name with the model id from the `neon launcher:` line: "gemini-4-neon: optimize image pipeline". Never use a remembered id.

If the catalog cannot be read, agy is not signed in: tell the user to run `agy` once in a terminal.
