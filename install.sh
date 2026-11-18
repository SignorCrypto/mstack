#!/usr/bin/env bash
# mstack installer for Claude Code and Codex.
#
#   curl -fsSL https://raw.githubusercontent.com/SignorCrypto/mstack/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --dry-run      (pass flags after `-s --`; still clones/pulls)
#   ./install.sh [--dry-run] [--no-mcp] [--personal]       (from a checkout)
#
# Piped from curl, it clones (or updates) the repo into $MSTACK_DIR (default ~/.mstack)
# and reruns itself from there. From a checkout it installs from wherever the checkout is.
#
# What it does, idempotently (rerun it to update):
#   1. links each skills/<name> into ~/.claude/skills (Claude Code) and ~/.agents/skills (Codex),
#      and removes links to skills deleted from the repo;
#   2. installs the decision-model MCP server (needs Node.js 22+) and registers it with the
#      `claude` and `codex` CLIs that are present, unless --no-mcp;
#   3. only with --personal: links personal/CLAUDE.md and personal/AGENTS.md as the global
#      instructions. Without the flag your own ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md are untouched.
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
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-mcp) MCP_ON=0 ;;
    --personal) PERSONAL=1 ;;
    *) echo "mstack: unknown option $arg (use --dry-run, --no-mcp, --personal)" >&2; exit 2 ;;
  esac
done

run() { if ((DRY)); then echo "  would: $*"; else "$@"; fi; }
runq() { if ((DRY)); then echo "  would: $*"; else "$@" >/dev/null; fi; }
warn() { echo "mstack: $*" >&2; }

# link TARGET PATH: make PATH a symlink to TARGET, backing up whatever was there.
link() {
  local target="$1" path="$2"
  if [[ -L "$path" && "$(readlink "$path")" == "$target" ]]; then return 0; fi
  if [[ -e "$path" || -L "$path" ]]; then
    local dest="$BACKUP/${path#"$HOME"/}"
    run mkdir -p "$(dirname "$dest")"
    run mv "$path" "$dest"
    echo "backed up $path -> $dest"
  fi
  run mkdir -p "$(dirname "$path")"
  run ln -s "$target" "$path"
  echo "linked $path -> $target"
}

# 1. Skills
for dir in "$REPO"/skills/*/; do
  name="$(basename "$dir")"
  link "$REPO/skills/$name" "$HOME/.agents/skills/$name"
  link "$REPO/skills/$name" "$HOME/.claude/skills/$name"
done
for l in "$HOME"/.agents/skills/* "$HOME"/.claude/skills/*; do
  if [[ -L "$l" && ! -e "$l" && "$(readlink "$l")" == "$REPO/skills/"* ]]; then
    run rm "$l"
    echo "removed stale link $l"
  fi
done

# 2. Decision-model MCP server
# register CLI: add the server to that client unless it is already registered with this node and path.
register() {
  local cli="$1" current
  command -v "$cli" >/dev/null || return 0
  current="$("$cli" mcp get decision-model 2>/dev/null || true)"
  if grep -qiF "command: $NODE" <<<"$current" && grep -qiF "args: $SERVER" <<<"$current"; then return 0; fi
  if [[ -n "$current" ]]; then
    if [[ "$cli" == claude ]]; then runq claude mcp remove decision-model --scope user
    else runq codex mcp remove decision-model; fi
  fi
  if [[ "$cli" == claude ]]; then runq claude mcp add --scope user --transport stdio decision-model -- "$NODE" "$SERVER"
  else runq codex mcp add decision-model -- "$NODE" "$SERVER"; fi
  ((DRY)) || echo "registered decision-model MCP with $cli"
}

install_mcp() {
  local mcp="$REPO/mcp/decision-model" sum major
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
  register claude
  register codex

  # The registration pins this node binary: rerun the installer after upgrading or removing it.
  ((DRY)) || "$NODE" "$mcp/src/config.mjs" --summary || true
}
((MCP_ON)) && install_mcp

# 3. Personal global instructions (opt-in)
if ((PERSONAL)); then
  link "$REPO/personal/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
  link "$REPO/personal/AGENTS.md" "$HOME/.codex/AGENTS.md"
fi

echo "mstack installed from $REPO"
