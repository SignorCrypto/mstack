#!/usr/bin/env bash
# Neon launcher: runs one headless Antigravity CLI (agy) turn with mstack's defaults.
#
#   neon.sh --prompt-file <file> [--write] [--effort <level>] [--model <neon|id>]
#           [--cwd <dir>] [--add-dir <dir>]... [--resume <conversation-id>] [--dry-run]
#
# - Model: the latest gemini-*-neon in `agy models` (resolved live; unknown names are an error).
# - Effort: high unless --effort says otherwise.
# - Sandbox (macOS sandbox-exec, enforced by the OS, not by the agent):
#     read-only (default)  no file writes except agy's own state and the user temp/cache dirs;
#     --write              also the working dir, its git common dir and every --add-dir.
#   Inside the sandbox every tool call is auto-approved: agy's headless mode cannot prompt,
#   and a denied call ends the turn with no output.
# - Never reads stdin. Prints the response, then one JSON summary line; exits 1 on failure.
set -euo pipefail

die() { echo "neon launcher: $*" >&2; exit 2; }

PROMPT_FILE="" WRITE=0 EFFORT="high" MODEL="neon" CWD="$PWD" RESUME="" DRY=0
ADD_DIRS=()
while (($#)); do
  case "$1" in
    --prompt-file) PROMPT_FILE="${2:-}"; shift ;;
    --write) WRITE=1 ;;
    --effort) EFFORT="${2:-}"; shift ;;
    --model) MODEL="${2:-}"; shift ;;
    --cwd) CWD="${2:-}"; shift ;;
    --add-dir) ADD_DIRS+=("${2:-}"); shift ;;
    --resume) RESUME="${2:-}"; shift ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
  shift
done

[[ -n "$PROMPT_FILE" && -s "$PROMPT_FILE" ]] || die "--prompt-file <non-empty file> is required (stdin is never read)"
case "$EFFORT" in low|medium|high|xhigh|max) ;; *) die "--effort must be low|medium|high|xhigh|max" ;; esac
[[ "$(uname -s)" == Darwin ]] || die "the sandbox needs macOS sandbox-exec"
command -v agy >/dev/null || die "agy not found: curl -fsSL https://antigravity.google/cli/install.sh | bash"
CWD="$(cd "$CWD" && pwd -P)" || die "--cwd $CWD does not exist"

# Model: a family name resolves to its newest version; an exact id must exist.
CATALOG="$(agy models 2>/dev/null | awk -F'\t' 'NF>1{print $1}')" || true
[[ -n "$CATALOG" ]] || die "could not read the model catalog (agy models): signed in?"
BASES="$(sed -E 's/-(low|medium|high|xhigh|max)$//' <<<"$CATALOG" | sort -u)"
if [[ "$MODEL" =~ ^[a-z]+$ ]]; then
  ID="$(grep -E "^gemini-[0-9.]+-${MODEL}$" <<<"$BASES" | sort -V | tail -1 || true)"
  [[ -n "$ID" ]] || die "no gemini-*-$MODEL model in the catalog"
else
  grep -qxF "$MODEL" <<<"$BASES" || die "model $MODEL is not in the catalog"
  ID="$MODEL"
fi

# Sandbox profile: deny every write, then allow agy's state, the temp/cache dirs and the TTY.
real() { (cd "$1" 2>/dev/null && pwd -P) || die "directory $1 does not exist"; }
TMP_DIR="$(getconf DARWIN_USER_TEMP_DIR)"; TMP_DIR="${TMP_DIR%/}"
CACHE_DIR="$(getconf DARWIN_USER_CACHE_DIR)"; CACHE_DIR="${CACHE_DIR%/}"
WRITABLE=("$HOME/.gemini" "$HOME/.cache/antigravity" "$TMP_DIR" "$CACHE_DIR")
ADD_ARGS=()
for d in "${ADD_DIRS[@]+"${ADD_DIRS[@]}"}"; do
  d="$(real "$d")"; ADD_ARGS+=(--add-dir "$d")
  ((WRITE)) && WRITABLE+=("$d")
done
if ((WRITE)); then
  WRITABLE+=("$CWD")
  # A worktree's commits land in the main repo's .git; let git write there too.
  if GIT_COMMON="$(git -C "$CWD" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
    WRITABLE+=("$(real "$GIT_COMMON")")
  fi
  SANDBOX="workspace-write"
else
  SANDBOX="read-only"
fi
PROFILE="$(mktemp "$TMP_DIR/neon-sandbox.XXXXXX")"
trap 'rm -f "$PROFILE"' EXIT
{
  echo '(version 1)'
  echo '(allow default)'
  echo '(deny file-write*)'
  echo '(allow file-write*'
  for p in "${WRITABLE[@]}"; do printf '  (subpath "%s")\n' "${p//\"/\\\"}"; done
  echo '  (literal "/dev/null") (literal "/dev/tty") (literal "/dev/ptmx")'
  echo '  (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/"))'
} >"$PROFILE"

CMD=(agy -p "$(cat "$PROMPT_FILE")" --model "$ID" --effort "$EFFORT"
     --dangerously-skip-permissions --output-format json
     ${ADD_ARGS[@]+"${ADD_ARGS[@]}"})
[[ -n "$RESUME" ]] && CMD+=(--conversation "$RESUME")

echo "neon launcher: $ID effort=$EFFORT sandbox=$SANDBOX cwd=$CWD" >&2
if ((DRY)); then
  printf '%s\n' "${WRITABLE[@]}" | python3 -c 'import json,sys
print(json.dumps({"model": sys.argv[1], "effort": sys.argv[2], "sandbox": sys.argv[3], "cwd": sys.argv[4],
  "writable": [l for l in sys.stdin.read().splitlines() if l]}, indent=2))' "$ID" "$EFFORT" "$SANDBOX" "$CWD"
  exit 0
fi

OUT="$(cd "$CWD" && sandbox-exec -f "$PROFILE" "${CMD[@]}" </dev/null)" || true
python3 - "$OUT" <<'PY'
import json, sys
raw = sys.argv[1].strip()
try:
    r = json.loads(raw.splitlines()[-1]) if raw else {}
except json.JSONDecodeError:
    print(raw); print(json.dumps({"ok": False, "error": "agy did not return JSON"})); sys.exit(1)
resp = r.get("response") or ""
ok = r.get("status") == "SUCCESS" and bool(resp.strip()) and not r.get("denied_actions")
print(resp)
print(json.dumps({"ok": ok, "status": r.get("status"), "conversation_id": r.get("conversation_id"),
                  "duration_s": r.get("duration_seconds"), "usage": r.get("usage"),
                  **({"denied_actions": r["denied_actions"]} if r.get("denied_actions") else {}),
                  **({"error": r["error"]} if r.get("error") else {})}))
sys.exit(0 if ok else 1)
PY
