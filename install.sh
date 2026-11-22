#!/usr/bin/env bash
# mstack installer for Claude Code, Codex and Antigravity.
#
#   curl -fsSL https://raw.githubusercontent.com/SignorCrypto/mstack/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --dry-run      (pass flags after `-s --`; still clones/pulls)
#   ./install.sh [--dry-run] [--no-mcp] [--personal] [--claude-dir <path>...]
#
# Piped from curl, it clones (or updates) the repo into $MSTACK_DIR (default ~/.mstack)
# and reruns itself from there. From a checkout it installs from wherever the checkout is.
#
# What it does, idempotently (rerun it to update):
#   1. links each skills/<name> into ~/.agents/skills (the skills hub, read by Codex) and the chosen
#      Claude Code profile(s) (auto-detected if multiple exist, or set via CLAUDE_CONFIG_DIR /
#      --claude-dir); when Antigravity is installed, links its whole ~/.gemini/config/skills to the
#      hub; removes links to skills deleted from the repo;
#   2. installs the decision-model MCP server (needs Node.js 22+) and registers it with the
#      `claude` (per selected profile), `codex` and `agy` CLIs that are present, unless --no-mcp;
#   3. only with --personal: links personal/AGENTS.md, the one global instructions file, as each
#      selected profile's CLAUDE.md, ~/.codex/AGENTS.md and (with Antigravity) ~/.gemini/AGENTS.md.
#      Without the flag your own instruction files are untouched.
# Anything it replaces that is not already the right symlink is moved to ~/.mstack-backup/<timestamp>/.
set -euo pipefail

REPO_URL="${MSTACK_REPO:-https://github.com/SignorCrypto/mstack.git}"
SELF="${BASH_SOURCE[0]:-}"

# Bootstrap: no checkout around this script (piped from curl) -> clone or update, then rerun.
if [[ -z "$SELF" || ! -d "$(dirname "$SELF")/skills" ]]; then
  DIR="${MSTACK_DIR:-$HOME/.mstack}"
  command -v git >/dev/null || { echo "mstack: git is required" >&2; exit 1; }
  if [[ -d "$DIR/.git" ]]; then
    git -C "$DIR" pull --ff-only --quiet
  else
    git clone --quiet "$REPO_URL" "$DIR"
  fi
  exec bash "$DIR/install.sh" "$@"
fi

REPO="$(cd "$(dirname "$SELF")" && pwd -P)"
BACKUP="$HOME/.mstack-backup/$(date +%Y%m%d-%H%M%S)"
DRY=0 MCP_ON=1 PERSONAL=0
EXPLICIT_CLAUDE_DIRS=()
while (($#)); do
  case "$1" in
    --dry-run) DRY=1 ;;
    --no-mcp) MCP_ON=0 ;;
    --personal) PERSONAL=1 ;;
    --claude-dir)
      (($# >= 2)) || { echo "mstack: --claude-dir requires a path" >&2; exit 2; }
      EXPLICIT_CLAUDE_DIRS+=("$2"); shift ;;
    --claude-dir=*)
      EXPLICIT_CLAUDE_DIRS+=("${1#*=}") ;;
    *) echo "mstack: unknown option $1 (use --dry-run, --no-mcp, --personal, --claude-dir <path>)" >&2; exit 2 ;;
  esac
  shift
done

run() { if ((DRY)); then echo "  would: $*"; else "$@"; fi; }
runq() { if ((DRY)); then echo "  would: $*"; else "$@" >/dev/null; fi; }
warn() { echo "mstack: $*" >&2; }

norm_dir() {
  local d="$1"
  if [[ "$d" == "~" || "$d" == "~/"* ]]; then d="$HOME${d#\~}"; fi
  if [[ "$d" != "/" ]]; then d="${d%/}"; fi
  printf '%s\n' "$d"
}

pretty_dir() {
  case "$1" in
    "$HOME") printf '~\n' ;;
    "$HOME"/*) printf '~/%s\n' "${1#"$HOME"/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

profile_label() {
  local dir="$1" cfg
  if [[ "$dir" == "$HOME/.claude" ]]; then cfg="$HOME/.claude.json"
  else cfg="$dir/.claude.json"; fi
  [[ -f "$cfg" ]] || return 0
  if command -v node >/dev/null; then
    node -e '
      try {
        const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).oauthAccount || {};
        const out = [a.emailAddress, a.organizationName].filter(Boolean).join(" — ");
        if (out) process.stdout.write(out);
      } catch {}
    ' "$cfg" 2>/dev/null || true
  elif command -v python3 >/dev/null; then
    python3 -c '
import json, sys
try:
    a = json.load(open(sys.argv[1])).get("oauthAccount") or {}
    out = " — ".join(v for v in (a.get("emailAddress"), a.get("organizationName")) if v)
    if out: sys.stdout.write(out)
except Exception:
    pass
' "$cfg" 2>/dev/null || true
  fi
}

CLAUDE_DIRS=()
add_claude_dir() {
  local d existing
  d="$(norm_dir "$1")"
  if ((${#CLAUDE_DIRS[@]})); then
    for existing in "${CLAUDE_DIRS[@]}"; do
      [[ "$existing" == "$d" ]] && return 0
    done
  fi
  CLAUDE_DIRS+=("$d")
}

discover_claude_dirs() {
  local d base
  if [[ -d "$HOME/.claude" || -f "$HOME/.claude.json" ]]; then
    add_claude_dir "$HOME/.claude"
  fi
  for d in "$HOME"/.claude-* "$HOME"/.claude_* "$HOME"/.config/claude "$HOME"/.config/claude-* "$HOME"/.config/claude_*; do
    [[ -d "$d" ]] || continue
    base="$(basename "$d")"
    case "$base" in *backup*|*.bak*) continue ;; esac
    if [[ -f "$d/.claude.json" || -f "$d/settings.json" || -d "$d/skills" || -d "$d/projects" ]]; then
      add_claude_dir "$d"
    fi
  done
  if ((${#CLAUDE_DIRS[@]} == 0)); then
    add_claude_dir "$HOME/.claude"
  fi
}

select_claude_dirs() {
  local d
  if ((${#EXPLICIT_CLAUDE_DIRS[@]})); then
    for d in "${EXPLICIT_CLAUDE_DIRS[@]}"; do add_claude_dir "$d"; done
    return 0
  fi
  if [[ -n "${CLAUDE_CONFIG_DIR:-}" ]]; then
    add_claude_dir "$CLAUDE_CONFIG_DIR"
    return 0
  fi
  discover_claude_dirs
  if ((${#CLAUDE_DIRS[@]} <= 1)); then return 0; fi
  if [[ -n "${CI:-}" ]] || ! ( : </dev/tty ) 2>/dev/null; then
    CLAUDE_DIRS=("$HOME/.claude")
    warn "multiple Claude profiles found; defaulting to ~/.claude (set CLAUDE_CONFIG_DIR or pass --claude-dir)"
    return 0
  fi

  local detected=("${CLAUDE_DIRS[@]}")
  local i label answer tok bad
  {
    echo "Multiple Claude Code profiles found:"
    for ((i = 0; i < ${#detected[@]}; i++)); do
      label="$(profile_label "${detected[$i]}")"
      if [[ -n "$label" ]]; then
        printf "  %d) %s (%s)\n" "$((i + 1))" "$(pretty_dir "${detected[$i]}")" "$label"
      else
        printf "  %d) %s\n" "$((i + 1))" "$(pretty_dir "${detected[$i]}")"
      fi
    done
  } >/dev/tty

  while true; do
    printf "Install into [all, or numbers e.g. 1 2] (default: all): " >/dev/tty
    if ! IFS= read -r answer </dev/tty; then
      CLAUDE_DIRS=("${detected[@]}")
      return 0
    fi
    answer="${answer//,/ }"
    answer="$(printf '%s' "$answer" | awk '{$1=$1; print}')"
    case "$answer" in
      ""|all|ALL|a|A|\*)
        CLAUDE_DIRS=("${detected[@]}")
        return 0
        ;;
    esac
    CLAUDE_DIRS=()
    bad=0
    for tok in $answer; do
      if [[ "$tok" =~ ^[0-9]+$ ]] && ((tok >= 1 && tok <= ${#detected[@]})); then
        add_claude_dir "${detected[$((tok - 1))]}"
      else
        bad=1
        break
      fi
    done
    if ((bad == 0 && ${#CLAUDE_DIRS[@]} > 0)); then
      return 0
    fi
    printf "Invalid choice '%s'. Enter 'all' or numbers between 1 and %d.\n" "$answer" "${#detected[@]}" >/dev/tty
  done
}

. "$REPO/lib/links.sh"

select_claude_dirs

# Every host sees the same skills. The repo's skills are linked into the hub (~/.agents/skills,
# read by Codex) and into each Claude profile; Antigravity's whole skills dir links to the hub,
# so it also sees everything else installed there. Antigravity only when it is installed.
HUB="$HOME/.agents/skills"
SKILL_DIRS=("$HUB")
for cdir in "${CLAUDE_DIRS[@]}"; do SKILL_DIRS+=("$cdir/skills"); done
AGY=0
if command -v agy >/dev/null || [[ -d "$HOME/.gemini/config" ]]; then AGY=1; fi

# 1. Skills
if ((AGY)); then link_skills_dir "$HOME/.gemini/config/skills" "$HUB"; fi
for sdir in "${SKILL_DIRS[@]}"; do
  for dir in "$REPO"/skills/*/; do
    name="$(basename "$dir")"
    link "$REPO/skills/$name" "$sdir/$name"
  done
  for l in "$sdir"/*; do
    if [[ -L "$l" && ! -e "$l" && "$(readlink "$l")" == "$REPO/skills/"* ]]; then
      run rm "$l"
      echo "removed stale link $l"
    fi
  done
done

# 2. Decision-model MCP server
claude_in() {
  local dir="$1"; shift
  if [[ "$dir" == "$HOME/.claude" ]]; then
    env -u CLAUDE_CONFIG_DIR claude "$@"
  else
    CLAUDE_CONFIG_DIR="$dir" claude "$@"
  fi
}

register_claude() {
  local dir="$1" current
  command -v claude >/dev/null || return 0
  current="$(claude_in "$dir" mcp get decision-model 2>/dev/null || true)"
  if grep -qiF "command: $NODE" <<<"$current" && grep -qiF "args: $SERVER" <<<"$current"; then return 0; fi
  if [[ -n "$current" ]]; then
    runq claude_in "$dir" mcp remove decision-model --scope user
  fi
  runq claude_in "$dir" mcp add --scope user --transport stdio decision-model -- "$NODE" "$SERVER"
  ((DRY)) || echo "registered decision-model MCP with claude ($(pretty_dir "$dir"))"
}

register_codex() {
  local current
  command -v codex >/dev/null || return 0
  current="$(codex mcp get decision-model 2>/dev/null || true)"
  if grep -qiF "command: $NODE" <<<"$current" && grep -qiF "args: $SERVER" <<<"$current"; then return 0; fi
  if [[ -n "$current" ]]; then
    runq codex mcp remove decision-model
  fi
  runq codex mcp add decision-model -- "$NODE" "$SERVER"
  ((DRY)) || echo "registered decision-model MCP with codex"
}

register_agy() {
  command -v agy >/dev/null || return 0
  # `agy mcp add` adds or updates, so a changed node path or checkout just overwrites the entry.
  if agy mcp list 2>/dev/null | grep -qF "$SERVER"; then return 0; fi
  runq agy mcp add decision-model -- "$NODE" "$SERVER"
  ((DRY)) || echo "registered decision-model MCP with agy"
}

install_mcp() {
  local mcp="$REPO/mcp/decision-model" sum major cdir
  NODE="$(command -v node || true)"
  SERVER="$mcp/src/server.mjs"
  [[ -n "$NODE" ]] || { warn "Node.js not found: skipping the decision-model MCP (needs Node 22+)"; return 0; }
  major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
  ((major >= 22)) || { warn "Node $major is too old: skipping the decision-model MCP (needs Node 22+)"; return 0; }

  # Reinstall dependencies only when the lockfile changed.
  sum="$(cksum < "$mcp/package-lock.json")"
  if [[ "$(cat "$mcp/node_modules/.mstack-lock" 2>/dev/null)" != "$sum" ]]; then
    run npm --prefix "$mcp" ci --omit=dev --ignore-scripts --no-audit --no-fund --update-notifier=false --loglevel=error
    ((DRY)) || { echo "$sum" > "$mcp/node_modules/.mstack-lock"; echo "installed decision-model MCP dependencies"; }
  fi
  for cdir in "${CLAUDE_DIRS[@]}"; do
    register_claude "$cdir"
  done
  register_codex
  register_agy

  # The registration pins this node binary: rerun the installer after upgrading or removing it.
  ((DRY)) || "$NODE" "$mcp/src/config.mjs" --summary || true
}
((MCP_ON)) && install_mcp

# 3. Personal global instructions (opt-in): one file, linked under each host's own name.
if ((PERSONAL)); then
  for cdir in "${CLAUDE_DIRS[@]}"; do
    link "$REPO/personal/AGENTS.md" "$cdir/CLAUDE.md"
  done
  link "$REPO/personal/AGENTS.md" "$HOME/.codex/AGENTS.md"
  if ((AGY)); then link "$REPO/personal/AGENTS.md" "$HOME/.gemini/AGENTS.md"; fi
fi

echo "mstack installed from $REPO"
