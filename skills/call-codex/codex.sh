#!/usr/bin/env bash
# Codex launcher: runs one headless Codex CLI turn (`codex exec`) with mstack's defaults.
#
#   codex.sh [task] --prompt-file <file> [--write] [options]
#   codex.sh review [--base <ref> | --uncommitted | --commit <sha>] [--prompt-file <focus>]
#                   [--adversarial] [options]
#   options: [--model <sol|astra|family|id>] [--effort <level|config>] [--fast | --no-fast]
#            [--cwd <dir>] [--add-dir <dir>]... [--resume <thread-id>] [--dry-run]
#
# - Model: sol unless --model says otherwise (a family or an exact id, resolved live from the
#   Codex catalog; unknown names are an error). astra never writes (--write is refused).
# - Fast tier (service_tier=priority): on for sol, off for others; --fast / --no-fast override.
# - Effort: high, never config.toml's (Codex Desktop rewrites it); `config` keeps config.toml's.
#   A level the model does not list in the catalog is an error.
# - Sandbox: Codex's own, read-only by default; --write = workspace-write (task only).
# - Review scope: --base / --uncommitted / --commit, else the working tree if dirty, else the
#   branch against the default branch. --prompt-file adds focus; --adversarial prepends
#   adversarial.md. Sessions are saved (never --ephemeral), so they show up in Codex's history.
# - Never reads the caller's stdin. Prints the final message, then one JSON summary line;
#   exits 1 on failure.
set -euo pipefail

die() { echo "codex launcher: $*" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd -P)"

COMMAND="task"
case "${1:-}" in task|review) COMMAND="$1"; shift ;; esac
PROMPT_FILE="" WRITE=0 MODEL="sol" EFFORT="high" FAST="" CWD="$PWD" RESUME="" DRY=0
SCOPE="" SCOPE_ARG="" ADVERSARIAL=0
ADD_DIRS=()
while (($#)); do
  case "$1" in
    --prompt-file) PROMPT_FILE="${2:-}"; shift ;;
    --write) WRITE=1 ;;
    --model) MODEL="${2:-}"; shift ;;
    --effort) EFFORT="${2:-}"; shift ;;
    --fast) [[ "$FAST" == 0 ]] && die "use --fast or --no-fast, not both"; FAST=1 ;;
    --no-fast) [[ "$FAST" == 1 ]] && die "use --fast or --no-fast, not both"; FAST=0 ;;
    --cwd) CWD="${2:-}"; shift ;;
    --add-dir) ADD_DIRS+=("${2:-}"); shift ;;
    --resume) RESUME="${2:-}"; shift ;;
    --base) SCOPE="base"; SCOPE_ARG="${2:-}"; shift ;;
    --commit) SCOPE="commit"; SCOPE_ARG="${2:-}"; shift ;;
    --uncommitted) SCOPE="uncommitted" ;;
    --adversarial) ADVERSARIAL=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
  shift
done

command -v codex >/dev/null || die "codex not found: npm i -g @openai/codex, then run codex once to sign in"
CWD="$(cd "$CWD" 2>/dev/null && pwd -P)" || die "--cwd does not exist"
if [[ "$COMMAND" == task ]]; then
  [[ -n "$PROMPT_FILE" && -s "$PROMPT_FILE" ]] || die "a task needs --prompt-file <non-empty file> (stdin is never read)"
  [[ -z "$SCOPE" && "$ADVERSARIAL" == 0 ]] || die "--base/--commit/--uncommitted/--adversarial are review options"
else
  [[ "$WRITE" == 0 ]] || die "a review never writes"
  [[ -z "$RESUME" ]] || die "--resume continues a task, not a review"
  [[ -z "$PROMPT_FILE" || -s "$PROMPT_FILE" ]] || die "--prompt-file is empty"
fi

# Model and effort from the live catalog.
LINE="$(python3 "$HERE/models.py" "$MODEL" --efforts)" || die "model $MODEL not found"
ID="${LINE%%$'\t'*}" LEVELS="${LINE#*$'\t'}"
FAMILY="${ID##*-}"
((WRITE)) && [[ "$FAMILY" == astra ]] && die "$ID does not implement: --write is for sol"
if [[ "$EFFORT" != config && " $LEVELS " != *" $EFFORT "* ]]; then
  die "$ID supports effort: $LEVELS (or config)"
fi
[[ -n "$FAST" ]] || { [[ "$FAMILY" == sol ]] && FAST=1 || FAST=0; }
SANDBOX="read-only"; ((WRITE)) && SANDBOX="workspace-write"

# Review scope: explicit, else the working tree if dirty, else the branch vs the default branch.
if [[ "$COMMAND" == review && -z "$SCOPE" ]]; then
  git -C "$CWD" rev-parse --git-dir >/dev/null 2>&1 || die "a review needs a git repository (--cwd)"
  if [[ -n "$(git -C "$CWD" status --porcelain)" ]]; then
    SCOPE="uncommitted"
  else
    SCOPE="base"
    SCOPE_ARG="$(git -C "$CWD" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
    [[ -n "$SCOPE_ARG" ]] || for b in main master; do
      git -C "$CWD" rev-parse --verify -q "$b" >/dev/null && { SCOPE_ARG="$b"; break; }
    done
    [[ -n "$SCOPE_ARG" ]] || die "no default branch found: pass --base <ref>"
  fi
fi

# One command shape for task, resume and review: everything through -c, the prompt on stdin.
CFG=(-c "sandbox_mode=\"$SANDBOX\"" -c 'approval_policy="never"')
# Like the other call-* launchers: the user temp dir ($TMPDIR) stays writable, the shared /tmp not.
((WRITE)) && CFG+=(-c 'sandbox_workspace_write.exclude_slash_tmp=true')
[[ "$EFFORT" != config ]] && CFG+=(-c "model_reasoning_effort=\"$EFFORT\"")
((FAST)) && CFG+=(-c 'service_tier="priority"')
ADD_ARGS=()
for d in "${ADD_DIRS[@]+"${ADD_DIRS[@]}"}"; do
  real="$(cd "$d" 2>/dev/null && pwd -P)" || die "--add-dir $d does not exist"
  ADD_ARGS+=(--add-dir "$real")
done
case "$COMMAND" in
  task)
    if [[ -n "$RESUME" ]]; then SUB=(exec resume "$RESUME"); else SUB=(exec ${ADD_ARGS[@]+"${ADD_ARGS[@]}"}); fi ;;
  review)
    # `codex exec review` takes either a scope flag or custom instructions, not both: with a focus
    # (or --adversarial) the scope goes into the instructions instead.
    SUB=(exec review)
    if [[ -z "$PROMPT_FILE" && "$ADVERSARIAL" == 0 ]]; then
      case "$SCOPE" in
        uncommitted) SUB+=(--uncommitted) ;;
        base) SUB+=(--base "$SCOPE_ARG") ;;
        commit) SUB+=(--commit "$SCOPE_ARG") ;;
      esac
    fi ;;
esac
CMD=(codex "${SUB[@]}" --json --skip-git-repo-check -m "$ID" "${CFG[@]}")

# The prompt: the task file, or the review's focus (with the adversarial preamble).
PROMPT="$(mktemp "${TMPDIR:-/tmp}/codex-prompt.XXXXXX")"
ERR="$(mktemp "${TMPDIR:-/tmp}/codex-err.XXXXXX")"
trap 'rm -f "$PROMPT" "$ERR"' EXIT
{
  if [[ "$COMMAND" == review ]] && [[ -n "$PROMPT_FILE" || "$ADVERSARIAL" == 1 ]]; then
    case "$SCOPE" in
      uncommitted) echo "Scope: the uncommitted changes in this repository (staged, unstaged and untracked files)." ;;
      base) echo "Scope: the changes on this branch against $SCOPE_ARG (git diff $SCOPE_ARG...HEAD)." ;;
      commit) echo "Scope: the changes introduced by commit $SCOPE_ARG." ;;
    esac
    echo
  fi
  if ((ADVERSARIAL)); then cat "$HERE/adversarial.md"; echo; fi
  if [[ -n "$PROMPT_FILE" ]]; then cat "$PROMPT_FILE"; fi
} >"$PROMPT"
[[ -s "$PROMPT" ]] && CMD+=(-)

WHERE="sandbox=$SANDBOX"; [[ "$COMMAND" == review ]] && WHERE="review=$SCOPE${SCOPE_ARG:+:$SCOPE_ARG}"
echo "codex launcher: $ID$( ((FAST)) && echo ' fast') effort=$EFFORT $WHERE cwd=$CWD" >&2
if ((DRY)); then
  python3 -c 'import json,sys; print(json.dumps({"model": sys.argv[1], "fast": sys.argv[2] == "1",
    "effort": sys.argv[3], "command": sys.argv[4:]}, indent=2))' "$ID" "$FAST" "$EFFORT" "${CMD[@]}"
  exit 0
fi

if [[ -s "$PROMPT" ]]; then
  OUT="$(cd "$CWD" && "${CMD[@]}" <"$PROMPT" 2>"$ERR")" || true
else
  OUT="$(cd "$CWD" && "${CMD[@]}" </dev/null 2>"$ERR")" || true
fi
python3 - "$OUT" "$ID" "$FAST" "$(tail -c 1500 "$ERR")" <<'PY'
import json, sys
raw, model, fast, stderr = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4].strip()
thread, messages, usage, errors, failed = None, [], None, [], False
for line in raw.splitlines():
    try:
        e = json.loads(line)
    except json.JSONDecodeError:
        continue
    t = e.get("type")
    if t == "thread.started":
        thread = e.get("thread_id")
    elif t == "item.completed":
        item = e.get("item") or {}
        if item.get("type") == "agent_message":
            messages.append(item.get("text") or "")
    elif t == "turn.completed":
        usage = e.get("usage")
    elif t in ("turn.failed", "error"):
        failed = True
        errors.append((e.get("error") or {}).get("message") or e.get("message") or t)
final = messages[-1] if messages else ""
ok = bool(thread) and not failed and bool(final.strip())
print(final)
print(json.dumps({"ok": ok, "thread_id": thread, "model": model, "fast": fast, "usage": usage,
                  **({"error": "; ".join(errors) or stderr or "no final message"} if not ok else {})}))
sys.exit(0 if ok else 1)
PY
