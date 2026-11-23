# Shared by the call-* launchers (sourced, not run): an OS-enforced write sandbox on macOS.
#
#   sandbox_writable_workspace DIR   prints DIR and, inside a git worktree, the repo's common .git
#                                    (so commits from a worktree work), one per line
#   sandbox_profile FILE ENTRY...    writes a sandbox-exec profile to FILE that denies every file
#                                    write except the ENTRYs, the user temp/cache dirs and the TTY.
#                                    An ENTRY is a directory (allowed with everything below it) or
#                                    "prefix:<path>" (every path that starts with <path>, e.g.
#                                    "prefix:$HOME/.claude" covers ~/.claude, ~/.claude-work and
#                                    ~/.claude.json).
#
# The agent inside runs with its own permission prompts off: headless agents cannot prompt, and
# the agents' own path rules only cover their file tools (shell redirection bypasses them), so the
# OS profile is the boundary.

sandbox_real_dir() { (cd "$1" 2>/dev/null && pwd -P); }

sandbox_tmp_dir() { local d; d="$(getconf DARWIN_USER_TEMP_DIR)"; printf '%s\n' "${d%/}"; }

sandbox_writable_workspace() {
  local dir="$1" common
  printf '%s\n' "$dir"
  if common="$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
    sandbox_real_dir "$common"
  fi
}

sandbox_profile() {
  local file="$1" cache entry p; shift
  cache="$(getconf DARWIN_USER_CACHE_DIR)"; cache="${cache%/}"
  {
    echo '(version 1)'
    echo '(allow default)'
    echo '(deny file-write*)'
    echo '(allow file-write*'
    for entry in "$(sandbox_tmp_dir)" "$cache" "$@"; do
      case "$entry" in
        prefix:*)
          p="${entry#prefix:}"
          p="$(printf '%s' "$p" | sed -E 's/[][\.*^$+?(){}|\\]/\\&/g; s/"/\\"/g')"
          printf '  (regex #"^%s")\n' "$p" ;;
        *) printf '  (subpath "%s")\n' "${entry//\"/\\\"}" ;;
      esac
    done
    echo '  (literal "/dev/null") (literal "/dev/tty") (literal "/dev/ptmx")'
    echo '  (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/"))'
  } >"$file"
}
