# Sourced by install.sh: finds the installations (profiles) of each agent CLI that supports more
# than one. A profile is a config dir chosen by an env var:
#   claude: CLAUDE_CONFIG_DIR (default ~/.claude, whose account file is ~/.claude.json)
#   codex:  CODEX_HOME        (default ~/.codex)
# Antigravity has a single ~/.gemini per user (accounts switch inside the app), so it has none.
# The caller defines warn.

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

profile_env() { case "$1" in claude) echo CLAUDE_CONFIG_DIR ;; codex) echo CODEX_HOME ;; esac; }
profile_default() { echo "$HOME/.$1"; }

# claude_cfg DIR: the profile's account file (~/.claude keeps it outside the dir).
claude_cfg() {
  if [[ "$1" == "$HOME/.claude" ]]; then echo "$HOME/.claude.json"; else echo "$1/.claude.json"; fi
}

# profile_run KIND DIR CMD...: run CMD against that profile (the default one with the env var unset).
profile_run() {
  local kind="$1" dir="$2" var; shift 2
  var="$(profile_env "$kind")"
  if [[ "$dir" == "$(profile_default "$kind")" ]]; then env -u "$var" "$@"; else env "$var=$dir" "$@"; fi
}

# profile_candidates KIND: the existing profile dirs, the default one first.
profile_candidates() {
  local kind="$1" d base markers
  case "$kind" in
    claude)
      if [[ -d "$HOME/.claude" || -f "$HOME/.claude.json" ]] || command -v claude >/dev/null; then echo "$HOME/.claude"; fi
      markers=".claude.json settings.json skills projects" ;;
    codex)
      if [[ -d "$HOME/.codex" ]] || command -v codex >/dev/null; then echo "$HOME/.codex"; fi
      markers="config.toml auth.json sessions" ;;
  esac
  for d in "$HOME/.$kind"-* "$HOME/.$kind"_* "$HOME/.config/$kind" "$HOME/.config/$kind"-* "$HOME/.config/$kind"_*; do
    [[ -d "$d" && ! -L "$d" ]] || continue
    base="$(basename "$d")"
    case "$base" in *backup*|*.bak*) continue ;; esac
    local m
    for m in $markers; do
      if [[ -e "$d/$m" ]]; then echo "$d"; break; fi
    done
  done
}

# profile_label KIND DIR: the signed-in account, when the profile says it (Claude only).
profile_label() {
  [[ "$1" == claude ]] || return 0
  local cfg; cfg="$(claude_cfg "$2")"
  [[ -f "$cfg" ]] && command -v python3 >/dev/null || return 0
  python3 -c '
import json, sys
try:
    a = json.load(open(sys.argv[1])).get("oauthAccount") or {}
    out = " — ".join(v for v in (a.get("emailAddress"), a.get("organizationName")) if v)
    if out: sys.stdout.write(out)
except Exception:
    pass
' "$cfg" 2>/dev/null || true
}

# select_profiles KIND [DIR...]: sets SELECTED to the profiles to install into. Explicit dirs win,
# then the env var, then the detected ones (asked on a terminal when there are several; otherwise
# the default one). Empty when the CLI is not installed.
select_profiles() {
  local kind="$1" var d i label answer tok bad; shift
  SELECTED=()
  if (($#)); then
    for d in "$@"; do add_selected "$d"; done
    return 0
  fi
  var="$(profile_env "$kind")"
  if [[ -n "${!var:-}" ]]; then add_selected "${!var}"; return 0; fi
  local detected=()
  while IFS= read -r d; do detected+=("$d"); done < <(profile_candidates "$kind")
  if ((${#detected[@]} <= 1)); then
    SELECTED=(${detected[@]+"${detected[@]}"})
    return 0
  fi
  if [[ -n "${CI:-}" ]] || ! ( : </dev/tty ) 2>/dev/null; then
    SELECTED=("${detected[0]}")
    warn "several $kind profiles found; using $(pretty_dir "${detected[0]}") (set $var or pass --$kind-dir)"
    return 0
  fi
  {
    echo "Several $kind profiles found:"
    for ((i = 0; i < ${#detected[@]}; i++)); do
      label="$(profile_label "$kind" "${detected[$i]}")"
      printf "  %d) %s%s\n" "$((i + 1))" "$(pretty_dir "${detected[$i]}")" "${label:+ ($label)}"
    done
  } >/dev/tty
  while true; do
    printf "Install into [all, or numbers e.g. 1 2] (default: all): " >/dev/tty
    if ! IFS= read -r answer </dev/tty; then SELECTED=("${detected[@]}"); return 0; fi
    answer="$(printf '%s' "${answer//,/ }" | awk '{$1=$1; print}')"
    case "$answer" in ""|all|ALL|a|A|\*) SELECTED=("${detected[@]}"); return 0 ;; esac
    SELECTED=() bad=0
    for tok in $answer; do
      if [[ "$tok" =~ ^[0-9]+$ ]] && ((tok >= 1 && tok <= ${#detected[@]})); then
        add_selected "${detected[$((tok - 1))]}"
      else
        bad=1; break
      fi
    done
    ((bad == 0 && ${#SELECTED[@]} > 0)) && return 0
    printf "Invalid choice '%s'. Enter 'all' or numbers between 1 and %d.\n" "$answer" "${#detected[@]}" >/dev/tty
  done
}

add_selected() {
  local d e; d="$(norm_dir "$1")"
  for e in ${SELECTED[@]+"${SELECTED[@]}"}; do [[ "$e" == "$d" ]] && return 0; done
  SELECTED+=("$d")
}
