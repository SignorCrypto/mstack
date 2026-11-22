#!/usr/bin/env bash
# Antigravity launcher: runs one headless Antigravity CLI (agy) turn with mstack's defaults.
#
#   antigravity.sh --prompt-file <file> [--write] [--effort <level>] [--model <family|id>]
#           [--cwd <dir>] [--add-dir <dir>]... [--resume <conversation-id>] [--dry-run]
#
# - Model: any model in `agy models` (Gemini, Claude, ...). A family name (neon, argon, flash,
#   opus, sonnet) resolves live to its newest version; default neon. Unknown names are an error.
# - Effort: high unless --effort says otherwise; it must exist for that model in the catalog.
# - Sandbox (macOS sandbox-exec, enforced by the OS, not by the agent):
#     read-only (default)  no file writes except agy's own state and the user temp/cache dirs;
#     --write              also the working dir, its git common dir and every --add-dir.
#   Inside the sandbox every tool call is auto-approved: agy's headless mode cannot prompt,
#   and a denied call ends the turn with no output.
# - Never reads stdin. Prints the response, then one JSON summary line; exits 1 on failure.
set -euo pipefail

die() { echo "antigravity launcher: $*" >&2; exit 2; }
# The skill dir is linked from the repo; the shared sandbox lives at the repo root.
. "$(cd "$(dirname "$0")" && pwd -P)/../../lib/sandbox.sh" || die "lib/sandbox.sh not found (run install.sh)"

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
# Family ids look like <vendor>-<version>-<family> (gemini-4-neon) or <vendor>-<family>-<version>
# (claude-opus-5-5); routers such as gemini-pro-orchestrator-neon never match a family.
CATALOG="$(agy models 2>/dev/null | awk -F'\t' 'NF>1{print $1}')" || true
[[ -n "$CATALOG" ]] || die "could not read the model catalog (agy models): signed in?"
BASES="$(sed -E 's/-(low|medium|high|xhigh|max)$//' <<<"$CATALOG" | sort -u)"
if [[ "$MODEL" =~ ^[a-z]+$ ]]; then
  ID="$(grep -E "^[a-z]+-([0-9][0-9.]*-)?${MODEL}(-[0-9][0-9.]*)*$" <<<"$BASES" | sort -V | tail -1 || true)"
  [[ -n "$ID" ]] || die "no $MODEL model in the catalog (agy models)"
else
  grep -qxF "$MODEL" <<<"$BASES" || die "model $MODEL is not in the catalog"
  ID="$MODEL"
fi
# Effort: the catalog lists one id per supported level; a model without levels takes none.
LEVELS="$(grep -E "^${ID}-(low|medium|high|xhigh|max)$" <<<"$CATALOG" | sed "s/^${ID}-//" | tr '\n' ' ' || true)"
if [[ -n "$LEVELS" && " $LEVELS" != *" $EFFORT "* ]]; then
  die "$ID supports effort: ${LEVELS% }"
fi

# Sandbox: every write denied except agy's own state (plus temp/cache, added by the lib).
real() { sandbox_real_dir "$1" || die "directory $1 does not exist"; }
WRITABLE=("$HOME/.gemini" "$HOME/.cache/antigravity")
ADD_ARGS=()
for d in "${ADD_DIRS[@]+"${ADD_DIRS[@]}"}"; do
  d="$(real "$d")"; ADD_ARGS+=(--add-dir "$d")
  ((WRITE)) && WRITABLE+=("$d")
done
if ((WRITE)); then
  while IFS= read -r d; do WRITABLE+=("$d"); done < <(sandbox_writable_workspace "$CWD")
  SANDBOX="workspace-write"
else
  SANDBOX="read-only"
fi
PROFILE="$(mktemp "$(sandbox_tmp_dir)/agy-sandbox.XXXXXX")"
trap 'rm -f "$PROFILE"' EXIT
sandbox_profile "$PROFILE" "${WRITABLE[@]}"

CMD=(agy -p "$(cat "$PROMPT_FILE")" --model "$ID"
     --dangerously-skip-permissions --output-format json
     ${ADD_ARGS[@]+"${ADD_ARGS[@]}"})
[[ -n "$LEVELS" ]] && CMD+=(--effort "$EFFORT")
[[ -n "$RESUME" ]] && CMD+=(--conversation "$RESUME")
[[ -n "$LEVELS" ]] || EFFORT="none"

echo "antigravity launcher: $ID effort=$EFFORT sandbox=$SANDBOX cwd=$CWD" >&2
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
