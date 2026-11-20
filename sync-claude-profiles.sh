#!/usr/bin/env bash
# Sync configuration across multiple Claude Code profiles (CLAUDE_CONFIG_DIR).
#
#   ./sync-claude-profiles.sh                              (interactive wizard)
#   ./sync-claude-profiles.sh --skills --dry-run           (preview skill sync)
#   ./sync-claude-profiles.sh --from ~/.claude --to ~/.claude-work --skills --mcp
#   ./sync-claude-profiles.sh --all                        (sync all categories)
#
# By default, nothing is modified silently:
#   - Skills are synced per entry (excluding Claude's own `synced/` dir, which is org-scoped).
#   - CLAUDE.md, settings*.json, MCP servers, and user plugins are opt-in.
#   - MCP servers are registered via `claude mcp add-json` (stdin), never by raw-editing .claude.json;
#     servers containing `env` or `headers` are flagged and skipped in non-interactive mode unless
#     --include-secrets is passed.
# Anything replaced is backed up to ~/.mstack-backup/<timestamp>/.
set -euo pipefail

BACKUP="$HOME/.mstack-backup/$(date +%Y%m%d-%H%M%S)"

DRY=0
FROM_ARG=""
TO_ARGS=()
DO_SKILLS=0 DO_CLAUDE_MD=0 DO_SETTINGS=0 DO_MCP=0 DO_PLUGINS=0
HAS_CATEGORY_FLAG=0
INCLUDE_SECRETS=0

usage() {
  cat <<'EOF'
Usage: sync-claude-profiles.sh [options]

Profile selection:
  --from <dir>         Source Claude Code profile (default: prompt or ~/.claude)
  --to <dir>           Target Claude Code profile (repeatable; default: prompt or all other detected)

Categories (omit all for interactive selection):
  --skills             Sync skills (symlinks, excluding Claude's org-scoped synced/ dir)
  --claude-md          Sync CLAUDE.md symlink
  --settings           Sync settings.json and settings.local.json symlinks
  --mcp                Sync user-scope MCP servers via `claude mcp add-json`
  --plugins            Sync user-scope plugins via `claude plugin install`
  --all                Enable all categories above (MCP servers with env/headers skipped unless --include-secrets)
  --include-secrets    Allow non-interactive sync of MCP servers that define env/headers

Other:
  --dry-run            Preview actions without making changes
  -h, --help           Show this help
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) DRY=1 ;;
    --from)
      (($# >= 2)) || { echo "sync-claude-profiles: --from requires a path" >&2; exit 2; }
      FROM_ARG="$2"; shift ;;
    --from=*) FROM_ARG="${1#*=}" ;;
    --to)
      (($# >= 2)) || { echo "sync-claude-profiles: --to requires a path" >&2; exit 2; }
      TO_ARGS+=("$2"); shift ;;
    --to=*) TO_ARGS+=("${1#*=}") ;;
    --skills) DO_SKILLS=1; HAS_CATEGORY_FLAG=1 ;;
    --claude-md) DO_CLAUDE_MD=1; HAS_CATEGORY_FLAG=1 ;;
    --settings) DO_SETTINGS=1; HAS_CATEGORY_FLAG=1 ;;
    --mcp) DO_MCP=1; HAS_CATEGORY_FLAG=1 ;;
    --plugins) DO_PLUGINS=1; HAS_CATEGORY_FLAG=1 ;;
    --all) DO_SKILLS=1; DO_CLAUDE_MD=1; DO_SETTINGS=1; DO_MCP=1; DO_PLUGINS=1; HAS_CATEGORY_FLAG=1 ;;
    --include-secrets) INCLUDE_SECRETS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "sync-claude-profiles: unknown option $1 (run with --help)" >&2; exit 2 ;;
  esac
  shift
done

run() { if ((DRY)); then echo "  would: $*"; else "$@"; fi; }
warn() { echo "sync-claude-profiles: $*" >&2; }

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

pretty_list() {
  local out="" d
  for d in "$@"; do
    [[ -n "$out" ]] && out+=", "
    out+="$(pretty_dir "$d")"
  done
  printf '%s' "$out"
}

cfg_file_for() {
  if [[ "$1" == "$HOME/.claude" ]]; then printf '%s\n' "$HOME/.claude.json"
  else printf '%s\n' "$1/.claude.json"; fi
}

claude_in() {
  local dir="$1"; shift
  if [[ "$dir" == "$HOME/.claude" ]]; then
    env -u CLAUDE_CONFIG_DIR claude "$@"
  else
    CLAUDE_CONFIG_DIR="$dir" claude "$@"
  fi
}

is_interactive() {
  [[ -z "${CI:-}" ]] && ( : </dev/tty ) 2>/dev/null
}

ask_yn() {
  local prompt="$1" default="$2" ans
  while true; do
    if [[ "$default" == "y" ]]; then
      printf "%s [Y/n]: " "$prompt" >/dev/tty
    else
      printf "%s [y/N]: " "$prompt" >/dev/tty
    fi
    if ! IFS= read -r ans </dev/tty; then
      [[ "$default" == "y" ]]
      return
    fi
    case "$ans" in
      "") [[ "$default" == "y" ]]; return ;;
      y|Y|yes|YES) return 0 ;;
      n|N|no|NO) return 1 ;;
      *) printf "Please answer y or n.\n" >/dev/tty ;;
    esac
  done
}

profile_label() {
  local cfg
  cfg="$(cfg_file_for "$1")"
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

DETECTED=()
add_detected() {
  local d existing
  d="$(norm_dir "$1")"
  if ((${#DETECTED[@]})); then
    for existing in "${DETECTED[@]}"; do
      [[ "$existing" == "$d" ]] && return 0
    done
  fi
  DETECTED+=("$d")
}

discover_profiles() {
  local d base
  if [[ -d "$HOME/.claude" || -f "$HOME/.claude.json" ]]; then
    add_detected "$HOME/.claude"
  fi
  for d in "$HOME"/.claude-* "$HOME"/.claude_* "$HOME"/.config/claude "$HOME"/.config/claude-* "$HOME"/.config/claude_*; do
    [[ -d "$d" ]] || continue
    base="$(basename "$d")"
    case "$base" in *backup*|*.bak*) continue ;; esac
    if [[ -f "$d/.claude.json" || -f "$d/settings.json" || -d "$d/skills" || -d "$d/projects" ]]; then
      add_detected "$d"
    fi
  done
}

SRC_DIR=""
TARGET_DIRS=()

add_target() {
  local d existing
  d="$(norm_dir "$1")"
  [[ "$d" == "$SRC_DIR" ]] && return 0
  if ((${#TARGET_DIRS[@]})); then
    for existing in "${TARGET_DIRS[@]}"; do
      [[ "$existing" == "$d" ]] && return 0
    done
  fi
  TARGET_DIRS+=("$d")
}

select_profiles() {
  discover_profiles
  local d i label ans tok bad

  if [[ -n "$FROM_ARG" ]]; then
    SRC_DIR="$(norm_dir "$FROM_ARG")"
  elif ((${#DETECTED[@]} == 0)); then
    warn "no Claude Code profiles found"
    exit 1
  elif ((${#DETECTED[@]} == 1)) || ! is_interactive; then
    SRC_DIR="${DETECTED[0]}"
  else
    {
      echo "Detected Claude Code profiles:"
      for ((i = 0; i < ${#DETECTED[@]}; i++)); do
        label="$(profile_label "${DETECTED[$i]}")"
        if [[ -n "$label" ]]; then
          printf "  %d) %s (%s)\n" "$((i + 1))" "$(pretty_dir "${DETECTED[$i]}")" "$label"
        else
          printf "  %d) %s\n" "$((i + 1))" "$(pretty_dir "${DETECTED[$i]}")"
        fi
      done
    } >/dev/tty
    while true; do
      printf "Source profile [1-%d] (default: 1): " "${#DETECTED[@]}" >/dev/tty
      if ! IFS= read -r ans </dev/tty; then
        SRC_DIR="${DETECTED[0]}"; break
      fi
      ans="$(printf '%s' "$ans" | awk '{$1=$1; print}')"
      if [[ -z "$ans" ]]; then
        SRC_DIR="${DETECTED[0]}"; break
      elif [[ "$ans" =~ ^[0-9]+$ ]] && ((ans >= 1 && ans <= ${#DETECTED[@]})); then
        SRC_DIR="${DETECTED[$((ans - 1))]}"; break
      fi
      printf "Invalid choice '%s'.\n" "$ans" >/dev/tty
    done
  fi

  if ((${#TO_ARGS[@]})); then
    for d in "${TO_ARGS[@]}"; do add_target "$d"; done
  else
    local others=()
    if ((${#DETECTED[@]})); then
      for d in "${DETECTED[@]}"; do
        [[ "$d" == "$SRC_DIR" ]] || others+=("$d")
      done
    fi
    if ((${#others[@]} == 0)); then
      warn "no other Claude Code profiles found to sync into (pass --to <dir>)"
      exit 1
    elif ((${#others[@]} == 1)) || ! is_interactive; then
      for d in "${others[@]}"; do add_target "$d"; done
    else
      {
        echo "Target profiles:"
        for ((i = 0; i < ${#others[@]}; i++)); do
          label="$(profile_label "${others[$i]}")"
          if [[ -n "$label" ]]; then
            printf "  %d) %s (%s)\n" "$((i + 1))" "$(pretty_dir "${others[$i]}")" "$label"
          else
            printf "  %d) %s\n" "$((i + 1))" "$(pretty_dir "${others[$i]}")"
          fi
        done
      } >/dev/tty
      while true; do
        printf "Sync into [all, or numbers e.g. 1 2] (default: all): " >/dev/tty
        if ! IFS= read -r ans </dev/tty; then
          for d in "${others[@]}"; do add_target "$d"; done; break
        fi
        ans="${ans//,/ }"
        ans="$(printf '%s' "$ans" | awk '{$1=$1; print}')"
        case "$ans" in
          ""|all|ALL|a|A|\*)
            for d in "${others[@]}"; do add_target "$d"; done; break ;;
        esac
        TARGET_DIRS=()
        bad=0
        for tok in $ans; do
          if [[ "$tok" =~ ^[0-9]+$ ]] && ((tok >= 1 && tok <= ${#others[@]})); then
            add_target "${others[$((tok - 1))]}"
          else
            bad=1; break
          fi
        done
        ((bad == 0 && ${#TARGET_DIRS[@]} > 0)) && break
        printf "Invalid choice '%s'.\n" "$ans" >/dev/tty
      done
    fi
  fi

  if ((${#TARGET_DIRS[@]} == 0)); then
    warn "no target profiles selected (source and target cannot be the same)"
    exit 1
  fi
}

link() {
  local target="$1" path="$2"
  if [[ -L "$path" ]]; then
    if [[ "$(readlink "$path")" == "$target" ]]; then return 0; fi
    if [[ -d "$path" && -d "$target" ]] && [[ "$(cd "$path" && pwd -P)" == "$(cd "$target" && pwd -P)" ]]; then return 0; fi
  fi
  if [[ -e "$path" || -L "$path" ]]; then
    local rel="${path#"$HOME"/}"
    local dest="$BACKUP/${rel#/}"
    run mkdir -p "$(dirname "$dest")"
    run mv "$path" "$dest"
    echo "backed up $path -> $dest"
  fi
  run mkdir -p "$(dirname "$path")"
  run ln -s "$target" "$path"
  echo "linked $path -> $target"
}

sync_skills() {
  local dst="$1" item name resolved l
  [[ -d "$SRC_DIR/skills" ]] || return 0
  run mkdir -p "$dst/skills"
  for item in "$SRC_DIR"/skills/*; do
    [[ -e "$item" ]] || continue
    name="$(basename "$item")"
    case "$name" in .*|synced) continue ;; esac
    [[ -d "$item" ]] || continue
    resolved="$(cd "$item" && pwd -P)"
    link "$resolved" "$dst/skills/$name"
  done
  for l in "$dst"/skills/*; do
    if [[ -L "$l" && ! -e "$l" ]]; then
      run rm "$l"
      echo "removed broken skill link $l"
    fi
  done
}

sync_claude_md() {
  local dst="$1" src_md="$SRC_DIR/CLAUDE.md" resolved
  [[ -e "$src_md" ]] || return 0
  resolved="$(cd "$(dirname "$src_md")" && python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$src_md" 2>/dev/null || node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$src_md" 2>/dev/null || printf '%s' "$src_md")"
  link "$resolved" "$dst/CLAUDE.md"
}

sync_settings() {
  local dst="$1" f
  for f in settings.json settings.local.json; do
    [[ -e "$SRC_DIR/$f" ]] || continue
    link "$SRC_DIR/$f" "$dst/$f"
  done
}

sync_mcp() {
  local src_cfg dst dst_cfg interactive_mcp="$1"
  command -v claude >/dev/null || { warn "claude CLI not found; skipping MCP sync"; return 0; }
  command -v node >/dev/null || { warn "node not found; skipping MCP sync"; return 0; }
  src_cfg="$(cfg_file_for "$SRC_DIR")"
  [[ -f "$src_cfg" ]] || return 0

  local names=() flags=() name has_sec
  while IFS=$'\t' read -r name has_sec; do
    [[ -n "$name" ]] || continue
    names+=("$name")
    flags+=("$has_sec")
  done < <(node -e '
    const fs = require("fs");
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const m = d.mcpServers || {};
    for (const [k, v] of Object.entries(m)) {
      const hasEnv = v && v.env && Object.keys(v.env).length > 0;
      const hasHdr = v && v.headers && Object.keys(v.headers).length > 0;
      console.log(k + "\t" + ((hasEnv || hasHdr) ? "1" : "0"));
    }
  ' "$src_cfg" 2>/dev/null || true)

  if ((${#names[@]} == 0)); then
    echo "No user-scope MCP servers found in $(pretty_dir "$SRC_DIR")."
    return 0
  fi

  local chosen=() i ans tok bad
  if ((interactive_mcp)); then
    {
      echo "User-scope MCP servers in $(pretty_dir "$SRC_DIR"):"
      for ((i = 0; i < ${#names[@]}; i++)); do
        if [[ "${flags[$i]}" == "1" ]]; then
          printf "  %d) %s [has env/headers — may contain secrets]\n" "$((i + 1))" "${names[$i]}"
        else
          printf "  %d) %s\n" "$((i + 1))" "${names[$i]}"
        fi
      done
    } >/dev/tty
    while true; do
      printf "Sync MCP servers [all, none, or numbers e.g. 1 2] (default: none): " >/dev/tty
      if ! IFS= read -r ans </dev/tty; then break; fi
      ans="${ans//,/ }"
      ans="$(printf '%s' "$ans" | awk '{$1=$1; print}')"
      case "$ans" in
        ""|none|NONE|n|N) break ;;
        all|ALL|a|A|\*)
          chosen=("${names[@]}"); break ;;
      esac
      chosen=()
      bad=0
      for tok in $ans; do
        if [[ "$tok" =~ ^[0-9]+$ ]] && ((tok >= 1 && tok <= ${#names[@]})); then
          chosen+=("${names[$((tok - 1))]}")
        else
          bad=1; break
        fi
      done
      ((bad == 0 && ${#chosen[@]} > 0)) && break
      printf "Invalid choice '%s'.\n" "$ans" >/dev/tty
    done
  else
    for ((i = 0; i < ${#names[@]}; i++)); do
      if [[ "${flags[$i]}" == "1" && "$INCLUDE_SECRETS" == "0" ]]; then
        warn "skipping MCP '${names[$i]}' (defines env/headers; pass --include-secrets or run interactively to include)"
        continue
      fi
      chosen+=("${names[$i]}")
    done
  fi

  ((${#chosen[@]})) || return 0

  local server_json state
  for dst in "${TARGET_DIRS[@]}"; do
    dst_cfg="$(cfg_file_for "$dst")"
    for name in "${chosen[@]}"; do
      state="$(node -e '
        const fs = require("fs");
        const canon = (v) => v && typeof v === "object" && !Array.isArray(v)
          ? Object.keys(v).sort().reduce((a, k) => (a[k] = canon(v[k]), a), {})
          : Array.isArray(v) ? v.map(canon) : v;
        const src = (JSON.parse(fs.readFileSync(process.argv[1], "utf8")).mcpServers || {})[process.argv[3]];
        let dst = undefined;
        if (fs.existsSync(process.argv[2])) {
          dst = (JSON.parse(fs.readFileSync(process.argv[2], "utf8")).mcpServers || {})[process.argv[3]];
        }
        if (dst === undefined) console.log("missing");
        else if (JSON.stringify(canon(src)) === JSON.stringify(canon(dst))) console.log("same");
        else console.log("diff");
      ' "$src_cfg" "$dst_cfg" "$name" 2>/dev/null || echo "missing")"
      [[ "$state" == "same" ]] && continue
      server_json="$(node -e '
        const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        process.stdout.write(JSON.stringify((d.mcpServers || {})[process.argv[2]]));
      ' "$src_cfg" "$name")"
      if ((DRY)); then
        echo "  would: register MCP '$name' in $(pretty_dir "$dst") (currently $state)"
        continue
      fi
      if [[ "$state" == "diff" ]]; then
        claude_in "$dst" mcp remove "$name" --scope user >/dev/null 2>&1 || true
      fi
      printf '%s' "$server_json" | claude_in "$dst" mcp add-json --scope user "$name" - >/dev/null
      echo "registered MCP '$name' in $(pretty_dir "$dst")"
    done
  done
}

sync_plugins() {
  local src_installed="$SRC_DIR/plugins/installed_plugins.json"
  local src_mkts="$SRC_DIR/plugins/known_marketplaces.json"
  command -v claude >/dev/null || { warn "claude CLI not found; skipping plugin sync"; return 0; }
  command -v node >/dev/null || { warn "node not found; skipping plugin sync"; return 0; }
  [[ -f "$src_installed" ]] || return 0

  local plugins=() pid mkt_name mkt_source
  while IFS=$'\t' read -r pid mkt_name mkt_source; do
    [[ -n "$pid" ]] || continue
    plugins+=("$pid"$'\t'"$mkt_name"$'\t'"$mkt_source")
  done < <(node -e '
    const fs = require("fs");
    const inst = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).plugins || {};
    const mkts = fs.existsSync(process.argv[2]) ? JSON.parse(fs.readFileSync(process.argv[2], "utf8")) : {};
    for (const [pid, entries] of Object.entries(inst)) {
      if (!Array.isArray(entries) || !entries.some(e => e && e.scope === "user")) continue;
      const mkt = pid.includes("@") ? pid.split("@").slice(1).join("@") : "";
      const srcObj = (mkts[mkt] || {}).source || {};
      const src = srcObj.repo || srcObj.url || "";
      console.log([pid, mkt, src].join("\t"));
    }
  ' "$src_installed" "$src_mkts" 2>/dev/null || true)

  ((${#plugins[@]})) || return 0

  local dst entry dst_inst dst_mkts already has_mkt
  for dst in "${TARGET_DIRS[@]}"; do
    dst_inst="$dst/plugins/installed_plugins.json"
    dst_mkts="$dst/plugins/known_marketplaces.json"
    for entry in "${plugins[@]}"; do
      IFS=$'\t' read -r pid mkt_name mkt_source <<<"$entry"
      already="$(node -e '
        const fs = require("fs");
        if (!fs.existsSync(process.argv[1])) process.exit(0);
        const inst = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).plugins || {};
        const arr = inst[process.argv[2]] || [];
        if (arr.some(e => e && e.scope === "user")) console.log("1");
      ' "$dst_inst" "$pid" 2>/dev/null || true)"
      [[ "$already" == "1" ]] && continue

      if [[ -n "$mkt_name" && -n "$mkt_source" ]]; then
        has_mkt="$(node -e '
          const fs = require("fs");
          if (!fs.existsSync(process.argv[1])) process.exit(0);
          const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          if (m[process.argv[2]]) console.log("1");
        ' "$dst_mkts" "$mkt_name" 2>/dev/null || true)"
        if [[ "$has_mkt" != "1" ]]; then
          if ((DRY)); then
            echo "  would: add marketplace '$mkt_source' in $(pretty_dir "$dst")"
          else
            claude_in "$dst" plugin marketplace add "$mkt_source" >/dev/null
            echo "added marketplace '$mkt_name' in $(pretty_dir "$dst")"
          fi
        fi
      fi
      if ((DRY)); then
        echo "  would: install plugin '$pid' (scope: user) in $(pretty_dir "$dst")"
      else
        claude_in "$dst" plugin install "$pid" --scope user >/dev/null
        echo "installed plugin '$pid' in $(pretty_dir "$dst")"
      fi
    done
  done
}

select_profiles

INTERACTIVE_MCP=0
if ((HAS_CATEGORY_FLAG == 0)); then
  if is_interactive; then
    {
      echo ""
      echo "Syncing from $(pretty_dir "$SRC_DIR") -> $(pretty_list "${TARGET_DIRS[@]}")"
    } >/dev/tty
    ask_yn "Sync skills (excluding org-scoped synced/)?" "y" && DO_SKILLS=1 || true
    ask_yn "Sync CLAUDE.md symlink?" "n" && DO_CLAUDE_MD=1 || true
    ask_yn "Sync settings.json / settings.local.json symlinks?" "n" && DO_SETTINGS=1 || true
    if ask_yn "Sync user-scope MCP servers (interactive selection)?" "n"; then
      DO_MCP=1
      INTERACTIVE_MCP=1
    fi
    ask_yn "Sync user-scope plugins?" "n" && DO_PLUGINS=1 || true
  else
    DO_SKILLS=1
  fi
fi

for dst in "${TARGET_DIRS[@]}"; do
  ((DO_SKILLS)) && sync_skills "$dst"
  ((DO_CLAUDE_MD)) && sync_claude_md "$dst"
  ((DO_SETTINGS)) && sync_settings "$dst"
done
((DO_MCP)) && sync_mcp "$INTERACTIVE_MCP"
((DO_PLUGINS)) && sync_plugins

echo "Sync complete ($(pretty_dir "$SRC_DIR") -> $(pretty_list "${TARGET_DIRS[@]}"))"
