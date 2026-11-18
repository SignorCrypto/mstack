---
name: call-codex
description: How to call Codex (Sol by default, Astra only on request; ids resolved live from the Codex catalog) from Claude Code - which model when, the exact commands for investigation, implementation, review, and image generation (latest ChatGPT Images model via subscription), background runs, sandbox limits, and what never to use. Single source of truth for Codex calls. Load it before ANY Codex call, from any skill, agent, or workflow.
argument-hint: "[sol|astra] <task, or 'review' / 'adversarial-review' / 'image'>"
---

# Call Codex

Every rule for calling Codex lives here. Other skills and CLAUDE.md point to this file and do not repeat it.

All calls go through the local launcher, which applies the defaults and refuses what is forbidden, so this file only says when and what to call:

```bash
C="$HOME/.claude/skills/call-codex/codex-companion.mjs"
```

## Models

| family | role |
|--------|------|
| `sol` | **the default for every Codex call** (investigation, review, smoke tests) |
| `astra` | opt-in only: never chosen on your own initiative |

Codex does not implement by default: Opus does (see CLAUDE.md). **Astra never implements**: it is read-only (investigation, review).

**Always use `sol`**, whatever the task touches (money, auth, migrations, concurrency, size, difficulty: none of these is a reason to switch). Use `astra` only when:
1. the user explicitly asks for it in this conversation, or
2. a `sol` result on this same task was concretely insufficient (name what was missing); then rerun once with `astra` and say so in the report.

A skill or memory suggesting `astra` does not count as the user asking.

To see the live catalog (ids, context, reasoning levels): `python3 ~/.claude/skills/call-codex/models.py`. If the catalog shows a family's role no longer fits (e.g. descriptions change), tell the user.

## What the launcher does

- **Model**: `sol` unless `--model` says otherwise. `--model` takes a family (`sol`, `astra`) or an exact id; it is resolved live from the Codex catalog, and an unknown name or unreadable catalog is an error, never a guess.
- **Fast tier** (2x speed, more subscription usage): on for `sol`, off for anything else. `--no-fast` turns it off, `--fast` turns it on for `astra` (only when the user asks). `config.toml` keeps `service_tier = "default"`, so interactive Codex is unaffected.
- **Effort**: `high` on tasks and reviews alike, never `config.toml`'s value (Codex Desktop rewrites it). Pass `--effort <none|minimal|low|medium|high|xhigh>` only if the user asks for another level.
- **Refuses**: `--background` (it needs a polling loop), `--write` with `astra`, and a `task` without `--prompt-file` or a prompt (also with `--resume-last`): the launcher never reads stdin.
- **Reviews are persistent** (`ephemeral: false`), so Codex saves the full session (prompts, responses, token usage) in its logs and AgentBar counts it.
- **No shared broker**: each call starts its own `codex app-server`, which exits with the call. The plugin's broker is shut down only by the SessionEnd hook of a session in the same folder, so calls from worktrees, the scratchpad or any other folder used to leave `app-server-broker` processes running.
- **Prints one line on stderr** before starting, e.g. `codex launcher: gpt-6.2-sol fast effort=high sandbox=read-only`: the resolved id and tier, for naming stages (see Visibility).
- `--dry-run` prints the resolved command as JSON without starting Codex; `node "$C" --launcher-check` checks the plugin hooks.

## How to call

Call the launcher from Bash. Do not use:
- the `/codex:*` slash commands: the review ones are `disable-model-invocation` (you cannot launch them) and the others ask interactive questions;
- the `codex:codex-rescue` agent: a Sonnet forwarding wrapper that defaults to `--write`, and inside a Workflow it returns as soon as the job is queued, without a result;
- the plugin's companion script or raw `codex exec` directly: they skip the launcher. If direct CLI diagnostics are unavoidable, close stdin with `</dev/null` and do not buffer output through `tail`.

Every call: run it at parent level with Bash `run_in_background: true` (you are notified when it exits, no polling; a foreground Bash is capped at 10 minutes). Inside a Workflow, run Codex as a parent-level stage, never through a Claude wrapper. Long MCP-style blocking is not an alternative: in the desktop app a long tool call blocks the turn.

**Investigation / exploration / one-shot questions** (read-only sandbox). Write the prompt to a file in the scratchpad to avoid shell quoting issues:

```bash
node "$C" task --fresh --prompt-file <scratchpad>/prompt.md
```

**Implementation, migrations, tests**: only when the user explicitly asks Codex to write code, and only with `sol`: same command plus `--write`. One task per disjoint file area (list the owned paths explicitly; parallel tasks in one worktree only if their file sets do not overlap), a self-contained prompt with the exact verify commands and a JSON summary format. Then verify the result yourself (diff, typecheck, tests, build): Codex's self-report is optimistic.

`--resume-last` continues the previous task in this repo instead of `--fresh` (still with a prompt).

**Review**:

```bash
node "$C" review
node "$C" adversarial-review "<focus: e.g. auth checks and data loss paths>"
```

Scope defaults to `auto` (working tree if dirty, else branch vs base; untracked files included). Pass `--base <ref>` to review a branch, or `--scope working-tree|branch` to force one. `review` accepts no focus text: use `adversarial-review` when you need to steer it. Verify every finding against the code before applying it.

To confirm a run used the Fast tier: `python3 ~/.claude/skills/call-codex/tier.py <thread-id>` (the id from "Thread ready (...)") prints the tier per thread, `priority` = Fast. A review's parent thread shows `[]`: the reviewer runs in a child thread, listed with its own tier.

## Image generation

Codex's built-in `image_gen` tool generates and edits images on the ChatGPT subscription. The image model is chosen by OpenAI server-side: the tool has no model argument, so it always gets the latest model OpenAI rolls out to Codex (ChatGPT Images 2.5 since 2026-09-08; the CLI binary still carries a `gpt-image-2` label, and C2PA metadata only says `gpt-image`). It works in the read-only sandbox. Use it for raster images (photo, illustration, texture, sprite, product shot), standalone or as a piece of a larger composition. Compositions, layouts, SVG, icons, and diagrams are Claude's own work, not Codex's.

Always go through the bundled wrapper: it resolves the `sol` id, runs the launcher without the Fast tier and with `config.toml`'s effort (reasoning barely matters here), finds the file on disk under `~/.codex/generated_images/<thread-id>/` (never trust Codex's reported path), and copies it to `--out`. Same rules as any Codex call: Bash `run_in_background: true`, prompt in a scratchpad file.

```bash
I=~/.claude/skills/call-codex/image.py
python3 $I --prompt-file <scratchpad>/img.md --out <project>/assets/hero.png
python3 $I --prompt-file <scratchpad>/img.md --out icon.png --transparent           # transparent background
python3 $I --prompt-file <scratchpad>/img.md --out hero-v2.png --ref /abs/hero.png  # edit / reference (repeatable)
python3 $I --prompt-file <scratchpad>/img.md --out concept.png --n 3                # concept-1..3.png, one call each
```

- Output is PNG only. The prompt file holds just the visual request (subject, style, exact text in quotes, what to avoid); the wrapper adds the tool instructions.
- `--ref` takes local files; say in the prompt whether each is the edit target or a style/composition reference.
- It never overwrites: pick a versioned name (`hero-v2.png`) unless the user asked to replace, then pass `--overwrite`.
- Result: one JSON line with `files`. Open each with Read and check it before reporting. Each image takes ~30–60 s.
- No size, quality, or model controls: crop/resize afterwards (PIL is installed).

## Sandbox limits

No network (the caller runs `npx convex codegen` and anything that fetches) and no IPC sockets (`npx tsx --test` fails, tell Codex to use `node --import tsx --test`; `git mv` may fail, plain `mv` + `git add -A` is fine).

## Visibility and troubleshooting

When a subagent or Workflow stage delegates to Codex, prefix its user-visible name with the model id plus `fast` when the Fast tier is on, as printed by the launcher's `codex launcher:` line or by `--dry-run`: "gpt-6.2-sol fast: review auth changes", "gpt-6.2-astra: review auth changes". Never use a remembered id.

If a call fails with a setup or auth error, run `node "$C" setup --json` and report what it says.
