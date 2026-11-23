# Sourced by install.sh for --align-profiles / --align-mcp: copies what cannot be a shared link
# from one Claude Code profile (SRC) to the others. Needs lib/links.sh and lib/profiles.sh; the
# caller defines run, warn, DRY and INCLUDE_SECRETS.
#   align_settings SRC DST          settings.json / settings.local.json as links to SRC's
#   align_plugins SRC DST...        user-scope plugins (and their marketplaces) via `claude plugin`
#   align_mcp SRC DST...            user-scope MCP servers via `claude mcp add-json` over stdin, never
#                                   by editing .claude.json (it also holds each account's state).
#                                   Servers with env/headers may hold secrets: on a terminal you pick
#                                   which to copy; otherwise they are skipped unless INCLUDE_SECRETS=1.

align_settings() {
  local src="$1" dst="$2" f
  for f in settings.json settings.local.json; do
    [[ -e "$src/$f" ]] && link "$src/$f" "$dst/$f"
  done
  return 0
}

align_mcp() {
  local src="$1" src_cfg dst dst_cfg; shift
  command -v claude >/dev/null || { warn "claude CLI not found; skipping MCP alignment"; return 0; }
  command -v node >/dev/null || { warn "node not found; skipping MCP alignment"; return 0; }
  src_cfg="$(claude_cfg "$src")"
  [[ -f "$src_cfg" ]] || return 0

  local names=() flags=() name has_sec
  while IFS=$'\t' read -r name has_sec; do
    [[ -n "$name" ]] || continue
    names+=("$name"); flags+=("$has_sec")
  done < <(node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const [k, v] of Object.entries(d.mcpServers || {})) {
      const sec = (v && v.env && Object.keys(v.env).length) || (v && v.headers && Object.keys(v.headers).length);
      console.log(k + "\t" + (sec ? "1" : "0"));
    }
  ' "$src_cfg" 2>/dev/null || true)
  if ((${#names[@]} == 0)); then echo "no user-scope MCP servers in $(pretty_dir "$src")"; return 0; fi

  local chosen=() i ans tok bad
  if [[ -z "${CI:-}" ]] && ( : </dev/tty ) 2>/dev/null; then
    {
      echo "User-scope MCP servers in $(pretty_dir "$src"):"
      for ((i = 0; i < ${#names[@]}; i++)); do
        printf "  %d) %s%s\n" "$((i + 1))" "${names[$i]}" "$([[ "${flags[$i]}" == 1 ]] && echo ' [has env/headers — may contain secrets]')"
      done
    } >/dev/tty
    while true; do
      printf "Copy to the other profiles [all, none, or numbers e.g. 1 2] (default: none): " >/dev/tty
      IFS= read -r ans </dev/tty || break
      ans="$(printf '%s' "${ans//,/ }" | awk '{$1=$1; print}')"
      case "$ans" in
        ""|none|NONE|n|N) break ;;
        all|ALL|a|A|\*) chosen=("${names[@]}"); break ;;
      esac
      chosen=() bad=0
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
      if [[ "${flags[$i]}" == 1 && "$INCLUDE_SECRETS" == 0 ]]; then
        warn "skipping MCP '${names[$i]}' (defines env/headers; pass --include-secrets or run on a terminal)"
        continue
      fi
      chosen+=("${names[$i]}")
    done
  fi
  ((${#chosen[@]})) || return 0

  local server_json state
  for dst in "$@"; do
    dst_cfg="$(claude_cfg "$dst")"
    for name in "${chosen[@]}"; do
      state="$(node -e '
        const fs = require("fs");
        const canon = (v) => v && typeof v === "object" && !Array.isArray(v)
          ? Object.keys(v).sort().reduce((a, k) => (a[k] = canon(v[k]), a), {})
          : Array.isArray(v) ? v.map(canon) : v;
        const read = (f) => fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")).mcpServers || {})[process.argv[3]] : undefined;
        const src = read(process.argv[1]), dst = read(process.argv[2]);
        console.log(dst === undefined ? "missing" : JSON.stringify(canon(src)) === JSON.stringify(canon(dst)) ? "same" : "diff");
      ' "$src_cfg" "$dst_cfg" "$name" 2>/dev/null || echo missing)"
      [[ "$state" == same ]] && continue
      if ((DRY)); then echo "  would: register MCP '$name' in $(pretty_dir "$dst") (currently $state)"; continue; fi
      server_json="$(node -e '
        const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        process.stdout.write(JSON.stringify((d.mcpServers || {})[process.argv[2]]));
      ' "$src_cfg" "$name")"
      [[ "$state" == diff ]] && { profile_run claude "$dst" claude mcp remove "$name" --scope user >/dev/null 2>&1 || true; }
      printf '%s' "$server_json" | profile_run claude "$dst" claude mcp add-json --scope user "$name" - >/dev/null
      echo "registered MCP '$name' in $(pretty_dir "$dst")"
    done
  done
}

align_plugins() {
  local src="$1"; shift
  local src_installed="$src/plugins/installed_plugins.json" src_mkts="$src/plugins/known_marketplaces.json"
  command -v claude >/dev/null || { warn "claude CLI not found; skipping plugin alignment"; return 0; }
  command -v node >/dev/null || { warn "node not found; skipping plugin alignment"; return 0; }
  [[ -f "$src_installed" ]] || return 0

  local plugins=() pid mkt_name mkt_source
  while IFS=$'\t' read -r pid mkt_name mkt_source; do
    [[ -n "$pid" ]] && plugins+=("$pid"$'\t'"$mkt_name"$'\t'"$mkt_source")
  done < <(node -e '
    const fs = require("fs");
    const inst = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).plugins || {};
    const mkts = fs.existsSync(process.argv[2]) ? JSON.parse(fs.readFileSync(process.argv[2], "utf8")) : {};
    for (const [pid, entries] of Object.entries(inst)) {
      if (!Array.isArray(entries) || !entries.some(e => e && e.scope === "user")) continue;
      const mkt = pid.includes("@") ? pid.split("@").slice(1).join("@") : "";
      const s = (mkts[mkt] || {}).source || {};
      console.log([pid, mkt, s.repo || s.url || ""].join("\t"));
    }
  ' "$src_installed" "$src_mkts" 2>/dev/null || true)
  ((${#plugins[@]})) || return 0

  local dst entry has
  for dst in "$@"; do
    for entry in "${plugins[@]}"; do
      IFS=$'\t' read -r pid mkt_name mkt_source <<<"$entry"
      has="$(node -e '
        const fs = require("fs");
        if (!fs.existsSync(process.argv[1])) process.exit(0);
        const arr = (JSON.parse(fs.readFileSync(process.argv[1], "utf8")).plugins || {})[process.argv[2]] || [];
        if (arr.some(e => e && e.scope === "user")) console.log("1");
      ' "$dst/plugins/installed_plugins.json" "$pid" 2>/dev/null || true)"
      [[ "$has" == 1 ]] && continue
      if [[ -n "$mkt_name" && -n "$mkt_source" ]]; then
        has="$(node -e '
          const fs = require("fs");
          if (fs.existsSync(process.argv[1]) && JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]]) console.log("1");
        ' "$dst/plugins/known_marketplaces.json" "$mkt_name" 2>/dev/null || true)"
        if [[ "$has" != 1 ]]; then
          if ((DRY)); then echo "  would: add marketplace '$mkt_source' in $(pretty_dir "$dst")"
          else
            profile_run claude "$dst" claude plugin marketplace add "$mkt_source" >/dev/null
            echo "added marketplace '$mkt_name' in $(pretty_dir "$dst")"
          fi
        fi
      fi
      if ((DRY)); then echo "  would: install plugin '$pid' (scope: user) in $(pretty_dir "$dst")"
      else
        profile_run claude "$dst" claude plugin install "$pid" --scope user >/dev/null
        echo "installed plugin '$pid' in $(pretty_dir "$dst")"
      fi
    done
  done
}
