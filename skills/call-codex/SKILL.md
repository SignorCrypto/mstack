---
name: call-codex
description: How to call Codex from another CLI such as Claude Code or Antigravity, through the Codex CLI alone (`codex exec`; model ids resolved live from the Codex catalog; which model to use is set by the global rules) - the exact commands for investigation, implementation, review, adversarial review and image generation (latest ChatGPT Images model via subscription), background runs, sandbox limits, and what never to use. Single source of truth for Codex calls. Load it before ANY Codex call, from any skill, agent, or workflow.
argument-hint: "[sol|astra] <task, or 'review' / 'adversarial review' / 'image'>"
---

# Call Codex

Every rule for calling Codex lives here. Other skills and the global rules point to this file and do not repeat it. Under T3 Code, use T3's delegation instead (Codex provider, effort option `reasoningEffort`, Fast tier `serviceTier: "priority"`).

All calls go through the local launcher, which applies the defaults and refuses what is forbidden, so this file only says when and what to call. It needs only the Codex CLI, signed in (`codex` once in a terminal):

```bash
C="$HOME/.agents/skills/call-codex/codex.sh"
```

## Models

Which model to call, and for what, is set by the global rules; this file only says how. With no `--model`, the launcher uses `sol`.

To see the live catalog (ids, context, reasoning levels): `python3 ~/.agents/skills/call-codex/models.py`. If the catalog shows a family's role no longer fits (e.g. descriptions change), tell the user.

## What the launcher does

- **Model**: `sol` unless `--model` says otherwise. `--model` takes a family (`sol`, `astra`) or an exact id; it is resolved live from the Codex catalog, and an unknown name or unreadable catalog is an error, never a guess.
- **Fast tier** (2x speed, more subscription usage): on for `sol`, off for anything else. `--no-fast` turns it off, `--fast` turns it on for the others. It is passed per call, so `config.toml` keeps `service_tier = "default"` and interactive Codex is unaffected.
- **Effort**: `high` on tasks and reviews alike, never `config.toml`'s value (Codex Desktop rewrites it). Pass `--effort <level>` only if the user asks for another level; a level the model does not list in the catalog is an error. `--effort config` keeps `config.toml`'s.
- **Sandbox**: Codex's own (Seatbelt on macOS), read-only by default; `--write` is workspace-write: the working dir (`--cwd`), every `--add-dir` and the user temp dir, not the shared `/tmp`. Approvals are off (`never`): a headless call cannot prompt.
- **Refuses**: `--write` with `astra` or on a review, a task without a non-empty `--prompt-file` (it never reads the caller's stdin), unknown options.
- **Sessions are saved** (never `--ephemeral`), so every call shows up in Codex's history with its prompts, responses and token usage.
- **Prints** one line on stderr before starting, e.g. `codex launcher: gpt-6.2-sol fast effort=high sandbox=read-only cwd=...`: the resolved id and tier, for naming stages (see Visibility). Then the final message, then one JSON line `{"ok", "thread_id", "model", "fast", "usage"}`. Exit 1 when the turn failed or came back empty.
- `--dry-run` prints the resolved model, tier, effort and the exact `codex` command without starting it.

## How to call

Call the launcher from your shell tool. Do not use the Codex plugin's `/codex:*` commands or its `codex:codex-rescue` agent (when installed in Claude Code), or raw `codex exec`: they skip the launcher's defaults.

Every call: run it as a background shell run when the host supports it (Bash `run_in_background: true` in Claude Code: you are notified when it exits, no polling; a foreground Bash is capped at 10 minutes). Inside a Workflow, run Codex as a parent-level stage, never through a Claude wrapper. Write the prompt to a file in the scratchpad or temp dir.

**Investigation / exploration / one-shot questions** (read-only):

```bash
"$C" --prompt-file <scratchpad>/prompt.md --cwd <repo>
```

**Implementation, migrations, tests**: only when the user explicitly asks Codex to write code: same command plus `--write` (refused with `astra`). One task per disjoint file area (list the owned paths explicitly; parallel tasks in one worktree only if their file sets do not overlap), a self-contained prompt with the exact verify commands and a JSON summary format. Then verify the result yourself (diff, typecheck, tests, build): Codex's self-report is optimistic.

`--resume <thread_id>` continues an earlier task (the id is in the JSON line), still with a `--prompt-file`.

**Review** (Codex's built-in reviewer, read-only):

```bash
"$C" review --cwd <repo>                                              # plain review
"$C" review --prompt-file <scratchpad>/focus.md --cwd <repo>          # with focus
"$C" review --adversarial --prompt-file <scratchpad>/focus.md --cwd <repo>
```

- Scope: `--uncommitted`, `--base <ref>` or `--commit <sha>`; with none, the working tree if dirty (untracked files included), else the branch against the default branch.
- `--adversarial` prepends [adversarial.md](adversarial.md): concrete failure scenarios, ranked by impact. The focus file names the areas (e.g. auth checks and data loss paths) and the product constraints.
- Verify every finding against the code before applying it.

To confirm a run used the Fast tier: `python3 ~/.agents/skills/call-codex/tier.py <thread_id>` prints the tier per thread, `priority` = Fast. A review also lists its reviewer's child thread with its own tier.

## Image generation

Codex's built-in `image_gen` tool generates and edits images on the ChatGPT subscription. The image model is chosen by OpenAI server-side: the tool has no model argument, so it always gets the latest model OpenAI rolls out to Codex (ChatGPT Images 2.5 since 2026-09-08; the CLI binary still carries a `gpt-image-2` label, and C2PA metadata only says `gpt-image`). It works in the read-only sandbox. Use it for raster images (photo, illustration, texture, sprite, product shot), standalone or as a piece of a larger composition. Compositions, layouts, SVG, icons, and diagrams stay with the orchestrator, not Codex's image tool.

Always go through the bundled wrapper: it resolves the `sol` id, runs the launcher without the Fast tier and with `config.toml`'s effort (reasoning barely matters here), finds the file on disk under `~/.codex/generated_images/<thread-id>/` (never trust Codex's reported path), and copies it to `--out`. Same rules as any Codex call: a background shell run, prompt in a scratchpad file.

```bash
I=~/.agents/skills/call-codex/image.py
python3 $I --prompt-file <scratchpad>/img.md --out <project>/assets/hero.png
python3 $I --prompt-file <scratchpad>/img.md --out icon.png --transparent           # transparent background
python3 $I --prompt-file <scratchpad>/img.md --out hero-v2.png --ref /abs/hero.png  # edit / reference (repeatable)
python3 $I --prompt-file <scratchpad>/img.md --out concept.png --n 3                # concept-1..3.png, one call each
```

- Output is PNG only. The prompt file holds just the visual request (subject, style, exact text in quotes, what to avoid); the wrapper adds the tool instructions.
- `--ref` takes local files; say in the prompt whether each is the edit target or a style/composition reference.
- It never overwrites: pick a versioned name (`hero-v2.png`) unless the user asked to replace, then pass `--overwrite`.
- Result: one JSON line with `files`. Open each and check it before reporting. Each image takes ~30–60 s.
- No size, quality, or model controls: crop/resize afterwards (PIL is installed).

## Sandbox limits

No network (the caller runs `npx convex codegen` and anything that fetches) and no IPC sockets (`npx tsx --test` fails, tell Codex to use `node --import tsx --test`; `git mv` may fail, plain `mv` + `git add -A` is fine).

## Visibility and troubleshooting

When a subagent or Workflow stage delegates to Codex, prefix its user-visible name with the model id plus `fast` when the Fast tier is on, as printed by the launcher's `codex launcher:` line or by `--dry-run`: "gpt-6.2-sol fast: review auth changes", "gpt-6.2-astra: review auth changes". Never use a remembered id.

If a call fails with a setup or auth error (it is in the JSON line's `error`), run `codex doctor` and report what it says; `codex login` signs in again.
