#!/usr/bin/env bash
# Waits for the Vercel git deployments of one pushed commit to finish, with
# one blocking `vercel inspect --wait` per project instead of polling.
#
#   wait-deploy.sh [--project <name>]... [--timeout <time>] [commit]
#
# Run it from anywhere inside a git repo linked to Vercel. Without --project
# it waits on every project of the link: `.vercel/repo.json` (vercel link
# --repo, monorepos) or `.vercel/project.json`, looked up from the current
# folder up to the repo root. commit defaults to HEAD; timeout to 20m.
#
# Exit 0 when every deployment is READY or was skipped by an Ignored Build
# Step (CANCELED), 1 otherwise. A failed build prints the tail of its log.
set -uo pipefail

usage() { sed -n '4,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

projects=()
build_timeout=20m
rev=HEAD
while [ $# -gt 0 ]; do
  case "$1" in
    --project) projects+=("${2:?--project needs a name}"); shift 2 ;;
    --timeout) build_timeout="${2:?--timeout needs a value}"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "wait-deploy: unknown option $1" >&2; usage ;;
    *) rev="$1"; shift ;;
  esac
done

root=$(git rev-parse --show-toplevel) || exit 1
sha=$(git rev-parse --verify "$rev^{commit}") || exit 1

# The folder holding the Vercel link: vercel commands run there, so they
# pick up the team (orgId) and the project names resolve.
link_dir=""
dir="$PWD"
while :; do
  if [ -f "$dir/.vercel/repo.json" ] || [ -f "$dir/.vercel/project.json" ]; then
    link_dir="$dir"
    break
  fi
  [ "$dir" = "$root" ] || [ "$dir" = / ] && break
  dir=$(dirname "$dir")
done
if [ -z "$link_dir" ]; then
  echo "wait-deploy: no .vercel link between $PWD and $root (run vercel link)" >&2
  exit 1
fi
cd "$link_dir" || exit 1

if [ ${#projects[@]} -eq 0 ]; then
  if [ -f .vercel/repo.json ]; then
    while IFS= read -r name; do projects+=("$name"); done \
      < <(jq -r '.projects[].name' .vercel/repo.json)
  else
    name=$(jq -r '.projectName // empty' .vercel/project.json)
    projects+=("${name:-}")
  fi
fi

# Vercel creates the deployment a few seconds after the git provider's push
# webhook, so there is nothing to block on yet: look it up for up to 2m.
# An empty project name means the folder's linked project.
find_deployment() {
  local url
  for _ in $(seq 1 24); do
    url=$(vercel ls ${1:+"$1"} --meta "githubCommitSha=$sha" --format json 2>/dev/null \
      | jq -r '.deployments[0].url // empty')
    if [ -n "$url" ]; then
      echo "$url"
      return 0
    fi
    sleep 5
  done
  return 1
}

wait_project() {
  local label="${1:-linked project}" url state
  if ! url=$(find_deployment "$1"); then
    echo "$label: no deployment for ${sha:0:7} after 2m (pushed? branch built by Vercel?)"
    return 1
  fi
  state=$(vercel inspect "$url" --wait --timeout "$build_timeout" --json 2>/dev/null \
    | jq -r '.readyState // empty')
  case "$state" in
    READY) echo "$label: READY https://$url" ;;
    CANCELED) echo "$label: skipped (CANCELED) https://$url" ;;
    ERROR)
      echo "$label: ERROR https://$url"
      vercel inspect "$url" --logs 2>&1 | tail -n 40
      return 1
      ;;
    *)
      echo "$label: ${state:-unknown} after $build_timeout https://$url"
      return 1
      ;;
  esac
}

echo "wait-deploy: ${sha:0:7} in $link_dir"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

pids=()
for i in "${!projects[@]}"; do
  wait_project "${projects[$i]}" >"$tmp/$i" 2>&1 &
  pids+=("$!")
done

status=0
for i in "${!projects[@]}"; do
  wait "${pids[$i]}" || status=1
  cat "$tmp/$i"
done
exit "$status"
