# Sourced by install.sh: symlink helpers.
# The caller defines run (prints instead of acting in dry-run), warn, and BACKUP (a backup dir).
#
# ~/.agents/skills is the skills hub: Codex reads it natively and `npx skills` installs there.
# Every other host should resolve to it: Antigravity links its whole skills dir to the hub
# (link_skills_dir); Claude Code profiles link per entry (link_missing), because each profile keeps
# its own org-scoped skills/synced/ dir that must not be shared across accounts or hosts.

# link TARGET PATH: make PATH a symlink to TARGET, backing up whatever was there.
link() {
  local target="$1" path="$2"
  if [[ -L "$path" && "$(readlink "$path")" == "$target" ]]; then return 0; fi
  # Already the same file or dir through another link (e.g. a skill living in the hub itself).
  if [[ -e "$path" && "$path" -ef "$target" ]]; then return 0; fi
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

# skill_entries DIR: the skill dirs directly inside DIR (no dotfiles, no Claude's synced/).
skill_entries() {
  local e n
  for e in "$1"/*; do
    [[ -d "$e" ]] || continue
    n="$(basename "$e")"
    case "$n" in .*|synced) continue ;; esac
    printf '%s\n' "$e"
  done
}

# link_missing FROM_DIR TO_DIR [quiet]: link into TO_DIR every skill of FROM_DIR it lacks; never
# replace. A same-named skill that is a different dir is reported (unless quiet) and left alone.
link_missing() {
  local from="$1" to="$2" quiet="${3:-}" e n
  [[ -d "$from" ]] || return 0
  while IFS= read -r e; do
    n="$(basename "$e")"
    if [[ -e "$to/$n" ]]; then
      [[ "$to/$n" -ef "$e" || -n "$quiet" ]] || warn "skill '$n' differs between $from and $to: left as is"
    else
      [[ -L "$to/$n" ]] && run rm "$to/$n"   # broken link
      run mkdir -p "$to"
      run ln -s "$(cd "$e" && pwd -P)" "$to/$n"
      echo "linked $to/$n -> $(cd "$e" && pwd -P)"
    fi
  done < <(skill_entries "$from")
}

# link_skills_dir PATH HUB: make a host's whole skills dir PATH a link to HUB. Skills PATH held
# that HUB lacks are moved into HUB first, so every host gains them instead of losing them.
link_skills_dir() {
  local path="$1" hub="$2" e n
  [[ -d "$hub" ]] || run mkdir -p "$hub"
  if [[ -d "$path" && ! -L "$path" ]]; then
    while IFS= read -r e; do
      n="$(basename "$e")"
      if [[ -e "$hub/$n" ]]; then
        [[ "$hub/$n" -ef "$e" ]] || warn "skill '$n' in $path differs from $hub/$n: kept only in the backup"
      elif [[ -L "$e" ]]; then
        run ln -s "$(cd "$e" && pwd -P)" "$hub/$n"; echo "linked $hub/$n -> $(cd "$e" && pwd -P)"
      else
        run mv "$e" "$hub/$n"; echo "moved $e -> $hub/$n"
      fi
    done < <(skill_entries "$path")
  fi
  link "$hub" "$path"
}
