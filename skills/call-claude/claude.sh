#!/usr/bin/env bash
# Claude launcher: runs one headless Claude Code (claude -p) turn with mstack's defaults.
#
#   claude.sh --prompt-file <file> [--write] [--effort <level>] [--model <alias|id>]
#             [--profile <claude-config-dir>] [--cwd <dir>] [--add-dir <dir>]...
#             [--resume <session-id>] [--dry-run]
#
# - Model: opus unless --model says otherwise (an alias such as fable, opus, sonnet, haiku, which
#   Claude Code resolves to the latest version, or a full claude-* id).
# - Effort: high unless --effort says otherwise.
# - Profile: the current CLAUDE_CONFIG_DIR (or ~/.claude); --profile picks another account.
# - Sandbox (macOS sandbox-exec, enforced by the OS, not by the agent):
#     read-only (default)  no file writes except Claude Code's own state and the user temp/cache dirs;
#     --write              also the working dir, its git common dir and every --add-dir.
#   Inside the sandbox permission prompts are off: headless mode cannot prompt.
# - The prompt goes in on stdin from --prompt-file. Prints the response, then one JSON summary
#   line; exits 1 on failure.
set -euo pipefail

die() { echo "claude launcher: $*" >&2; exit 2; }
# The skill dir is linked from the repo; the shared sandbox lives at the repo root.
. "$(cd "$(dirname "$0")" && pwd -P)/../../lib/sandbox.sh" || die "lib/sandbox.sh not found (run install.sh)"

PROMPT_FILE="" WRITE=0 EFFORT="high" MODEL="opus" PROFILE_DIR="" CWD="$PWD" RESUME="" DRY=0
ADD_DIRS=()
while (($#)); do
  case "$1" in
    --prompt-file) PROMPT_FILE="${2:-}"; shift ;;
    --write) WRITE=1 ;;
    --effort) EFFORT="${2:-}"; shift ;;
    --model) MODEL="${2:-}"; shift ;;
    --profile) PROFILE_DIR="${2:-}"; shift ;;
    --cwd) CWD="${2:-}"; shift ;;
    --add-dir) ADD_DIRS+=("${2:-}"); shift ;;
    --resume) RESUME="${2:-}"; shift ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
  shift
done

[[ -n "$PROMPT_FILE" && -s "$PROMPT_FILE" ]] || die "--prompt-file <non-empty file> is required"
case "$EFFORT" in low|medium|high|xhigh|max) ;; *) die "--effort must be low|medium|high|xhigh|max" ;; esac
[[ "$MODEL" =~ ^([a-z]+|claude-[a-z0-9.-]+)$ ]] || die "--model takes an alias (opus, fable, sonnet, haiku) or a claude-* id"
[[ "$(uname -s)" == Darwin ]] || die "the sandbox needs macOS sandbox-exec"
command -v claude >/dev/null || die "claude not found: https://claude.com/claude-code"
CWD="$(sandbox_real_dir "$CWD")" || die "--cwd does not exist"
PROMPT_FILE="$(cd "$(dirname "$PROMPT_FILE")" && pwd -P)/$(basename "$PROMPT_FILE")"

# Run as a fresh top-level session: drop the variables a parent Claude Code session exports.
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION \
  CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN \
  CLAUDE_CODE_EXECPATH CLAUDE_CODE_CHILD_NOTES_DIR CLAUDE_PID CLAUDE_EFFORT \
  CLAUDE_AGENT_SDK_VERSION CLAUDE_PLUGIN_DATA
if [[ -n "$PROFILE_DIR" ]]; then
  PROFILE_DIR="$(sandbox_real_dir "${PROFILE_DIR/#\~/$HOME}")" || die "--profile does not exist"
  if [[ "$PROFILE_DIR" == "$HOME/.claude" ]]; then unset CLAUDE_CONFIG_DIR; else export CLAUDE_CONFIG_DIR="$PROFILE_DIR"; fi
fi

# Sandbox: every write denied except Claude Code's own state (plus temp/cache, added by the lib).
# "prefix:" covers ~/.claude, ~/.claude-<profile> and ~/.claude.json with its backups.
# Its Bash tool keeps working dirs, outputs and a cwd file under /private/tmp/claude-*.
WRITABLE=("prefix:$HOME/.claude" "$HOME/Library/Caches/claude-cli-nodejs" "prefix:/private/tmp/claude-")
[[ -n "${CLAUDE_CONFIG_DIR:-}" ]] && WRITABLE+=("$(sandbox_real_dir "$CLAUDE_CONFIG_DIR" || echo "$CLAUDE_CONFIG_DIR")")
ADD_ARGS=()
for d in "${ADD_DIRS[@]+"${ADD_DIRS[@]}"}"; do
  d="$(sandbox_real_dir "$d")" || die "--add-dir does not exist"
  ADD_ARGS+=(--add-dir "$d")
  ((WRITE)) && WRITABLE+=("$d")
done
if ((WRITE)); then
  while IFS= read -r d; do WRITABLE+=("$d"); done < <(sandbox_writable_workspace "$CWD")
  SANDBOX="workspace-write"
else
  SANDBOX="read-only"
fi

CMD=(claude -p --model "$MODEL" --effort "$EFFORT" --permission-mode bypassPermissions
     --output-format json ${ADD_ARGS[@]+"${ADD_ARGS[@]}"})
[[ -n "$RESUME" ]] && CMD+=(--resume "$RESUME")

echo "claude launcher: $MODEL effort=$EFFORT sandbox=$SANDBOX profile=${CLAUDE_CONFIG_DIR:-$HOME/.claude} cwd=$CWD" >&2
if ((DRY)); then
  printf '%s\n' "${WRITABLE[@]}" | python3 -c 'import json,sys
print(json.dumps({"model": sys.argv[1], "effort": sys.argv[2], "sandbox": sys.argv[3], "cwd": sys.argv[4],
  "writable": [l for l in sys.stdin.read().splitlines() if l]}, indent=2))' "$MODEL" "$EFFORT" "$SANDBOX" "$CWD"
  exit 0
fi

PROFILE="$(mktemp "$(sandbox_tmp_dir)/claude-sandbox.XXXXXX")"
trap 'rm -f "$PROFILE"' EXIT
sandbox_profile "$PROFILE" "${WRITABLE[@]}"

OUT="$(cd "$CWD" && sandbox-exec -f "$PROFILE" "${CMD[@]}" <"$PROMPT_FILE")" || true
python3 - "$OUT" <<'PY'
import json, sys
raw = sys.argv[1].strip()
try:
    r = json.loads(raw.splitlines()[-1]) if raw else {}
except json.JSONDecodeError:
    print(raw); print(json.dumps({"ok": False, "error": "claude did not return JSON"})); sys.exit(1)
resp = r.get("result") or ""
denied = r.get("permission_denials") or []
ok = r.get("subtype") == "success" and not r.get("is_error") and bool(resp.strip()) and not denied
print(resp)
print(json.dumps({"ok": ok, "status": r.get("subtype"), "model": ",".join(r.get("modelUsage") or {}) or None,
                  "session_id": r.get("session_id"), "duration_s": (r.get("duration_ms") or 0) / 1000,
                  "usage": r.get("usage"),
                  **({"permission_denials": denied} if denied else {}),
                  **({"error": resp or r.get("subtype")} if not ok else {})}))
sys.exit(0 if ok else 1)
PY
