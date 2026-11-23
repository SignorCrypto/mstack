#!/usr/bin/env bash
# mstack installer for Claude Code, Codex and Antigravity. The one command: rerun it whenever you
# install a skill, add a profile or pull mstack, and every host is aligned again.
#
#   curl -fsSL https://raw.githubusercontent.com/SignorCrypto/mstack/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --dry-run      (pass flags after `-s --`; still clones/pulls)
#   ./install.sh [--dry-run] [--no-mcp] [--personal | --rules <file>]
#                [--claude-dir <path>]... [--codex-dir <path>]...
#                [--align-profiles] [--align-mcp [--include-secrets]]
#
# Piped from curl, it clones (or updates) the repo into $MSTACK_DIR (default ~/.mstack)
# and reruns itself from there. From a checkout it installs from wherever the checkout is.
#
# Profiles: Claude Code (CLAUDE_CONFIG_DIR) and Codex (CODEX_HOME) can each have several
# installations; they are detected (~/.claude, ~/.claude-*, ~/.config/claude*; ~/.codex, ~/.codex-*),
# asked on a terminal when there are several, or set with the env var / --claude-dir / --codex-dir.
# Antigravity has one ~/.gemini per user.
#
# What it does, idempotently:
#   1. Skills: ~/.agents/skills is the hub (Codex reads it natively, `npx skills` installs there).
#      Links each skills/<name> into the hub and every Claude profile; Antigravity's whole
#      ~/.gemini/config/skills becomes a link to the hub. Then every Claude profile and the hub get
#      the union of their skills (per-skill links, so each profile keeps its own org-scoped
#      skills/synced/); same-named different skills are reported, never replaced. Removes links to
#      skills deleted from the repo.
#   2. Installs the decision-model MCP server (needs Node.js 22+) and registers it with every Claude
#      and Codex profile and with `agy`, unless --no-mcp.
#   3. Rules, opt-in: --rules <file> links that file as every host's global instructions (each
#      Claude profile's CLAUDE.md, each Codex profile's AGENTS.md, ~/.gemini/AGENTS.md);
#      --personal does it with mstack's personal/AGENTS.md. Without either, instruction files are
#      untouched.
#   4. Opt-in, across Claude profiles, from the first selected one (~/.claude when selected):
#      --align-profiles links settings*.json and installs the same user-scope plugins;
#      --align-mcp copies user-scope MCP servers (servers with env/headers: picked on a terminal,
#      otherwise skipped unless --include-secrets).
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
DRY=0 MCP_ON=1 RULES="" ALIGN_PROFILES=0 ALIGN_MCP=0 INCLUDE_SECRETS=0
EXPLICIT_CLAUDE_DIRS=() EXPLICIT_CODEX_DIRS=()
need_arg() { (($# >= 2)) || { echo "mstack: $1 requires a value" >&2; exit 2; }; }
while (($#)); do
  case "$1" in
    --dry-run) DRY=1 ;;
    --no-mcp) MCP_ON=0 ;;
    --personal) RULES="$REPO/personal/AGENTS.md" ;;
    --rules) need_arg "$@"; RULES="$2"; shift ;;
    --claude-dir) need_arg "$@"; EXPLICIT_CLAUDE_DIRS+=("$2"); shift ;;
    --claude-dir=*) EXPLICIT_CLAUDE_DIRS+=("${1#*=}") ;;
    --codex-dir) need_arg "$@"; EXPLICIT_CODEX_DIRS+=("$2"); shift ;;
    --codex-dir=*) EXPLICIT_CODEX_DIRS+=("${1#*=}") ;;
    --align-profiles) ALIGN_PROFILES=1 ;;
    --align-mcp) ALIGN_MCP=1 ;;
    --include-secrets) INCLUDE_SECRETS=1 ;;
    -h|--help) sed -n '2,36p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "mstack: unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

run() { if ((DRY)); then echo "  would: $*"; else "$@"; fi; }
runq() { if ((DRY)); then echo "  would: $*"; else "$@" >/dev/null; fi; }
warn() { echo "mstack: $*" >&2; }

. "$REPO/lib/links.sh"
. "$REPO/lib/profiles.sh"

if [[ -n "$RULES" ]]; then
  RULES="$(norm_dir "$RULES")"
  [[ -f "$RULES" ]] || { echo "mstack: --rules: $RULES is not a file" >&2; exit 2; }
  # Link to the real file, so a rules file that is itself a link (e.g. a profile's CLAUDE.md) is not chained.
  [[ "$RULES" == "$REPO/personal/AGENTS.md" ]] || RULES="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$RULES")"
fi

select_profiles claude ${EXPLICIT_CLAUDE_DIRS[@]+"${EXPLICIT_CLAUDE_DIRS[@]}"}
CLAUDE_DIRS=(${SELECTED[@]+"${SELECTED[@]}"})
select_profiles codex ${EXPLICIT_CODEX_DIRS[@]+"${EXPLICIT_CODEX_DIRS[@]}"}
CODEX_DIRS=(${SELECTED[@]+"${SELECTED[@]}"})
AGY=0
if command -v agy >/dev/null || [[ -d "$HOME/.gemini/config" ]]; then AGY=1; fi
for d in ${CLAUDE_DIRS[@]+"${CLAUDE_DIRS[@]}"}; do echo "Claude profile: $(pretty_dir "$d")"; done
for d in ${CODEX_DIRS[@]+"${CODEX_DIRS[@]}"}; do echo "Codex profile: $(pretty_dir "$d")"; done
((AGY)) && echo "Antigravity: ~/.gemini"

# 1. Skills: one hub, every host sees the same skills.
HUB="$HOME/.agents/skills"
SKILL_DIRS=("$HUB")
for cdir in ${CLAUDE_DIRS[@]+"${CLAUDE_DIRS[@]}"}; do SKILL_DIRS+=("$cdir/skills"); done
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
# Skills installed elsewhere (by hand, `npx skills`, a plugin...): each profile's go into the hub,
# then the hub's go into every profile. Codex's own $CODEX_HOME/skills is left to Codex.
for cdir in ${CLAUDE_DIRS[@]+"${CLAUDE_DIRS[@]}"}; do link_missing "$cdir/skills" "$HUB"; done
for cdir in ${CLAUDE_DIRS[@]+"${CLAUDE_DIRS[@]}"}; do link_missing "$HUB" "$cdir/skills" quiet; done

# 2. Decision-model MCP server
mcp_matches() { grep -qiF "command: $NODE" <<<"$1" && grep -qiF "args: $SERVER" <<<"$1"; }

register_claude() {
  local dir="$1" current
  command -v claude >/dev/null || return 0
  current="$(profile_run claude "$dir" claude mcp get decision-model 2>/dev/null || true)"
  mcp_matches "$current" && return 0
  [[ -n "$current" ]] && runq profile_run claude "$dir" claude mcp remove decision-model --scope user
  runq profile_run claude "$dir" claude mcp add --scope user --transport stdio decision-model -- "$NODE" "$SERVER"
  ((DRY)) || echo "registered decision-model MCP with claude ($(pretty_dir "$dir"))"
}

register_codex() {
  local dir="$1" current
  command -v codex >/dev/null || return 0
  current="$(profile_run codex "$dir" codex mcp get decision-model 2>/dev/null || true)"
  mcp_matches "$current" && return 0
  [[ -n "$current" ]] && runq profile_run codex "$dir" codex mcp remove decision-model
  runq profile_run codex "$dir" codex mcp add decision-model -- "$NODE" "$SERVER"
  ((DRY)) || echo "registered decision-model MCP with codex ($(pretty_dir "$dir"))"
}

register_agy() {
  command -v agy >/dev/null || return 0
  # `agy mcp add` adds or updates, so a changed node path or checkout just overwrites the entry.
  if agy mcp list 2>/dev/null | grep -qF "$SERVER"; then return 0; fi
  runq agy mcp add decision-model -- "$NODE" "$SERVER"
  ((DRY)) || echo "registered decision-model MCP with agy"
}

install_mcp() {
  local mcp="$REPO/mcp/decision-model" sum major dir
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
  for dir in ${CLAUDE_DIRS[@]+"${CLAUDE_DIRS[@]}"}; do register_claude "$dir"; done
  for dir in ${CODEX_DIRS[@]+"${CODEX_DIRS[@]}"}; do register_codex "$dir"; done
  register_agy

  # The registration pins this node binary: rerun the installer after upgrading or removing it.
  ((DRY)) || "$NODE" "$mcp/src/config.mjs" --summary || true
}
((MCP_ON)) && install_mcp

# 3. Global instructions (opt-in): one file, linked under each host's own name.
if [[ -n "$RULES" ]]; then
  for dir in ${CLAUDE_DIRS[@]+"${CLAUDE_DIRS[@]}"}; do link "$RULES" "$dir/CLAUDE.md"; done
  for dir in ${CODEX_DIRS[@]+"${CODEX_DIRS[@]}"}; do link "$RULES" "$dir/AGENTS.md"; done
  if ((AGY)); then link "$RULES" "$HOME/.gemini/AGENTS.md"; fi
fi

# 4. Across Claude profiles (opt-in): what cannot be a shared link, copied from the first profile.
if ((ALIGN_PROFILES || ALIGN_MCP)); then
  if ((${#CLAUDE_DIRS[@]} < 2)); then
    warn "--align-profiles/--align-mcp need two or more Claude profiles; nothing to align"
  else
    . "$REPO/lib/claude-align.sh"
    SRC="${CLAUDE_DIRS[0]}" TARGETS=("${CLAUDE_DIRS[@]:1}")
    echo "aligning Claude profiles from $(pretty_dir "$SRC")"
    if ((ALIGN_PROFILES)); then
      for dir in "${TARGETS[@]}"; do align_settings "$SRC" "$dir"; done
      align_plugins "$SRC" "${TARGETS[@]}"
    fi
    if ((ALIGN_MCP)); then align_mcp "$SRC" "${TARGETS[@]}"; fi
  fi
fi

echo "mstack installed from $REPO"
